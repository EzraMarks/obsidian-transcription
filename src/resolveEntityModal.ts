import { App, Modal, Notice, TFile, FuzzySuggestModal, TextComponent } from "obsidian";
import type { EntityFileSelection, EnrichedFile } from "./engines/autoWikilinkEngine";

export class ResolveEntityModal extends Modal {
    private readonly selections: EntityFileSelection[];
    private readonly unresolved: EntityFileSelection[];
    private readonly allFiles: EnrichedFile[];
    private readonly onComplete: (selections: EntityFileSelection[]) => void;

    private selectedFiles: (TFile | null)[] = [];
    private newFileComponents: (TextComponent | null)[] = [];

    constructor(
        app: App,
        selections: EntityFileSelection[],
        allFiles: EnrichedFile[],
        onComplete: (s: EntityFileSelection[]) => void,
    ) {
        super(app);
        this.selections = selections;
        this.unresolved = selections.filter((s) => !s.selectedFile && !s.newFileName);
        this.allFiles = allFiles;
        this.onComplete = onComplete;
        this.selectedFiles = new Array(this.unresolved.length).fill(null);
        this.newFileComponents = new Array(this.unresolved.length).fill(null);
    }

    onOpen(): void {
        if (this.unresolved.length === 0) {
            new Notice("Nothing to review – all entities already resolved.");
            this.close();
            return;
        }
        this.render();
    }

    onClose(): void {}

