import { AbstractInputSuggest, App, PluginSettingTab, Setting, TFolder } from "obsidian";
import { Transcription } from "./main";

class FolderSuggest extends AbstractInputSuggest<TFolder> {
    private callback: (folderPath: string) => void;

    constructor(app: App, inputEl: HTMLInputElement, onSelect: (folderPath: string) => void) {
        super(app, inputEl);
        this.callback = onSelect;
    }

    getSuggestions(query: string): TFolder[] {
        return this.app.vault
            .getAllFolders(true)
            .filter((f) => f.path.toLowerCase().includes(query.toLowerCase()));
    }

    renderSuggestion(folder: TFolder, el: HTMLElement): void {
        el.setText(folder.path);
    }

    selectSuggestion(folder: TFolder): void {
        this.setValue(folder.path);
        this.close();
        this.callback(folder.path);
    }
}

interface TranscriptionSettings {
    debug: boolean;
    verbosity: number;
    openaiKey: string;
    pipelineDefinitionsFolder: string;
    lastModifiedFrontmatterField: string;
}

const DEFAULT_SETTINGS: TranscriptionSettings = {
    debug: false,
    verbosity: 1,
    openaiKey: "",
    pipelineDefinitionsFolder: "",
    lastModifiedFrontmatterField: "",
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
            .setName("Pipeline Definitions Folder")
            .setDesc("Vault folder containing pipeline definition .md files")
            .setClass("openai-settings")
            .addText((text) => {
                text.setPlaceholder("e.g. Pipelines")
                    .setValue(this.plugin.settings.pipelineDefinitionsFolder);
                new FolderSuggest(this.app, text.inputEl, async (folderPath) => {
                    this.plugin.settings.pipelineDefinitionsFolder = folderPath;
                    await this.plugin.saveSettings();
                });
                text.onChange(async (value) => {
                    this.plugin.settings.pipelineDefinitionsFolder = value;
                    await this.plugin.saveSettings();
                });
            });

        new Setting(containerEl)
            .setName("Last modified frontmatter field")
            .setDesc(
                "Frontmatter field name used as 'date last modified' when matching entities (e.g. 'date_modified'). Falls back to the file's actual modification time if not set or if the value is not a valid date.",
            )
            .addText((text) =>
                text
                    .setPlaceholder("e.g. date_modified")
                    .setValue(this.plugin.settings.lastModifiedFrontmatterField)
                    .onChange(async (value) => {
                        this.plugin.settings.lastModifiedFrontmatterField = value.trim();
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
