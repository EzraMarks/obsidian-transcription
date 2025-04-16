import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import { Transcription } from "./main";

interface TranscriptionSettings {
    debug: boolean;
    verbosity: number;
    openaiKey: string;
    findAndReplace: string; // Colon-delimited format, with newlines separating pairs of words. E.g. "Maddie: Maddy\nRhea: Riya"
    postProcessingSystemPrompt: string;
    postProcessingUserPrompt: string;
    promptChainSpecPath: string;
    openaiModel: string;
    openaiCustomModel: string;
}

const DEFAULT_SETTINGS: TranscriptionSettings = {
    debug: false,
    verbosity: 1,
    openaiKey: "",
    findAndReplace: "",
    postProcessingSystemPrompt: "",
    postProcessingUserPrompt: "",
    promptChainSpecPath: "",
    openaiModel: "",
    openaiCustomModel: "",
};

class TranscriptionSettingTab extends PluginSettingTab {
    plugin: Transcription;

    constructor(app: App, plugin: Transcription) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;

        containerEl.empty();

        containerEl.createEl("h2", {
            text: "Settings for Obsidian Transcription",
        });

        new Setting(containerEl).setName("General Settings").setHeading();

        new Setting(containerEl)
            .setName("Notice verbosity")
            .setDesc("How granularly notices should be displayed")
            .setTooltip(
                "Verbose will display a notice for every event in the backend. Normal will display a notice for every major event, such as successful transcription or file upload. Silent will not display any notices.",
            )
            .addDropdown((dropdown) =>
                dropdown
                    .addOption("0", "Silent")
                    .addOption("1", "Normal")
                    .addOption("2", "Verbose")
                    .setValue(this.plugin.settings.verbosity.toString())
                    .onChange(async (value) => {
                        this.plugin.settings.verbosity = parseInt(value);
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
        .setName("OpenAI Settings")
        .setClass("openai-settings")
        .setHeading();

        new Setting(containerEl)
        .setName("OpenAI key")
        .setClass("openai-settings")
        .addText((text) =>
            text
                .setPlaceholder(DEFAULT_SETTINGS.openaiKey)
                .setValue(this.plugin.settings.openaiKey)
                .onChange(async (value) => {
                    this.plugin.settings.openaiKey = value;
                    await this.plugin.saveSettings();
                }),
        );

        new Setting(containerEl)
        .setName("Prompt chain specification")
        .setDesc("Obsidian file containing the prompt chain specification")
        .setClass("openai-settings")
        .addText((text) =>
            text
            .setPlaceholder(DEFAULT_SETTINGS.promptChainSpecPath)
            .setValue(this.plugin.settings.promptChainSpecPath)
            .onChange(async (value) => {
                this.plugin.settings.promptChainSpecPath = value;
                await this.plugin.saveSettings();
            }),
        );

        new Setting(containerEl)
        .setName("Post-processing system prompt")
        .setDesc("The OpenAI system prompt")
        .setClass("openai-settings")
        .addTextArea((text) =>
            text
                .setPlaceholder(DEFAULT_SETTINGS.postProcessingSystemPrompt)
                .setValue(this.plugin.settings.postProcessingSystemPrompt)
                .onChange(async (value) => {
                    this.plugin.settings.postProcessingSystemPrompt = value;
                    await this.plugin.saveSettings();
                }),
        );

        new Setting(containerEl)
        .setName("Post-processing user prompt")
        .setDesc("The OpenAI user prompt. The journal contents will be appended after the user prompt.")
        .setClass("openai-settings")
        .addTextArea((text) =>
            text
                .setPlaceholder("Here is my journal entry. Please clean it up:")
                .setValue(this.plugin.settings.postProcessingUserPrompt)
                .onChange(async (value) => {
                    this.plugin.settings.postProcessingUserPrompt = value;
                    await this.plugin.saveSettings();
                }),
        );

        new Setting(containerEl)
        .setName("Find and Replace")
        .setDesc("A colon-delimited list of words or phrases to automatically find and replace (case-sensitive). Each line should be of the format 'OldWord: NewWord' without quotation marks, with each pair separated by a newline.")
        .setClass("openai-settings")
        .addTextArea((text) =>
            text
                .setPlaceholder("Maddie: Maddy\nRhea: Riya")
                .setValue(this.plugin.settings.findAndReplace)
                .onChange(async (value) => {
                    this.plugin.settings.findAndReplace = value;
                    await this.plugin.saveSettings();
                }),
        );

        new Setting(containerEl)
        .setName("Model")
        .setDesc("The OpenAI language model to use")
        .setClass("openai-settings")
        .addDropdown((dropdown) =>
            dropdown
                .addOption("gpt-3.5-turbo", "GPT-3.5 Turbo")
                .addOption("gpt-4o", "GPT-4o")
                .addOption("custom", "Custom")
                .setValue(this.plugin.settings.openaiModel)
                .onChange(async (value) => {
                    this.plugin.settings.openaiModel = value;
                    await this.plugin.saveSettings();
                    this.updateSettingVisibility(".openai-settings-custom-model", value === "custom");
                }),
        );
        
        new Setting(containerEl)
        .setName("Custom Model")
        .setDesc("Custom OpenAI language model to use")
        .setClass("openai-settings-custom-model")
        .addText((text) =>
            text
                .setPlaceholder(DEFAULT_SETTINGS.openaiCustomModel)
                .setValue(this.plugin.settings.openaiCustomModel)
                .onChange(async (value) => {
                    this.plugin.settings.openaiCustomModel = value;
                    await this.plugin.saveSettings();
                }),
        );

        new Setting(containerEl).setName("Advanced Settings").setHeading();

        new Setting(containerEl)
            .setName("Debug mode")
            .setDesc("Enable debug mode to see more console logs")
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.debug)
                    .onChange(async (value) => {
                        this.plugin.settings.debug = value;
                        await this.plugin.saveSettings();
                    }),
            );

        this.updateSettingVisibility(".openai-settings-custom-model", this.plugin.settings.openaiModel === "custom");
    }


    /**
     * Update the visibility of settings based on the current settings.
     */
    updateSettingVisibility (classSelector: string, visible: boolean) {
        const { containerEl } = this;
        containerEl
            .findAll(classSelector)
            .forEach((element) => {
                element.style.display = visible ? "block" : "none";
            });
    }
}

export type { TranscriptionSettings };
export {
    DEFAULT_SETTINGS,
    TranscriptionSettingTab,
};
