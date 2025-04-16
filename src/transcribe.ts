import { TranscriptionSettings, /*SWIFTINK_AUTH_CALLBACK*/  DEFAULT_SETTINGS } from "src/settings";
import { Notice, requestUrl, RequestUrlParam, TFile, Vault, App } from "obsidian";
import { StatusBar } from "./status";
import { parsePromptChainSpecFile, PromptChainSpec } from "./promptChainUtils";

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

        // Read the file content
        const fileContent = await this.vault.readBinary(file);

        // Create FormData
        const formData = new FormData();
        formData.append("file", new Blob([fileContent]), file.name);
        formData.append("model", "whisper-1");

        // Prepare headers
        const headers = {
            Authorization: `Bearer ${openaiKey}`,
        };

        try {
            // Make the POST request using fetch
            const response = await fetch(WHISPER_API_URL, {
                method: "POST",
                headers: headers,
                body: formData,
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const jsonResponse = await response.json();
            const textResponse = jsonResponse.text;

            if (this.settings.debug) {
                console.log(`Raw transcription: ${textResponse}`);
            }

            const textAfterFindAndReplace = this.applyFindAndReplace(textResponse);

            // Return the transcribed text
            return this.postProcessTranscription(textAfterFindAndReplace);
        } catch (error) {
            console.error("Error with URL:", WHISPER_API_URL, error);
            throw new Error("Failed to transcribe audio");
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

    getPromptChainSpec(): Promise<PromptChainSpec> {
        const { promptChainSpecPath } = this.settings;
        const promptChainFile = this.app.vault.getFileByPath(promptChainSpecPath);
        if (!promptChainFile) {
            throw new Error(`Prompt chain file not found at path: ${promptChainSpecPath}`);
        }

        return this.app.vault.read(promptChainFile).then((content) => {
            try {
                return parsePromptChainSpecFile(content);
            } catch (error) {
                throw new Error("Failed to parse prompt chain settings");
            }
        });

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
}
