import { App, Modal, Setting } from "obsidian";

export class PromptModal extends Modal {
	result: string = "";
	promptText: string;
	onSubmit: (result: string) => void;

	constructor(app: App, promptText: string, onSubmit: (result: string) => void) {
		super(app);
		this.promptText = promptText;
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: this.promptText });

		let inputEl: HTMLTextAreaElement;

		new Setting(contentEl)
			.setName("Your Response")
			.addTextArea((text) => {
				inputEl = text.inputEl;
				text.onChange((value) => {
					this.result = value;
				});
			});

		new Setting(contentEl)
			.addButton((btn) =>
				btn
					.setButtonText("Submit")
					.setCta()
					.onClick(() => {
						this.close();
						this.onSubmit(this.result);
					})
			);
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
