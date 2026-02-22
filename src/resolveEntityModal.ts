import { App, Modal, Notice, TFile, FuzzySuggestModal, TextComponent, FuzzyMatch } from "obsidian";
import { SelectionConfidence, type EntityFileSelection } from "./engines/autoWikilinkEngine";
import { EnrichedFile, UtilsEngine } from "./engines/utilsEngine";

/**
 * @file
 * @author Generated with help from GPT-4.1, edited by Ezra Marks
 */

const CONFIDENCE_ORDER: Record<SelectionConfidence, number> = {
    [SelectionConfidence.Unmatched]: 0,
    [SelectionConfidence.Uncertain]: 1,
    [SelectionConfidence.Likely]: 2,
    [SelectionConfidence.Certain]: 3,
};

const SECTION_DEFS: { confidence: SelectionConfidence; label: string }[] = [
    { confidence: SelectionConfidence.Unmatched, label: "No match" },
    { confidence: SelectionConfidence.Uncertain, label: "Uncertain" },
    { confidence: SelectionConfidence.Likely, label: "Likely" },
    { confidence: SelectionConfidence.Certain, label: "Certain" },
];


export class ResolveEntityModal extends Modal {
    private readonly selections: EntityFileSelection[];
    private readonly allFiles: EnrichedFile[];
    private readonly fileTypeTags: Map<string, string[]>;
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
        fileTypeTags: Map<string, string[]>,
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
        this.fileTypeTags = fileTypeTags;
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

        // Group selections by confidence
        const grouped = new Map<SelectionConfidence, { sel: EntityFileSelection; idx: number }[]>();
        this.selections.forEach((sel, idx) => {
            const existing = grouped.get(sel.confidence) ?? [];
            existing.push({ sel, idx });
            grouped.set(sel.confidence, existing);
        });

        let isFirstSection = true;

