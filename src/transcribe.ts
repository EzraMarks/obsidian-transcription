import { TranscriptionSettings, /*SWIFTINK_AUTH_CALLBACK*/ DEFAULT_SETTINGS } from "src/settings";
import { Notice, requestUrl, RequestUrlParam, TFile, Vault, App, TFolder, TAbstractFile } from "obsidian";
import { StatusBar } from "./status";
import { parsePromptChainSpecFile, PromptChainSpec } from "./promptChainUtils";
import { PromptModal } from "./promptModal";
import nunjucks from "nunjucks";
import he from "he";

const MAX_TRIES = 100;

export class TranscriptionEngine {
    settings: TranscriptionSettings;
    vault: Vault;
    statusBar: StatusBar | null;
    app: App;

    constructor(settings: TranscriptionSettings, vault: Vault, statusBar: StatusBar | null, app: App) {
        this.settings = settings;
        this.vault = vault;
        this.statusBar = statusBar;
        this.app = app;
    }

    async getTranscription(file: TFile): Promise<string> {
        const start = new Date();
        return this.getTranscriptionOpenAI(file).then((transcription) => {
            if (this.settings.debug) console.log(`Transcription: ${transcription}`);
            if (this.settings.debug) console.log(`Transcription took ${new Date().getTime() - start.getTime()} ms`);
            return transcription;
        });
    }

