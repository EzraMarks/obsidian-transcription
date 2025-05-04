import { App, requestUrl, TFile, Vault } from "obsidian";
import { TranscriptionSettings } from "src/settings";

export class UtilsEngine {
    constructor(
        private readonly settings: TranscriptionSettings,
        private readonly vault: Vault,
        private readonly app: App,
    ) {}

    /**
     * For a given sourcePath, returns the timestamp (ms since epoch)
     * of `date_modified` frontmatter if present, otherwise file.stat.mtime.
     */
    getSourceFileTime(sourcePath: string): number {
        const sourceFile = this.getFileOrThrow(sourcePath);
        const frontmatter = this.app.metadataCache.getFileCache(sourceFile)?.frontmatter;
        const dateModified = frontmatter?.["date_modified"];
        const mtime = dateModified ? new Date(dateModified).getTime() : sourceFile.stat.mtime;

        return mtime;
    }

    getFileOrThrow(sourcePath: string): TFile {
        const sourceFile = this.vault.getFileByPath(sourcePath);
        if (!sourceFile) throw new Error(`Source file not found for path: ${sourcePath}`);
        return sourceFile;
    }

    readonly defaultOpenAiModel = "gpt-4.1"; // TODO: Put in settings

    /** Calls OpenAI chat completions with given input JSON */
    async callOpenAI(params: {
        systemPrompt: string;
        userPrompt: string;
        temperature?: number;
        responseFormat?: object;
        model?: string;
    }): Promise<string> {
        const { systemPrompt, userPrompt, temperature, responseFormat, model } = params;

        const messages = [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
        ];
        const payload = {
            model: model ?? this.defaultOpenAiModel,
            messages,
            temperature,
            response_format: responseFormat,
        };
        const response = await requestUrl({
            url: "https://api.openai.com/v1/chat/completions",
            method: "POST",
            headers: {
                Authorization: `Bearer ${this.settings.openaiKey}`,
                "Content-Type": "application/json",
            },
            contentType: "application/json",
            body: JSON.stringify(payload),
        });

        return response.json.choices[0].message.content.trim();
    }
}