    private render(): void {
        const { contentEl } = this;
        contentEl.empty();

        const form = contentEl.createEl("form");
        form.addClass("resolve-entity-form");

        const progressBar = contentEl.createEl("progress");
        progressBar.max = this.unresolved.length;
        progressBar.value = 0;
        progressBar.style.width = "100%";
        progressBar.style.marginBottom = "12px";

        const scrollContainer = form.createDiv("resolve-entity-scroll");
        scrollContainer.setCssStyles({
            maxHeight: "400px",
            overflowY: "auto",
            padding: "8px",
            border: "1px solid var(--background-modifier-border)",
        });

        this.unresolved.forEach((entitySel, idx) => {
            const container = scrollContainer.createDiv("resolve-entity-block");

            container.createEl("h3", {
                text: `${entitySel.entity.entity.entity} (${idx + 1}/${this.unresolved.length})`,
            });

            const contextWrapper = container.createDiv("resolve-entity-context-wrapper");
            const contextBlock = contextWrapper.createDiv("resolve-entity-context");
            contextBlock.setCssStyles({ marginBottom: "8px", paddingLeft: "8px", fontStyle: "italic", opacity: "0.8" });

            const examples = entitySel.entity.entity.occurrences;
            const maxInitial = 3;

            const renderSentence = (sentence: string) => {
                const div = contextBlock.createDiv();
                const parts = sentence.split(/(<entity>|<\/entity>)/);
                let insideEntity = false;
                parts.forEach((part) => {
                    if (part === "<entity>") {
                        insideEntity = true;
                    } else if (part === "</entity>") {
                        insideEntity = false;
                    } else if (insideEntity) {
                        const strong = div.createEl("strong");
                        strong.textContent = part;
                    } else {
                        div.appendText(part);
                    }
                });
            };

            examples.slice(0, maxInitial).forEach((occ) => {
                renderSentence(`…${occ.sentence.trim()}…`);
            });

            if (examples.length > maxInitial) {
                const toggleButton = container.createEl("button", { text: "Show more context" });
                toggleButton.type = "button";
                toggleButton.style.marginBottom = "8px";

                let expanded = false;

                toggleButton.onclick = (e) => {
                    e.preventDefault();
                    expanded = !expanded;
                    contextBlock.empty();

                    (expanded ? examples : examples.slice(0, maxInitial)).forEach((occ) => {
                        renderSentence(`…${occ.sentence.trim()}…`);
                    });

                    toggleButton.textContent = expanded ? "Show less context" : "Show more context";
                };
            }

            const radioGroup = container.createDiv("radio-group");
            radioGroup.setCssStyles({ marginTop: "8px", marginBottom: "8px" });

            const linkOption = radioGroup.createEl("label");
            const linkRadio = linkOption.createEl("input", {
                attr: { type: "radio", name: `choice-${idx}`, value: "link", checked: "checked" },
            }) as HTMLInputElement;
            linkOption.appendText(" Link to existing file");

            const newOption = radioGroup.createEl("label");
            const newRadio = newOption.createEl("input", {
                attr: { type: "radio", name: `choice-${idx}`, value: "new" },
            }) as HTMLInputElement;
            newOption.appendText(" Create a new file");

            const ignoreOption = radioGroup.createEl("label");
            const ignoreRadio = ignoreOption.createEl("input", {
                attr: { type: "radio", name: `choice-${idx}`, value: "ignore" },
            }) as HTMLInputElement;
            ignoreOption.appendText(" Ignore (leave plain)");

            const chooseButton = container.createEl("button", { text: "Choose file..." });
            chooseButton.type = "button";
            chooseButton.style.width = "100%";
            chooseButton.style.marginTop = "8px";

            const chosenFileDisplay = container.createEl("div", { text: "No file selected" });
            chosenFileDisplay.style.fontSize = "smaller";
            chosenFileDisplay.style.opacity = "0.7";

            const newInput = new TextComponent(container);
            newInput.inputEl.name = `input-new-${idx}`;
            newInput.inputEl.placeholder = "New file name...";
            newInput.setValue(entitySel.entity.entity.entity);
            newInput.inputEl.style.width = "100%";
            newInput.inputEl.style.marginTop = "8px";
            newInput.inputEl.style.display = "none";
            this.newFileComponents[idx] = newInput;

            chooseButton.onclick = async () => {
                const modal = new FileSuggestModal(this.app, this.allFiles.map((f) => f.file), this.selectedFiles[idx]);
                modal.onChoose = (file) => {
                    this.selectedFiles[idx] = file;
                    chooseButton.setText(`Change file (Selected: ${file.basename})`);
                    chosenFileDisplay.setText("");
                };
                modal.open();
            };

            const updateVisibility = () => {
                if (linkRadio.checked) {
                    chooseButton.style.display = "block";
                    chosenFileDisplay.style.display = "block";
                    newInput.inputEl.style.display = "none";
                } else if (newRadio.checked) {
                    chooseButton.style.display = "none";
                    chosenFileDisplay.style.display = "none";
                    newInput.inputEl.style.display = "block";
                } else {
                    chooseButton.style.display = "none";
                    chosenFileDisplay.style.display = "none";
                    newInput.inputEl.style.display = "none";
                }
            };

            linkRadio.addEventListener("change", updateVisibility);
            newRadio.addEventListener("change", updateVisibility);
            ignoreRadio.addEventListener("change", updateVisibility);

            updateVisibility();
        });

        const controls = contentEl.createDiv("resolve-entity-controls");

        const applyBtn = controls.createEl("button", { text: "Apply" });
        applyBtn.type = "submit";
        applyBtn.disabled = true;

        form.addEventListener("input", () => {
            applyBtn.disabled = false;
            progressBar.value = this.unresolved.length;
        });

        form.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !applyBtn.disabled) {
                e.preventDefault();
                applyBtn.click();
            }
        });

        applyBtn.onclick = (e) => {
            e.preventDefault();
            this.handleApply(form);
        };
    }

    private handleApply(form: HTMLFormElement): void {
        this.unresolved.forEach((current, idx) => {
            const choice = (form.querySelector(`input[name='choice-${idx}']:checked`) as HTMLInputElement)?.value;

            current.selectedFile = undefined;
            current.newFileName = undefined;
            (current as any).wasManuallyResolved = true;

            if (choice === "new") {
                const name = this.newFileComponents[idx]?.getValue().trim();
                if (name) {
                    current.newFileName = name;
                }
            } else if (choice === "link") {
                const selected = this.selectedFiles[idx];
                if (selected) {
                    current.selectedFile = { file: selected, aliases: [], misspellings: [] };
                }
            }
        });

        this.onComplete(this.selections);
        this.close();
    }
}

class FileSuggestModal extends FuzzySuggestModal<TFile> {
    onChoose: (file: TFile) => void = () => {};

    constructor(app: App, private files: TFile[], private initialSelection: TFile | null) {
        super(app);
    }

    getItems(): TFile[] {
        return this.files;
    }

    getItemText(item: TFile): string {
        return item.basename;
    }

    onOpen(): void {
        super.onOpen();
        if (this.initialSelection) {
            this.inputEl.value = this.initialSelection.basename;
        }
    }

    onChooseItem(item: TFile, evt: MouseEvent | KeyboardEvent): void {
        this.onChoose(item);
    }
}
