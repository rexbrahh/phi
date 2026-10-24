import { randomUUID } from "node:crypto";
import type { Editor } from "@earendil-works/pi-tui";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { assertAttachmentTotalWithinLimit, type ImageAttachment } from "../attachments.js";
import type { Session } from "../session.js";
import type { ShellPreview, ShellReceipt } from "../shell.js";
import { markInputsDeliveryUnknown, recordSubmittedInput, type PhiState } from "../state.js";
import { parseLocalCommand, type LocalCommand } from "../commands.js";
import type { AppAttachmentController } from "./app-attachments.js";
import type { AppKeyboardController } from "./app-keyboard.js";
import type { AppShellController } from "./app-shell.js";

export interface AppSubmissionOptions {
	state: PhiState;
	editor: Editor;
	attachments: ImageAttachment[];
	attachmentController: AppAttachmentController;
	keyboard: AppKeyboardController;
	shell: AppShellController;
	session(): Session | undefined;
	sessionId(): string | undefined;
	isSessionTransitionInProgress(): boolean;
	leaveShellMode(): void;
	dispatchLocalCommand(command: LocalCommand): void;
	onPromptSubmitted(): void;
	showNotice(message: string | undefined): void;
}

export class AppSubmissionController {
	constructor(private readonly options: AppSubmissionOptions) {}

	submit(text: string): void {
		const content = text.trim();
		if (!content && this.options.attachments.length === 0) {
			if (this.options.shell.mode) {
				this.options.keyboard.clearInlinePastes();
				this.options.leaveShellMode();
			}
			return;
		}
		if (this.options.shell.mode) {
			this.options.keyboard.clearInlinePastes();
			const cwd = this.options.shell.cwdSnapshot ?? this.options.state.cwd;
			this.options.leaveShellMode();
			if (content && !this.options.shell.start(content, cwd, this.options.sessionId())) {
				this.options.editor.setText(text);
			}
			return;
		}
		const command = parseLocalCommand(text);
		if (command) {
			this.options.keyboard.clearInlinePastes();
			this.options.dispatchLocalCommand(command);
			return;
		}
		this.sendPrompt(text);
	}

	sendLiteral(text: string): void {
		if (!text.trim() && this.options.attachments.length === 0) return;
		this.sendPrompt(text);
	}

	private sendPrompt(text: string): void {
		if (this.options.isSessionTransitionInProgress()) {
			this.options.editor.setText(text);
			this.options.showNotice("A session switch is in progress. Your draft is still in the composer.");
			return;
		}
		const session = this.options.session();
		const sessionId = this.options.sessionId();
		if (sessionId === undefined || !session) {
			this.options.editor.setText(text);
			this.options.showNotice("The session is not ready. Your draft is still in the composer.");
			return;
		}

		let blocks: SDKUserMessage["message"]["content"];
		try {
			assertAttachmentTotalWithinLimit(this.options.attachments);
			blocks = this.options.attachments.length
				? [
					...(text ? [{ type: "text" as const, text }] : []),
					...this.options.attachments.map((attachment) => attachment.block),
				]
				: text;
		} catch (error) {
			this.options.editor.setText(text);
			this.options.showNotice(errorText(error));
			return;
		}

		const uuid = randomUUID();
		const inlinePastes = this.options.keyboard.pendingInlinePastes();
		const message: SDKUserMessage = {
			type: "user",
			message: { role: "user", content: blocks },
			parent_tool_use_id: null,
			uuid,
			session_id: sessionId,
			origin: { kind: "human" },
			...(inlinePastes.length ? { inline_pastes: inlinePastes } : {}),
		};
		recordSubmittedInput(this.options.state, uuid);
		try {
			session.send(message);
			this.options.onPromptSubmitted();
			this.options.editor.addToHistory(text);
			this.options.attachments.length = 0;
			this.options.keyboard.clearInlinePastes();
			this.options.showNotice(undefined);
		} catch (error) {
			markInputsDeliveryUnknown(this.options.state, [uuid]);
			this.options.editor.setText(text);
			this.options.showNotice(`Could not submit prompt: ${errorText(error)}. Your draft is still in the composer.`);
		}
	}

	sendShellReceipt(
		receipt: ShellReceipt,
		preview: ShellPreview | undefined,
		command: string,
		cwd: string,
		sessionId: string,
	): void {
		const uuid = randomUUID();
		const bounded = {
			kind: "phi_local_shell_receipt",
			jobId: receipt.jobId,
			command: command.slice(0, 1_024),
			cwd: cwd.slice(0, 2_048),
			exitCode: receipt.exitCode,
			signal: receipt.signal,
			aborted: receipt.aborted,
			...(receipt.infrastructureError ? { infrastructureError: receipt.infrastructureError.slice(0, 2_048) } : {}),
			outputFiles: {
				...(receipt.outputFiles.stdout ? { stdout: receipt.outputFiles.stdout.slice(0, 2_048) } : {}),
				...(receipt.outputFiles.stderr ? { stderr: receipt.outputFiles.stderr.slice(0, 2_048) } : {}),
			},
			preview: {
				stdout: preview?.stdout.slice(0, 8_192) ?? "",
				stderr: preview?.stderr.slice(0, 8_192) ?? "",
				stdoutTruncated: preview?.stdoutTruncated ?? false,
				stderrTruncated: preview?.stderrTruncated ?? false,
			},
		};
		const message: SDKUserMessage = {
			type: "user",
			message: { role: "user", content: JSON.stringify(bounded) },
			parent_tool_use_id: null,
			uuid,
			session_id: sessionId,
			origin: { kind: "unclassified" },
			shouldQuery: false,
			client_composed: true,
		};
		recordSubmittedInput(this.options.state, uuid);
		try {
			const session = this.options.session();
			if (!session) throw new Error("The session is closed");
			session.send(message);
		} catch (error) {
			markInputsDeliveryUnknown(this.options.state, [uuid]);
			const outputPath = receipt.outputFiles.stdout ?? receipt.outputFiles.stderr ?? "the reported shell output path";
			this.options.showNotice(`Shell command finished, but receipt delivery is unknown. Output remains at ${outputPath}. ${errorText(error)}`);
		}
	}

}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