        for (const { confidence, label } of SECTION_DEFS) {
            const group = grouped.get(confidence);
            if (!group || group.length === 0) continue;

            const sectionHeader = scrollContainer.createDiv("resolve-entity-section-header");
            sectionHeader.setText(`${label} (${group.length})`);
            sectionHeader.setAttribute("data-confidence", confidence);
            if (isFirstSection) sectionHeader.addClass("resolve-entity-section-header--first");
            isFirstSection = false;

            for (const { sel: entitySel, idx } of group) {
                const container = scrollContainer.createDiv("resolve-entity-block");
                container.setAttribute("data-confidence", confidence);

                // Name row: name + type badge + context toggle
                const nameRow = container.createDiv("resolve-entity-name-row");

                const nameGroup = nameRow.createDiv("resolve-entity-name-group");
                nameGroup.createEl("span", { text: entitySel.entityWithFileCandidates.entity.canonicalName });

                const typeBadge = nameGroup.createEl("span");
                typeBadge.setText(entitySel.entityWithFileCandidates.entity.type);
                typeBadge.addClass("resolve-entity-badge");

                const contextBtn = nameRow.createEl("button", { text: "Context" });
                contextBtn.type = "button";
                contextBtn.addClass("resolve-entity-context-btn");

                // Context panel — directly below the name row, above the action controls
                const contextPanel = container.createDiv("resolve-entity-context-panel");
                contextPanel.style.display = "none";

                const examples = entitySel.entityWithFileCandidates.entity.occurrences;
                examples.forEach((occ) => {
                    const div = contextPanel.createDiv();
                    const parts = `…${occ.sentence.trim()}…`.split("<entity/>");
                    parts.forEach((part, i) => {
                        div.appendText(part);
                        if (i < parts.length - 1) {
                            div.createEl("strong", { text: occ.displayName });
                        }
                    });
                });

                contextBtn.onclick = (e) => {
                    e.preventDefault();
                    const isHidden = contextPanel.style.display === "none";
                    contextPanel.style.display = isHidden ? "block" : "none";
                    contextBtn.setText(isHidden ? "Hide context" : "Context");
                };

                // Hidden radios — carry the form value; segments drive them
                const radioContainer = container.createDiv();
                radioContainer.style.display = "none";

                const hasAiSelection = !!entitySel.selectedFile;
                const hasCandidates =
                    entitySel.entityWithFileCandidates.candidates &&
                    entitySel.entityWithFileCandidates.candidates.length > 0;
                const shouldPreSelectLink = hasAiSelection || hasCandidates;

                const linkRadio = radioContainer.createEl("input", {
                    attr: { type: "radio", name: `choice-${idx}`, value: "link",
                        ...(shouldPreSelectLink ? { checked: "checked" } : {}) },
                }) as HTMLInputElement;
                const newRadio = radioContainer.createEl("input", {
                    attr: { type: "radio", name: `choice-${idx}`, value: "new" },
                }) as HTMLInputElement;
                const ignoreRadio = radioContainer.createEl("input", {
                    attr: { type: "radio", name: `choice-${idx}`, value: "ignore",
                        ...(!shouldPreSelectLink ? { checked: "checked" } : {}) },
                }) as HTMLInputElement;

                // Segmented button row
                const segmentGroup = container.createDiv("resolve-entity-segment-group");

                const linkSegment = segmentGroup.createEl("button", { text: "Link" });
                linkSegment.type = "button";
                linkSegment.addClass("resolve-entity-segment");

                const newSegment = segmentGroup.createEl("button", { text: "New file" });
                newSegment.type = "button";
                newSegment.addClass("resolve-entity-segment");

                const ignoreSegment = segmentGroup.createEl("button", { text: "Ignore" });
                ignoreSegment.type = "button";
                ignoreSegment.addClass("resolve-entity-segment");

                // File detail area — shown below segments when Link or New is active
                const fileArea = container.createDiv("resolve-entity-file-area");

                const chooseButton = fileArea.createEl("button", {
                    text: this.selectedFiles[idx]
                        ? `↗ ${this.selectedFiles[idx]?.basename}`
                        : "Choose file…",
                });
                chooseButton.type = "button";
                chooseButton.addClass("resolve-entity-choose-btn");

                const newInput = new TextComponent(fileArea);
                newInput.inputEl.name = `input-new-${idx}`;
                newInput.inputEl.placeholder = "File name…";
                newInput.setValue(entitySel.entityWithFileCandidates.entity.canonicalName);
                newInput.inputEl.addClass("resolve-entity-new-input");
                this.newFileComponents[idx] = newInput;

                chooseButton.onclick = async () => {
                    const candidateFiles =
                        entitySel.entityWithFileCandidates.candidates?.map((c) => c.enrichedFile.file) || [];
                    const otherFiles = this.allFiles
                        .map((f) => f.file)
                        .filter((file) => !candidateFiles.some((cf) => cf.path === file.path));

                    const modal = new FileSuggestModal(
                        this.app,
                        [...candidateFiles, ...otherFiles],
                        this.selectedFiles[idx],
                        candidateFiles,
                        this.fileTypeTags,
                    );
                    modal.onChoose = (file) => {
                        this.selectedFiles[idx] = file;
                        chooseButton.setText(`↗ ${file.basename}`);
                        linkRadio.checked = true;
                        updateVisibility();
                    };
                    modal.open();
                };

                const updateVisibility = () => {
                    linkSegment.toggleClass("is-active", linkRadio.checked);
                    newSegment.toggleClass("is-active", newRadio.checked);
                    ignoreSegment.toggleClass("is-active", ignoreRadio.checked);
                    fileArea.style.display = (linkRadio.checked || newRadio.checked) ? "block" : "none";
                    chooseButton.style.display = linkRadio.checked ? "block" : "none";
                    newInput.inputEl.style.display = newRadio.checked ? "block" : "none";
                };

                linkSegment.onclick = () => { linkRadio.checked = true; updateVisibility(); };
                newSegment.onclick = () => { newRadio.checked = true; updateVisibility(); };
                ignoreSegment.onclick = () => { ignoreRadio.checked = true; updateVisibility(); };

                updateVisibility();
            }
        }

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
        private fileTypeTags: Map<string, string[]> = new Map(),
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
        el.addClass("file-suggest-row");

        const textWrapper = el.createDiv("file-suggest-text");
        super.renderSuggestion(fuzzyMatch, textWrapper);

        if (this.candidateFilePaths.has(fuzzyMatch.item.path)) {
            el.addClass("is-candidate");
        }

        const types = this.fileTypeTags.get(fuzzyMatch.item.path);
        if (types && types.length > 0) {
            const badgeContainer = el.createDiv("file-suggest-badges");
            for (const type of types) {
                badgeContainer.createEl("span", { text: type, cls: "resolve-entity-badge" });
            }
        }
    }

    onChooseItem(item: TFile, evt: MouseEvent | KeyboardEvent): void {
        this.onChoose(item);
    }
}
