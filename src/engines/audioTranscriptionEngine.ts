import { TranscriptionSettings } from "src/settings";
import { TFile, Vault, App } from "obsidian";
import { StatusBar } from "../status";
import { AutoWikilinkEngine } from "./autoWikilinkEngine";

export class AudioTranscriptionEngine {
    private readonly autoWikilinkEngine: AutoWikilinkEngine;

    constructor(
        private readonly settings: TranscriptionSettings,
        private readonly vault: Vault,
        private readonly statusBar: StatusBar | null,
        private readonly app: App,
    ) {
        this.autoWikilinkEngine = new AutoWikilinkEngine(settings, vault, statusBar, app);
    }

    async transcribe(file: TFile): Promise<string> {
        const { openaiKey } = this.settings;
        const fileContent = await this.vault.readBinary(file);

        const formData = new FormData();
        formData.append("file", new Blob([fileContent]), file.name);
        formData.append("model", "whisper-1");

        const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
            method: "POST",
            headers: { Authorization: `Bearer ${openaiKey}` },
            body: formData,
        });

        if (!response.ok) {
            throw new Error(`Whisper API error: ${response.status}`);
        }

        const { text } = await response.json();
        return text;
    }
}
