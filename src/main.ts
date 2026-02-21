import { ChildProcess } from "child_process";
import {
    Editor,
    MarkdownView,
    Plugin,
    TFile,
    Notice,
    Platform,
    App,
    Menu,
} from "obsidian";
import { StatusBar } from "./status";
import { TranscriptionSettings, DEFAULT_SETTINGS, TranscriptionSettingTab } from "./settings";
import { PipelineEngine } from "./pipelineEngine";
import { UserCancelledError } from "./engines/autoWikilinkEngine";
import { TranscriptionModal } from "./transcriptionModal";

export default class Transcription extends Plugin {
    settings: TranscriptionSettings;
    statusBar: StatusBar;

    public static plugin: Plugin;
    public static children: Array<ChildProcess> = [];
    public pipelineEngine: PipelineEngine;

    private ongoingTranscriptionTasks: Array<{
        task: Promise<void>;
        abortController: AbortController;
    }> = [];
    public static transcribeFileExtensions: string[] = [
        "mp3",
        "wav",
        "webm",
        "ogg",
        "flac",
        "m4a",
        "aac",
        "amr",
        "opus",
        "aiff",
        "m3gp",
        "mp4",
        "m4v",
        "mov",
        "avi",
        "wmv",
        "flv",
        "mpeg",
        "mpg",
        "mkv",
    ];

    public getTranscribeableFiles = async (file: TFile) => {
        // Get all linked files in the markdown file
        const filesLinked = Object.keys(this.app.metadataCache.resolvedLinks[file.path]);

        // Now that we have all the files linked in the markdown file, we need to filter them by the file extensions we want to transcribe
        const filesToTranscribe: TFile[] = [];
        for (const linkedFilePath of filesLinked) {
            const linkedFileExtension = linkedFilePath.split(".").pop();
            if (
                linkedFileExtension === undefined ||
                !Transcription.transcribeFileExtensions.includes(linkedFileExtension.toLowerCase())
            ) {
                if (this.settings.debug)
                    console.log(
                        "Skipping " +
                            linkedFilePath +
                            " because the file extension is not in the list of transcribeable file extensions",
                    );
                continue;
            }

            // We now know that the file extension is in the list of transcribeable file extensions
            const linkedFile = this.app.vault.getAbstractFileByPath(linkedFilePath);

            // Validate that we are dealing with a file and add it to the list of verified files to transcribe
            if (linkedFile instanceof TFile) filesToTranscribe.push(linkedFile);
            else {
                if (this.settings.debug) console.log("Could not find file " + linkedFilePath);
                continue;
            }
        }
        return filesToTranscribe;
    };

    private openTranscriptionModal(
        files: TFile[],
        onConfirm: (files: TFile[], pipeline: TFile) => void,
    ): void {
        const pipelineFiles = this.pipelineEngine.getPipelineFiles();
        if (pipelineFiles.length === 0) {
            new Notice("No pipeline definitions found. Set Pipeline Definitions Folder in settings.");
            return;
        }
        new TranscriptionModal(this.app, files, pipelineFiles, onConfirm).open();
    }

    public async transcribeAndWrite(parent_file: TFile, file: TFile, pipelineFile: TFile, abortController: AbortController | null) {
        try {
            if (this.settings.debug) console.log("Transcribing " + file.path);

            const transcription = await this.pipelineEngine.runPipeline(parent_file, file, pipelineFile);

            let fileText = await this.app.vault.read(parent_file);
            const fileLinkString = this.app.metadataCache.fileToLinktext(file, parent_file.path);
            const fileLinkStringTagged = `[[${fileLinkString}]]`;

            const startReplacementIndex = fileText.indexOf(fileLinkStringTagged) + fileLinkStringTagged.length;

            fileText = [
                fileText.slice(0, startReplacementIndex),
                `\n${transcription}`,
                fileText.slice(startReplacementIndex),
            ].join("");

            //check if abortion signal is aborted

            if (abortController?.signal?.aborted) {
                new Notice(`Transcription of ${file.name} cancelled!`);
                return;
            }

            await this.app.vault.modify(parent_file, fileText);
        } catch (error) {
            if (error instanceof UserCancelledError) {
                new Notice("Transcription cancelled.");
                return;
            }
            if (this.settings.debug) console.log(error);
            new Notice(`Error transcribing file: ${error}`, 10 * 1000);
        } finally {
            // Clear the AbortController after completion or cancellation
            abortController = null;
        }
    }

