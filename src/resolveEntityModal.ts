import { App, Modal, Notice, TFile, FuzzySuggestModal, TextComponent, FuzzyMatch } from "obsidian";
import { SelectionConfidence, type EntityFileSelection } from "./engines/autoWikilinkEngine";
import { EnrichedFile, UtilsEngine } from "./engines/utilsEngine";

/**
 * @file
 * @author Generated with help from GPT-4.1, edited by Ezra Marks
 */

const CONFIDENCE_ORDER: Record<SelectionConfidence, number> = {
    [SelectionConfidence.Uncertain]: 0,
    [SelectionConfidence.Unmatched]: 1,
    [SelectionConfidence.Likely]: 2,
    [SelectionConfidence.Certain]: 3,
};

const CONFIDENCE_LABEL: Record<SelectionConfidence, string> = {
    [SelectionConfidence.Uncertain]: "uncertain",
    [SelectionConfidence.Unmatched]: "no match",
    [SelectionConfidence.Likely]: "likely",
    [SelectionConfidence.Certain]: "certain",
};

export class ResolveEntityModal extends Modal {
    private readonly selections: EntityFileSelection[];
    private readonly allFiles: EnrichedFile[];
    private readonly utilsEngine: UtilsEngine;
    private readonly onComplete: (selections: EntityFileSelection[] | null) => void;
    private isApplying: boolean = false;
    private isCancelling: boolean = false;

    private selectedFiles: (TFile | null)[] = [];
    private newFileComponents: (TextComponent | null)[] = [];

