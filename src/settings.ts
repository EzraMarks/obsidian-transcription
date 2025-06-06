import { App, PluginSettingTab, Setting } from "obsidian";
import { Transcription } from "./main";

interface TranscriptionSettings {
    debug: boolean;
    verbosity: number;
    openaiKey: string;
    pipelineDefinitionPath: string;
    openaiCustomModel: string;
}

const DEFAULT_SETTINGS: TranscriptionSettings = {
    debug: false,
    verbosity: 1,
    openaiKey: "",
    pipelineDefinitionPath: "",
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

        new Setting(containerEl).setName("OpenAI Settings").setClass("openai-settings").setHeading();

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
            .setName("Pipeline Definition")
            .setDesc("Obsidian file containing the pipeline definition")
            .setClass("openai-settings")
            .addText((text) =>
                text
                    .setPlaceholder(DEFAULT_SETTINGS.pipelineDefinitionPath)
                    .setValue(this.plugin.settings.pipelineDefinitionPath)
                    .onChange(async (value) => {
                        this.plugin.settings.pipelineDefinitionPath = value;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl).setName("Advanced Settings").setHeading();

        new Setting(containerEl)
            .setName("Debug mode")
            .setDesc("Enable debug mode to see more console logs")
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.debug).onChange(async (value) => {
                    this.plugin.settings.debug = value;
                    await this.plugin.saveSettings();
                }),
            );
    }

    /**
     * Update the visibility of settings based on the current settings.
     */
    updateSettingVisibility(classSelector: string, visible: boolean) {
        const { containerEl } = this;
        containerEl.findAll(classSelector).forEach((element) => {
            element.style.display = visible ? "block" : "none";
        });
    }
}

export type { TranscriptionSettings };
export { DEFAULT_SETTINGS, TranscriptionSettingTab };
