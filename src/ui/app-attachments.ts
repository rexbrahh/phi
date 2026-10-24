import type { Editor } from "@earendil-works/pi-tui";
import { assertAttachmentTotalWithinLimit, type ImageAttachment } from "../attachments.js";
import type { AppDependencies } from "./app-types.js";
import { sanitizeTerminalText } from "./safe-text.js";

export interface AppAttachmentOptions {
	dependencies: Pick<AppDependencies, "readClipboardImage" | "copyText" | "loadImage">;
	editor: Editor;
	draftRevision(): number;
	sessionId(): string | undefined;
	selectedOutput(): string | undefined;
	isClosing(): boolean;
	showNotice(message: string | undefined): void;
}

export class AppAttachmentController {
	readonly attachments: ImageAttachment[] = [];
	private readonly controllers = new Set<AbortController>();
	private readonly operations = new Set<Promise<void>>();

	constructor(private readonly options: AppAttachmentOptions) {}

	loadImage(path: string, restoreDraft: string): void {
		this.startLoad(
			(signal) => this.options.dependencies.loadImage(path, signal),
			undefined,
			restoreDraft,
		);
	}

	loadClipboardImage(): void {
		this.startLoad(
			(signal) => this.options.dependencies.readClipboardImage(signal),
			"Clipboard has no image. Your draft is unchanged.",
		);
	}

	removeLatest(): void {
		this.attachments.pop();
	}

	async copySelectedOutput(): Promise<void> {
		const text = this.options.selectedOutput();
		if (!text) {
			this.options.showNotice("Select a task or load history before copying output.");
			return;
		}
		const controller = new AbortController();
		this.controllers.add(controller);
		const operation = (async () => {
			try {
				await this.options.dependencies.copyText(sanitizeTerminalText(text), controller.signal);
				if (!this.options.isClosing()) this.options.showNotice("Selected output copied to the clipboard.");
			} catch (error) {
				if (!controller.signal.aborted && !this.options.isClosing()) {
					this.options.showNotice(`Could not copy output: ${errorText(error)}`);
				}
			} finally {
				this.controllers.delete(controller);
			}
		})();
		this.track(operation);
		await operation;
	}

	async close(): Promise<void> {
		for (const controller of this.controllers) controller.abort();
		await Promise.allSettled([...this.operations]);
	}

	private startLoad(
		load: (signal: AbortSignal) => Promise<ImageAttachment | null>,
		emptyMessage?: string,
		restoreDraft?: string,
	): void {
		const controller = new AbortController();
		const draftRevision = this.options.draftRevision();
		const sessionId = this.options.sessionId();
		this.controllers.add(controller);
		const operation = (async () => {
			try {
				const attachment = await load(controller.signal);
				if (!attachment) {
					if (emptyMessage) this.options.showNotice(emptyMessage);
					return;
				}
				if (this.options.isClosing()) return;
				if (
					controller.signal.aborted
					|| draftRevision !== this.options.draftRevision()
					|| sessionId !== this.options.sessionId()
				) {
					this.options.showNotice("Image load was discarded because the session or composer draft changed.");
					return;
				}
				assertAttachmentTotalWithinLimit([...this.attachments, attachment]);
				this.attachments.push(attachment);
				this.options.showNotice(`Attached ${attachment.name}.`);
			} catch (error) {
				if (!controller.signal.aborted && !this.options.isClosing()) {
					if (restoreDraft !== undefined) this.options.editor.setText(restoreDraft);
					this.options.showNotice(`Could not attach image: ${errorText(error)}`);
				}
			} finally {
				this.controllers.delete(controller);
			}
		})();
		this.track(operation);
	}

	private track(operation: Promise<void>): void {
		this.operations.add(operation);
		void operation.then(() => this.operations.delete(operation));
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