    onFileMenu(menu: Menu, file: TFile) {
        const parentFile = this.app.workspace.getActiveFile();

        // Check if the parent file is not null and the file is of a type you want to handle
        if (parentFile instanceof TFile && file instanceof TFile) {
            // Get the file extension
            const fileExtension = file.extension?.toLowerCase();

            // Check if the file extension is in the allowed list
            if (fileExtension && Transcription.transcribeFileExtensions.includes(fileExtension)) {
                // Add a new item to the right-click menu
                menu.addItem((item) => {
                    item.setTitle("Transcribe")
                        .setIcon("headphones")
                        .onClick(async () => {
                            this.openTranscriptionModal([file], (selectedFiles, pipelineFile) => {
                                for (const f of selectedFiles) {
                                    const abortController = new AbortController();
                                    const task = this.transcribeAndWrite(parentFile, f, pipelineFile, abortController);
                                    this.ongoingTranscriptionTasks.push({ task, abortController });
                                }
                            });
                        });
                });
            }
        }
    }

    async onload() {
        await this.loadSettings();

        Transcription.plugin = this;
        console.log("Loading Obsidian Transcription");
        if (this.settings.debug) console.log("Debug mode enabled");

        this.pipelineEngine = new PipelineEngine(this.settings, this.app.vault, this.statusBar, this.app);

        if (!Platform.isMobileApp) {
            this.statusBar = new StatusBar(this.addStatusBarItem());
            this.registerInterval(window.setInterval(() => this.statusBar.display(), 1000));
        }

        // Register the file-menu event
        this.registerEvent(this.app.workspace.on("file-menu", this.onFileMenu.bind(this)));

        this.addCommand({
            id: "obsidian-transcription-transcribe-specific-file-in-view",
            name: "Transcribe",
            editorCallback: async (editor: Editor, view: MarkdownView) => {
                if (view.file === null) return;
                const files = await this.getTranscribeableFiles(view.file);
                if (files.length === 0) {
                    new Notice("No transcribable files found in view.");
                    return;
                }
                this.openTranscriptionModal(files, (selectedFiles, pipelineFile) => {
                    for (const file of selectedFiles) {
                        const abortController = new AbortController();
                        const task = this.transcribeAndWrite(view.file!, file, pipelineFile, abortController);
                        this.ongoingTranscriptionTasks.push({ task, abortController });
                    }
                });
            },
        });

        this.addCommand({
            id: "obsidian-transcription-stop",
            name: "Stop Transcription",
            editorCallback: async () => {
                try {
                    // Check if there is an ongoing transcription task
                    if (this.ongoingTranscriptionTasks.length > 0) {
                        console.log("Stopping ongoing transcription...");

                        // Loop through each ongoing task and signal abort
                        for (const { abortController, task } of this.ongoingTranscriptionTasks) {
                            abortController.abort();
                            await task.catch(() => {}); // Catch any errors during abortion
                        }

                        // Clear the ongoing transcription tasks after completion or cancellation
                        this.ongoingTranscriptionTasks = [];
                    } else {
                        new Notice("No ongoing transcription to stop");
                    }
                } catch (error) {
                    console.error("Error stopping transcription:", error);
                }
            },
        });

        // Kill child processes when the plugin is unloaded
        this.app.workspace.on("quit", () => {
            Transcription.children.forEach((child) => {
                child.kill();
            });
        });

        // This adds a settings tab so the user can configure various aspects of the plugin
        this.addSettingTab(new TranscriptionSettingTab(this.app, this));
    }

    onunload() {
        if (this.settings.debug) console.log("Unloading Obsidian Transcription");
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
}

export { Transcription };