    constructor(
        app: App,
        selections: EntityFileSelection[],
        allFiles: EnrichedFile[],
        utilsEngine: UtilsEngine,
        onComplete: (s: EntityFileSelection[] | null) => void,
    ) {
        super(app);
        this.modalEl.addClass("resolve-entity-modal");
        // Sort least-confident first so the sketchy ones are at the top
        this.selections = [...selections].sort(
            (a, b) => CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence],
        );
        this.allFiles = allFiles;
        this.utilsEngine = utilsEngine;
        this.onComplete = onComplete;
        // Pre-populate with AI's selections so confirmed matches pass through untouched
        this.selectedFiles = this.selections.map((s) => s.selectedFile?.file ?? null);
        this.newFileComponents = new Array(this.selections.length).fill(null);
    }

    onOpen(): void {
        if (this.selections.length === 0) {
            new Notice("No entities found.");
            this.isCancelling = true;
            this.close();
            return;
        }
        this.render();
    }

    close(): void {
        if (this.isApplying || this.isCancelling) {
            super.close();
            return;
        }
        // Intercept close (X button, Escape, etc.) and ask for confirmation
        new ConfirmCancelModal(this.app, () => {
            this.isCancelling = true;
            this.onComplete(null);
            super.close();
        }).open();
    }

    onClose(): void {
        // All paths are handled explicitly — nothing to do here
    }

    private render(): void {
        const { contentEl } = this;
        contentEl.empty();

        const form = contentEl.createEl("form");
        form.addClass("resolve-entity-form");

        const scrollContainer = form.createDiv("resolve-entity-scroll");

        let inConfidentSection = false;

        this.selections.forEach((entitySel, idx) => {
            const isConfident = entitySel.confidence === SelectionConfidence.Likely || entitySel.confidence === SelectionConfidence.Certain;

            // Insert a divider when transitioning from uncertain/none into the AI-confident group
            if (isConfident && !inConfidentSection) {
                inConfidentSection = true;
                const divider = scrollContainer.createDiv("resolve-entity-divider");
                divider.setText("AI is confident about the following");
            }

            const container = scrollContainer.createDiv("resolve-entity-block");

            // Header row: name + confidence badge
            const header = container.createEl("h3");
            header.appendText(`${entitySel.entityWithFileCandidates.entity.canonicalName} (${idx + 1}/${this.selections.length})`);

            const badge = header.createEl("span");
            badge.setText(CONFIDENCE_LABEL[entitySel.confidence]);
            badge.addClass("resolve-entity-badge");
            if (entitySel.confidence === SelectionConfidence.Uncertain) {
                badge.addClass("resolve-entity-badge--uncertain");
            } else if (entitySel.confidence === SelectionConfidence.Certain) {
                badge.addClass("resolve-entity-badge--certain");
            }

            const contextWrapper = container.createDiv("resolve-entity-context-wrapper");
            const contextBlock = contextWrapper.createDiv("resolve-entity-context");

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
                toggleButton.addClass("resolve-entity-toggle-btn");

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

            const hasAiSelection = !!entitySel.selectedFile;
            const hasCandidates =
                entitySel.entityWithFileCandidates.candidates &&
                entitySel.entityWithFileCandidates.candidates.length > 0;

            const shouldPreSelectLink = hasAiSelection || hasCandidates;

            const linkOption = radioGroup.createEl("label");
            const linkRadio = linkOption.createEl("input", {
                attr: {
                    type: "radio",
                    name: `choice-${idx}`,
                    value: "link",
                    ...(shouldPreSelectLink ? { checked: "checked" } : {}),
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
                    ...(!shouldPreSelectLink ? { checked: "checked" } : {}),
                },
            }) as HTMLInputElement;
            ignoreOption.appendText(" Ignore");

            const chooseButton = container.createEl("button", {
                text: this.selectedFiles[idx]
                    ? `Selected: ${this.selectedFiles[idx]?.basename}`
                    : "Choose File",
            });
            chooseButton.type = "button";
            chooseButton.addClass("resolve-entity-choose-btn");

            const newInput = new TextComponent(container);
            newInput.inputEl.name = `input-new-${idx}`;
            newInput.inputEl.placeholder = "New file name...";
            newInput.setValue(entitySel.entityWithFileCandidates.entity.canonicalName);
            newInput.inputEl.addClass("resolve-entity-new-input");
            newInput.inputEl.style.display = "none";
            this.newFileComponents[idx] = newInput;

            chooseButton.onclick = async () => {
                const candidateFiles =
                    entitySel.entityWithFileCandidates.candidates?.map((c) => c.enrichedFile.file) || [];
                const otherFiles = this.allFiles
                    .map((f) => f.file)
                    .filter((file) => !candidateFiles.some((cf) => cf.path === file.path));

                const prioritizedFiles = [...candidateFiles, ...otherFiles];

                const modal = new FileSuggestModal(
                    this.app,
                    prioritizedFiles,
                    this.selectedFiles[idx],
                    candidateFiles,
                );
                modal.onChoose = (file) => {
                    this.selectedFiles[idx] = file;
                    chooseButton.setText(`Selected: ${file.basename}`);
                    linkRadio.checked = true;
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

            updateVisibility();
        });

        const controls = contentEl.createDiv("resolve-entity-controls");

        const cancelBtn = controls.createEl("button", { text: "Cancel" });
        cancelBtn.type = "button";
        cancelBtn.onclick = () => this.close();

        const applyBtn = controls.createEl("button", { text: "Apply" });
        applyBtn.type = "submit";

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
        this.isApplying = true;

        this.selections.forEach((current, idx) => {
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

class ConfirmCancelModal extends Modal {
    constructor(app: App, private readonly onConfirm: () => void) {
        super(app);
        this.modalEl.addClass("resolve-entity-confirm-modal");
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.createEl("p", { text: "Cancel linking? No wikilinks will be written." });

        const buttons = contentEl.createDiv("resolve-entity-confirm-buttons");

        const goBackBtn = buttons.createEl("button", { text: "Keep editing" });
        goBackBtn.onclick = () => this.close();

        const confirmBtn = buttons.createEl("button", { text: "Cancel (no links)" });
        confirmBtn.onclick = () => {
            this.close();
            this.onConfirm();
        };
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

        const item = fuzzyMatch.item;
        if (this.candidateFilePaths.has(item.path)) {
            el.addClass("is-candidate");
        }
    }

    onChooseItem(item: TFile, evt: MouseEvent | KeyboardEvent): void {
        this.onChoose(item);
    }
}
