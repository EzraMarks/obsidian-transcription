import he from "he";
import { Vault, App, TFile, Notice } from "obsidian";
import nunjucks from "nunjucks";
import { AutoWikilinkEngine } from "./engines/autoWikilinkEngine";
import { AudioTranscriptionEngine } from "./engines/audioTranscriptionEngine";
import { PipelineStep, PipelineInputSource, PipelineDefinition, BasePipelineStep } from "./pipelineDefinition";
import yaml from "yaml";
import { PromptModal } from "./promptModal";
import { TranscriptionSettings } from "./settings";
import { StatusBar } from "./status";
import { getFilesFromGlob } from "./vaultGlob";
import { UtilsEngine } from "./engines/utilsEngine";

export class PipelineEngine {
    private readonly audioTranscriptionEngine: AudioTranscriptionEngine;
    private readonly autoWikilinkEngine: AutoWikilinkEngine;
    private readonly utilsEngine: UtilsEngine;

    constructor(
        private readonly settings: TranscriptionSettings,
        private readonly vault: Vault,
        private readonly statusBar: StatusBar | null,
        private readonly app: App,
    ) {
        this.audioTranscriptionEngine = new AudioTranscriptionEngine(settings, vault, statusBar, app);
        this.autoWikilinkEngine = new AutoWikilinkEngine(settings, vault, statusBar, app);
        this.utilsEngine = new UtilsEngine(settings, vault, app);
    }

    async runPipeline(activeFile: TFile, inputFile: TFile): Promise<string> {
        const pipelineDefinition = await this.parsePipelineDefinition();
        if (!pipelineDefinition.steps?.length) {
            throw new Error("Pipeline has no steps.");
        }

        const context = await this.resolveContext(pipelineDefinition.inputs, activeFile);
        context["input_file"] = inputFile.path;
        const results: Record<string, string> = {};
        let lastSuccessfulStepName: string | undefined = undefined;

        for (const step of pipelineDefinition.steps) {
            const scopedContext = { ...context, ...results };
            const result = await this.executeStep(step, scopedContext);
            if (result !== undefined) {
                results[step.name] = result;
                lastSuccessfulStepName = step.name;
            }
        }

        if (!lastSuccessfulStepName) {
            throw new Error("No steps in the pipeline produced a result.");
        }

        return results[lastSuccessfulStepName];
    }

    private async resolveContext(
        additionalInputs: PipelineInputSource[] | undefined,
        activeFile: TFile,
    ): Promise<Record<string, string>> {
        const context: Record<string, string> = {};
        if (!additionalInputs) return context;

        for (const input of additionalInputs) {
            if (input.type === "file_content") {
                const file = this.app.vault.getFileByPath(input.file);
                if (!file) throw new Error(`File not found at path: ${input.file}`);
                context[input.name] = await this.vault.read(file);
            } else if (input.type === "file_list") {
                const folder = this.app.vault.getFolderByPath(input.folder);
                if (!folder) throw new Error(`Folder not found at path: ${input.folder}`);

                context[input.name] = folder.children
                    .filter((f): f is TFile => f instanceof TFile)
                    .map((f) => {
                        const frontmatter = this.app.metadataCache.getFileCache(f)?.frontmatter;
                        const included: Record<string, string> = {};

                        if (frontmatter && Array.isArray(input.frontmatterProperties)) {
                            for (const key of input.frontmatterProperties) {
                                if (frontmatter[key] !== undefined) {
                                    included[key] = frontmatter[key];
                                }
                            }
                        }

                        return JSON.stringify({
                            name: f.basename,
                            linkText: this.app.metadataCache.fileToLinktext(f, activeFile.path, true),
                            ...included,
                        });
                    })
                    .toString();
            }
        }

        return context;
    }

    private async executeStep(step: PipelineStep, context: Record<string, string>): Promise<string | undefined> {
        // TODO: Debug the "if" condition - seems to not work properly
        if (step.if) {
            const conditionResult = this.renderTemplatedString(step.if, context);
            if (conditionResult !== "true") return undefined;
        }

        switch (step.type) {
            case "audio_transcription": {
                const renderedFilePath = this.renderTemplatedString(step.file, context);
                const audioFile = this.utilsEngine.getFileOrThrow(renderedFilePath);
                return this.audioTranscriptionEngine.transcribe(audioFile);
            }

            case "llm": {
                const messages = step.prompt.map((p) => ({
                    role: p.role,
                    content: he.decode(nunjucks.renderString(p.content, context)),
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
                return json.choices[0].message.content.trim();
            }

            case "human": {
                const renderedPrompt = he.decode(nunjucks.renderString(step.prompt, context));
                new Notice(renderedPrompt);
                return await this.waitForUserResponse(renderedPrompt);
            }

            case "templating": {
                return he.decode(nunjucks.renderString(step.template, context));
            }

            case "auto_wikilink": {
                const files = step.files.flatMap((fileGlob) => getFilesFromGlob(this.vault, fileGlob));
                const input = he.decode(nunjucks.renderString(step.input, context));
                return await this.autoWikilinkEngine.applyAutoWikilink(input, files);
            }

            default:
                throw new Error(`Unknown step type: ${(step as BasePipelineStep).type}`);
        }
    }

    private renderTemplatedString(templatedString: string, context: object) {
        return he.decode(nunjucks.renderString(templatedString, context));
    }

    private async parsePipelineDefinition(): Promise<PipelineDefinition> {
        const { pipelineDefinitionPath } = this.settings;
        const promptChainFile = this.app.vault.getFileByPath(pipelineDefinitionPath);

        if (!promptChainFile) {
            throw new Error(`Prompt chain file not found at path: ${pipelineDefinitionPath}`);
        }

        try {
            const content = await this.app.vault.read(promptChainFile);
            return this.parsePromptChainSpecFile(content);
        } catch (error) {
            console.error("Error while reading or parsing the prompt chain file:", error);
            throw new Error("Failed to parse prompt chain settings");
        }
    }

    private async waitForUserResponse(prompt: string): Promise<string> {
        return new Promise((resolve) => {
            new PromptModal(this.app, prompt, resolve).open();
        });
    }

    private parsePromptChainSpecFile(fullText: string): PipelineDefinition {
        // Strip frontmatter
        const withoutFrontmatter = fullText.replace(/^---[\s\S]*?---/, "").trim();
        // Extract content inside ```yaml code block
        const match = withoutFrontmatter.match(/```yaml([\s\S]*?)```/);
        if (!match) {
            throw new Error("YAML code block not found");
        }

        const yamlContent = match[1].trim();
        const parsed = yaml.parse(yamlContent);
        return parsed;
    }
}
