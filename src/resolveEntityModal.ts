import { App, Modal, Notice, TFile, FuzzySuggestModal, TextComponent, FuzzyMatch } from "obsidian";
import type { EntityFileSelection } from "./engines/autoWikilinkEngine";
import { EnrichedFile, UtilsEngine } from "./engines/utilsEngine";

/**
 * @file
 * @author Generated with help from GPT-4.1, edited by Ezra Marks
 */
export class ResolveEntityModal extends Modal {
    private readonly selections: EntityFileSelection[];
    private readonly unresolved: EntityFileSelection[];
    private readonly allFiles: EnrichedFile[];
    private readonly utilsEngine: UtilsEngine;
    private readonly onComplete: (selections: EntityFileSelection[]) => void;
    private isApplying: boolean = false; // Flag to track if we're applying changes

    private selectedFiles: (TFile | null)[] = [];
    private newFileComponents: (TextComponent | null)[] = [];

    constructor(
        app: App,
        selections: EntityFileSelection[],
        allFiles: EnrichedFile[],
        utilsEngine: UtilsEngine,
        onComplete: (s: EntityFileSelection[]) => void,
    ) {
        super(app);
        this.selections = selections;
        this.unresolved = selections.filter((s) => !s.selectedFile && !s.newFile?.baseName);
        this.allFiles = allFiles;
        this.utilsEngine = utilsEngine;
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

    onClose(): void {
        // Only reset selections if we're not applying changes
        if (!this.isApplying) {
            this.unresolved.forEach((current) => {
                current.wasManuallyResolved = true;
                current.selectedFile = undefined;
                current.newFile = undefined;
            });
            this.onComplete(this.selections);
        }
    }

    private render(): void {
        const { contentEl } = this;
        contentEl.empty();

        const form = contentEl.createEl("form");
        form.addClass("resolve-entity-form");

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
                text: `${entitySel.entityWithFileCandidates.entity.canonicalName} (${idx + 1}/${
                    this.unresolved.length
                })`,
            });

            const contextWrapper = container.createDiv("resolve-entity-context-wrapper");
            const contextBlock = contextWrapper.createDiv("resolve-entity-context");
            contextBlock.setCssStyles({ marginBottom: "8px", paddingLeft: "8px", fontStyle: "italic", opacity: "0.8" });

            const examples = entitySel.entityWithFileCandidates.entity.occurrences;
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

            const hasCandidates =
                entitySel.entityWithFileCandidates.candidates &&
                entitySel.entityWithFileCandidates.candidates.length > 0;

            // Create radio options
            const linkOption = radioGroup.createEl("label");
            const linkRadio = linkOption.createEl("input", {
                attr: {
                    type: "radio",
                    name: `choice-${idx}`,
                    value: "link",
                    ...(hasCandidates ? { checked: "checked" } : {}), // Preselect 'Link' if candidates exist
                },
            }) as HTMLInputElement;
            linkOption.appendText(" Link");

            const newOption = radioGroup.createEl("label");
            const newRadio = newOption.createEl("input", {
                attr: { type: "radio", name: `choice-${idx}`, value: "new" },
            }) as HTMLInputElement;
            newOption.appendText(" New file");

            const ignoreOption = radioGroup.createEl("label");
            const ignoreRadio = ignoreOption.createEl("input", {
                attr: {
                    type: "radio",
                    name: `choice-${idx}`,
                    value: "ignore",
                    ...(!hasCandidates ? { checked: "checked" } : {}), // Only preselect 'Ignore' if no candidates
                },
            }) as HTMLInputElement;
            ignoreOption.appendText(" Ignore");

            const chooseButton = container.createEl("button", { text: "Choose File" });
            chooseButton.type = "button";
            chooseButton.style.width = "100%";
            chooseButton.style.marginTop = "8px";

            // Update button text if a file is selected
            if (this.selectedFiles[idx]) {
                chooseButton.setText(`Selected: ${this.selectedFiles[idx]?.basename}`);
            }

