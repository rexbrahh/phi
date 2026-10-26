import { Editor, OverlayHandle, SelectList, Text, TuiMainScreen, VStack } from "@earendil-works/pi-tui";
import { theme } from "./theme.js";

export interface ExitConfirmationReason {
	draft: boolean;
	work: boolean;
}

export class AppExitConfirmationController {
	private overlay: OverlayHandle | undefined;
	private isVisible = false;
	private readonly prompt = new Text("", 0, 0);
	private readonly choices = new SelectList([
		{ value: "exit", label: "Stop work and exit Phi" },
		{ value: "stay", label: "Keep Phi open" },
	], 2, theme.selectList);

	constructor(
		private readonly tui: TuiMainScreen,
		private readonly editor: Editor,
		private readonly onExit: () => void,
		private readonly onChange: () => void,
	) {
		this.choices.onSelect = (item) => {
			this.hide();
			if (item.value === "exit") this.onExit();
		};
		this.choices.onCancel = () => this.hide();
	}

	get visible(): boolean {
		return this.isVisible;
	}

	show(reason: ExitConfirmationReason): void {
		const description = [
			reason.work ? "Phi will stop the remaining work." : "",
			reason.draft ? "Phi will discard the unsent draft and attachments." : "",
		].filter(Boolean).join(" ");
		this.prompt.setText(theme.accent(`Exit Phi? ${description}`));
		this.choices.setSelectedIndex(0);
		if (!this.overlay) {
			this.overlay = this.tui.showOverlay(new VStack([
				this.prompt,
				this.choices,
				new Text(theme.dim("Enter confirms · Esc keeps Phi open"), 0, 0),
			]), {
				width: "75%",
				maxHeight: "100%",
				anchor: "center",
				margin: 1,
			});
		} else {
			this.overlay.setHidden(false);
			this.overlay.focus();
		}
		this.isVisible = true;
		this.onChange();
	}

	handleInput(data: string): void {
		if (!this.isVisible) return;
		this.choices.handleInput(data);
		this.onChange();
	}

	hide(): void {
		if (!this.overlay || !this.isVisible) return;
		this.isVisible = false;
		this.overlay.setHidden(true);
		this.overlay.unfocus({ target: this.editor });
		this.onChange();
	}
}
