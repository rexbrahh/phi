import { type Editor, type OverlayHandle, TuiMainScreen } from "@earendil-works/pi-tui";
import { InteractionQueue, type InteractionAnswer } from "../interactions.js";
import { DialogView } from "./dialogs.js";

export class AppDialogController {
	readonly view: DialogView;
	private overlay: OverlayHandle | undefined;
	private isVisible = false;
	private suppressed = false;

	constructor(
		private readonly tui: TuiMainScreen,
		private readonly editor: Editor,
		private readonly interactions: InteractionQueue,
		private readonly openExternalUrl: (url: string) => void,
		private readonly showNotice: (message: string) => void,
		private readonly onChange: () => void,
	) {
		this.view = new DialogView({
			answer: (requestId, answer) => this.answer(requestId, answer),
			openUrl: (url) => this.openUrl(url),
			error: (message) => this.showNotice(message),
			hide: () => this.hide(),
		}, () => Math.max(1, this.tui.terminal.rows - 2));
	}

	get visible(): boolean {
		return this.isVisible;
	}

	handleKey(data: string): void {
		this.view.handleKey(data);
	}

	sync(): void {
		const request = this.interactions.pending[0];
		this.view.setRequest(request);
		if (!request) {
			if (this.overlay && this.isVisible) {
				this.isVisible = false;
				this.overlay.setHidden(true);
				this.overlay.unfocus({ target: this.editor });
			}
			this.suppressed = false;
			this.onChange();
			return;
		}
		if (this.suppressed) return;
		if (!this.overlay) {
			this.overlay = this.tui.showOverlay(this.view, {
				width: "90%",
				maxHeight: "100%",
				anchor: "bottom-center",
				offsetY: -1,
				margin: 1,
			});
		} else {
			this.overlay.setHidden(false);
			this.overlay.focus();
		}
		this.isVisible = true;
		this.onChange();
	}

	hide(): void {
		if (!this.overlay || !this.isVisible) return;
		this.isVisible = false;
		this.suppressed = true;
		this.overlay.setHidden(true);
		this.overlay.unfocus({ target: this.editor });
		this.onChange();
	}

	reopen(): void {
		this.suppressed = false;
		this.sync();
	}

	showMcpStatus(value: unknown): void {
		if (!Array.isArray(value)) return;
		const failures = value.flatMap((entry) => {
			if (!entry || typeof entry !== "object") return [];
			const record = entry as Record<string, unknown>;
			if (record.status === "connected") return [];
			const name = typeof record.name === "string" ? record.name : "MCP server";
			const detail = typeof record.error === "string" ? `: ${record.error}` : "";
			return [`${name} ${String(record.status ?? "status unavailable")}${detail}`];
		});
		if (failures.length) this.showNotice(`MCP: ${failures.join("; ")}`);
	}

	private answer(requestId: string, answer: InteractionAnswer): void {
		try {
			if (this.interactions.answer(requestId, answer)) this.sync();
		} catch (error) {
			this.showNotice(`That response is invalid: ${errorText(error)}`);
		}
	}

	private openUrl(url: string): void {
		try {
			const parsed = new URL(url);
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
				this.showNotice("Only HTTP and HTTPS elicitation links can be opened.");
				return;
			}
			this.openExternalUrl(parsed.toString());
			this.showNotice("Opened the selected elicitation link.");
		} catch (error) {
			this.showNotice(`Could not open the selected link: ${errorText(error)}`);
		}
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