            const newInput = new TextComponent(container);
            newInput.inputEl.name = `input-new-${idx}`;
            newInput.inputEl.placeholder = "New file name...";
            newInput.setValue(entitySel.entityWithFileCandidates.entity.canonicalName);
            newInput.inputEl.style.width = "100%";
            newInput.inputEl.style.marginTop = "8px";
            newInput.inputEl.style.display = "none";
            this.newFileComponents[idx] = newInput;

            chooseButton.onclick = async () => {
                // Prioritize entity candidates in the file list
                const candidateFiles =
                    entitySel.entityWithFileCandidates.candidates?.map((c) => c.enrichedFile.file) || [];
                const otherFiles = this.allFiles
                    .map((f) => f.file)
                    .filter((file) => !candidateFiles.some((cf) => cf.path === file.path));

                // Combine lists with candidates first
                const prioritizedFiles = [...candidateFiles, ...otherFiles];

                const modal = new FileSuggestModal(
                    this.app,
                    prioritizedFiles,
                    this.selectedFiles[idx],
                    candidateFiles, // Pass candidate files for styling
                );
                modal.onChoose = (file) => {
                    this.selectedFiles[idx] = file;
                    chooseButton.setText(`Selected: ${file.basename}`);
                    linkRadio.checked = true; // Auto-select the link option when a file is chosen
                    updateVisibility();
                };
                modal.open();
            };

            const updateVisibility = () => {
                if (linkRadio.checked) {
                    chooseButton.style.display = "block";
                    newInput.inputEl.style.display = "none";
                } else if (newRadio.checked) {
                    chooseButton.style.display = "none";
                    newInput.inputEl.style.display = "block";
                } else {
                    chooseButton.style.display = "none";
                    newInput.inputEl.style.display = "none";
                }
            };

            linkRadio.addEventListener("change", updateVisibility);
            newRadio.addEventListener("change", updateVisibility);
            ignoreRadio.addEventListener("change", updateVisibility);

            // Initialize visibility based on current radio selection
            updateVisibility();
        });

        const controls = contentEl.createDiv("resolve-entity-controls");

        const applyBtn = controls.createEl("button", { text: "Apply" });
        applyBtn.type = "submit";
        applyBtn.disabled = false;

        form.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
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
        this.isApplying = true; // Set the flag before processing

        this.unresolved.forEach((current, idx) => {
            const choice = (form.querySelector(`input[name='choice-${idx}']:checked`) as HTMLInputElement)?.value;

            current.selectedFile = undefined;
            current.newFile = undefined;
            current.wasManuallyResolved = true;

            if (choice === "new") {
                const name = this.newFileComponents[idx]?.getValue().trim();
                if (name) {
                    current.newFile = { baseName: name };
                }
            } else if (choice === "link") {
                const selected = this.selectedFiles[idx];
                if (selected) {
                    current.selectedFile = this.utilsEngine.enrichFile(selected);
                }
            }
        });

        this.onComplete(this.selections);
        this.close();
    }
}

class FileSuggestModal extends FuzzySuggestModal<TFile> {
    onChoose: (file: TFile) => void = () => {};
    private candidateFilePaths: Set<string>;

    constructor(
        app: App,
        private files: TFile[],
        private initialSelection: TFile | null,
        candidateFiles: TFile[] = [],
    ) {
        super(app);
        // Store the paths of candidate files for styling later
        this.candidateFilePaths = new Set(candidateFiles.map((file) => file.path));
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

    renderSuggestion(fuzzyMatch: FuzzyMatch<TFile>, el: HTMLElement): void {
        super.renderSuggestion(fuzzyMatch, el);

        // Apply bold styling to candidate files
        const item = fuzzyMatch.item;
        if (this.candidateFilePaths.has(item.path)) {
            // Add a class to the element itself
            el.addClass("is-candidate");

            // Apply bold style to the element content
            el.style.fontWeight = "bold";
        }
    }

    onChooseItem(item: TFile, evt: MouseEvent | KeyboardEvent): void {
        this.onChoose(item);
    }
}