    async getTranscriptionOpenAI(file: TFile): Promise<string> {
        const WHISPER_API_URL = "https://api.openai.com/v1/audio/transcriptions";
        const { openaiKey } = this.settings;

        const fileContent = await this.vault.readBinary(file);

        const formData = new FormData();
        formData.append("file", new Blob([fileContent]), file.name);
        formData.append("model", "whisper-1");

        try {
            const response = await fetch(WHISPER_API_URL, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${openaiKey}`,
                },
                body: formData,
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const jsonResponse = await response.json();
            const transcription = jsonResponse.text;

            if (this.settings.debug) {
                console.log(`Raw transcription: ${transcription}`);
            }

            const cleaned = this.applyFindAndReplace(transcription);
            const postProcessed = this.postProcessTranscription(cleaned);

            // Execute the LLM prompt chain using the final transcription
            return await this.runPromptChain(await postProcessed, file);
        } catch (error) {
            console.error("Error with Whisper transcription:", error);
            throw error;
        }
    }

    applyFindAndReplace(transcription: string): string {
        const findAndReplaceMap = this.getFindAndReplaceMap();
        let modifiedText = transcription;

        // Loop through each find-and-replace pair in the map
        for (const [find, replace] of Object.entries(findAndReplaceMap)) {
            // Use word boundaries (\b) to ensure we only match whole words
            const regex = new RegExp(`\\b${this.escapeRegExp(find)}\\b`, "g");
            modifiedText = modifiedText.replace(regex, replace);
        }

        return modifiedText;
    }

    escapeRegExp(str: string): string {
        return str.replace(/[.*+?^=!:${}()|\[\]\/\\]/g, "\\$&"); // Escape special characters for RegExp
    }

    getFindAndReplaceMap(): { [key: string]: string } {
        const { findAndReplace } = this.settings;

        const lines = findAndReplace.split("\n"); // Split input by newlines
        const result: { [key: string]: string } = {};

        for (const line of lines) {
            const trimmedLine = line.trim();
            if (trimmedLine) {
                const [key, value] = trimmedLine.split(":").map((part) => part.trim());
                if (key && value) {
                    result[key] = value;
                } else {
                    console.warn(`Skipping invalid line: ${line}`);
                }
            }
        }

        return result;
    }

    async getPromptChainSpec(): Promise<PromptChainSpec> {
        const { promptChainSpecPath } = this.settings;
        const promptChainFile = this.app.vault.getFileByPath(promptChainSpecPath);
        if (!promptChainFile) {
            throw new Error(`Prompt chain file not found at path: ${promptChainSpecPath}`);
        }

        try {
            const content = await this.app.vault.read(promptChainFile);
            return parsePromptChainSpecFile(content);
        } catch (error) {
            console.error("Error while reading or parsing the prompt chain file:", error);
            throw new Error("Failed to parse prompt chain settings");
        }
    }

    async postProcessTranscription(transcription: string): Promise<string> {
        const CHATGPT_API_URL = "https://api.openai.com/v1/chat/completions";

        const { openaiKey, postProcessingSystemPrompt, postProcessingUserPrompt, openaiModel, openaiCustomModel } =
            this.settings;

        const userMessageContent = postProcessingUserPrompt
            ? postProcessingUserPrompt + "\n\n" + transcription
            : transcription;

        // Create the request payload
        const payload = {
            model: openaiModel === "custom" ? openaiCustomModel : openaiModel,
            messages: [
                ...(postProcessingSystemPrompt ? [{ role: "system", content: postProcessingSystemPrompt }] : []),
                { role: "user", content: userMessageContent },
            ],
        };

        // Prepare headers
        const headers = {
            Authorization: `Bearer ${openaiKey}`,
            "Content-Type": "application/json",
        };

        try {
            // Make the POST request using fetch
            const response = await fetch(CHATGPT_API_URL, {
                method: "POST",
                headers: headers,
                body: JSON.stringify(payload),
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const jsonResponse = await response.json();

            // Return the ChatGPT response text
            return jsonResponse.choices[0].message.content;
        } catch (error) {
            console.error("Error with URL:", CHATGPT_API_URL, error);
            throw new Error("Failed to get response from ChatGPT");
        }
    }

    async runPromptChain(input: string, activeFile: TFile): Promise<string> {
        const spec = await this.getPromptChainSpec();

        // Step 1: resolve context
        const context: Record<string, any> = {
            input,
        };

        for (const item of spec.additional_inputs) {
            if (item.type === "file_content") {
                const file = this.app.vault.getFileByPath(item.path);
                if (!file) throw new Error(`File not found at path: ${item.path}`);
                context[item.name] = await this.vault.read(file);
            } else if (item.type === "file_list") {
                const folder = this.app.vault.getFolderByPath(item.path);

                if (!folder) throw new Error(`Folder not found at path: ${item.path}`);
                context[item.name] = folder.children
                    .filter((f): f is TFile => f instanceof TFile)
                    .map((f) => {
                        const frontmatter = this.app.metadataCache.getFileCache(f)?.frontmatter;
                        const includedFrontmatter: Record<string, string> = {};

                        if (frontmatter && Array.isArray(item.frontmatterProperties)) {
                            for (const key of item.frontmatterProperties) {
                                if (frontmatter[key] !== undefined) {
                                    includedFrontmatter[key] = frontmatter[key];
                                }
                            }
                        }

                        return JSON.stringify({
                            name: f.basename,
                            linkText: this.app.metadataCache.fileToLinktext(f, activeFile.path, true),
                            ...includedFrontmatter,
                        });
                    });
            }
        }

        // Step 2: execute chain
        const results: Record<string, any> = {};

        for (const step of spec.steps) {
            // Build a scoped context with prior results
            const scopedContext = { ...context };
            for (const [id, result] of Object.entries(results)) {
                scopedContext[id] = result;
            }

            // Evaluate the condition if provided
            if (step.if) {
                const conditionResult = nunjucks.renderString(step.if, scopedContext);
                if (conditionResult !== "true") continue;
            }

            if (step.type === "llm") {
                const messages = step.prompt.map((p) => ({
                    role: p.role,
                    content: nunjucks.renderString(p.content, scopedContext),
                }));

                const payload = {
                    model: step.model.name,
                    temperature: step.model.temperature,
                    messages,
                };

                const response = await fetch("https://api.openai.com/v1/chat/completions", {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${this.settings.openaiKey}`,
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify(payload),
                });

                const json = await response.json();
                results[step.name] = json.choices[0].message.content.trim();
            }

            if (step.type === "human") {
                const renderedPrompt = nunjucks.renderString(step.prompt, scopedContext);
                new Notice(renderedPrompt); // Or however you'd like to show it to the user

                const userResponse = await this.waitForUserResponse(renderedPrompt); // You’d implement this
                results[step.name] = userResponse;
            }

            if (step.type === "templating") {
                const renderedTemplate = nunjucks.renderString(step.template, scopedContext);
                results[step.name] = renderedTemplate;
            }
        }

        const finalResult = results[spec.steps[spec.steps.length - 1].name];
        return he.decode(finalResult);
    }

    async waitForUserResponse(prompt: string): Promise<string> {
        return new Promise((resolve) => {
            new PromptModal(this.app, prompt, resolve).open();
        });
    }
}
