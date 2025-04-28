import { App, Modal, Notice } from "obsidian";
import type { EntityFileSelection, EnrichedFile } from "./engines/autoWikilinkEngine";

export class ResolveEntityModal extends Modal {
    private readonly selections: EntityFileSelection[];
    private readonly unresolved: EntityFileSelection[];
    private readonly allFiles: EnrichedFile[];
    private readonly onComplete: (selections: EntityFileSelection[]) => void;

    constructor(
        app: App,
        selections: EntityFileSelection[],
        allFiles: EnrichedFile[],
        onComplete: (s: EntityFileSelection[]) => void,
    ) {
        super(app);
        this.selections = selections;
        this.unresolved = selections.filter((s) => !s.selectedFile && !s.shouldCreateFile);
        this.allFiles = allFiles;
        this.onComplete = onComplete;
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

        const inputElements: HTMLInputElement[] = [];

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
            linkOption.appendText(" Link to existing file: ");

            const input = container.createEl("input", {
                attr: {
                    list: `datalist-${idx}`,
                    name: `input-${idx}`,
                    placeholder: "Type to search files...",
                },
            }) as HTMLInputElement;
            input.style.width = "100%";
            inputElements.push(input);

            const datalist = container.createEl("datalist", { attr: { id: `datalist-${idx}` } });
            this.allFiles.forEach((file) => {
                datalist.createEl("option", { value: file.file.basename });
            });

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
        });

        const controls = contentEl.createDiv("resolve-entity-controls");

        const applyBtn = controls.createEl("button", { text: "Apply" });
        applyBtn.type = "submit";
        applyBtn.disabled = true;

        form.addEventListener("input", () => {
            applyBtn.disabled = false;
            const completed = this.unresolved.length;
            const filled = Array.from(form.querySelectorAll("input[list]"))
                .map((el) => (el as HTMLInputElement).value.trim())
                .filter(Boolean).length;
            progressBar.value = Math.min(completed, filled);
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

        if (inputElements.length > 0) {
            setTimeout(() => inputElements[0].focus(), 50);
        }
    }

    private handleApply(form: HTMLFormElement): void {
        this.unresolved.forEach((current, idx) => {
            const choice = (form.querySelector(`input[name='choice-${idx}']:checked`) as HTMLInputElement)?.value;

            if (choice === "new") {
                current.shouldCreateFile = true;
            } else if (choice === "ignore") {
                // ignored
            } else {
                const inputValue = (form.querySelector(`input[name='input-${idx}']`) as HTMLInputElement)?.value.trim();
                if (!inputValue) return;
                const match = this.allFiles.find((f) => f.file.basename === inputValue);
                if (match) {
                    current.selectedFile = match;
                }
            }
        });

        this.onComplete(this.selections);
        this.close();
    }
}
