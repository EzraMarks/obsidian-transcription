import { App, Modal, Setting, TFile } from "obsidian";

export class TranscriptionModal extends Modal {
    private selectedFiles: Set<TFile> = new Set();
    private selectedPipeline: TFile;
    private multiSelectMode = false;

    constructor(
        app: App,
        private readonly files: TFile[],
        private readonly pipelineFiles: TFile[],
        private readonly onConfirm: (files: TFile[], pipeline: TFile) => void,
    ) {
        super(app);
        this.selectedPipeline = pipelineFiles[0];
    }

    onOpen() {
        const { contentEl } = this;
        this.setTitle("Transcribe");

        if (this.pipelineFiles.length > 1) {
            new Setting(contentEl)
                .setName("Pipeline")
                .addDropdown(dropdown => {
                    for (const pf of this.pipelineFiles) {
                        dropdown.addOption(pf.path, pf.basename);
                    }
                    dropdown.onChange(value => {
                        this.selectedPipeline = this.pipelineFiles.find(f => f.path === value)!;
                    });
                });
        }

        if (this.files.length > 1) {
            new Setting(contentEl)
                .setName("Select multiple")
                .addToggle(toggle => toggle
                    .setValue(false)
                    .onChange(value => {
                        this.multiSelectMode = value;
                        this.renderFileList(fileListEl);
                    })
                );
        }

        const fileListEl = contentEl.createDiv({ cls: "transcription-file-list" });
        this.renderFileList(fileListEl);
    }

    private renderFileList(containerEl: HTMLElement) {
        containerEl.empty();
        this.selectedFiles.clear();

        if (this.multiSelectMode) {
            for (const file of this.files) {
                new Setting(containerEl)
                    .setName(file.name)
                    .addToggle(toggle => toggle
                        .setValue(false)
                        .onChange(value => {
                            value ? this.selectedFiles.add(file) : this.selectedFiles.delete(file);
                        })
                    );
            }

            const btnRow = containerEl.createDiv({ cls: "modal-button-container" });
            const transcribeBtn = btnRow.createEl("button", { text: "Transcribe", cls: "mod-cta" });
            transcribeBtn.addEventListener("click", () => {
                if (this.selectedFiles.size === 0) return;
                this.close();
                this.onConfirm([...this.selectedFiles], this.selectedPipeline);
            });
        } else {
            for (const file of this.files) {
                new Setting(containerEl)
                    .setName(file.name)
                    .addButton(btn => btn
                        .setButtonText("Transcribe")
                        .setCta()
                        .onClick(() => {
                            this.close();
                            this.onConfirm([file], this.selectedPipeline);
                        })
                    );
            }
        }
    }

    onClose() { this.contentEl.empty(); }
}
