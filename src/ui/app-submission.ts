import { randomUUID } from "node:crypto";
import type { Editor } from "@earendil-works/pi-tui";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { assertAttachmentTotalWithinLimit, type ImageAttachment } from "../attachments.js";
import type { Session } from "../session.js";
import type { ShellPreview, ShellReceipt } from "../shell.js";
import { markInputsDeliveryUnknown, recordSubmittedInput, type PhiState } from "../state.js";
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
	leaveShellMode(): void;
	refreshWorkspace(cwd: string): void;
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
		if (content === "/phi" || content.startsWith("/phi ")) {
			this.options.keyboard.clearInlinePastes();
			this.dispatchLocalCommand(content);
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
					...(content ? [{ type: "text" as const, text: content }] : []),
					...this.options.attachments.map((attachment) => attachment.block),
				]
				: content;
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
			this.options.editor.addToHistory(content);
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

	private dispatchLocalCommand(line: string): void {
		const [name = "help", ...args] = line.trim().slice(4).trim().split(/\s+/u);
		if (name === "help") {
			this.options.showNotice("Local Phi: /phi help, /phi shell, /phi attach <image path>, /phi refresh. Ctrl+T tasks, Ctrl+R history, Ctrl+W workspace, Ctrl+O reopens a pending dialog. SDK slash commands and @ mentions pass through unchanged.");
		} else if (name === "shell" && args.length === 0) {
			this.options.shell.enter(this.options.state.cwd);
		} else if (name === "attach" && args.length > 0) {
			const path = line.trim().slice(line.trim().indexOf("attach") + "attach".length).trim().replace(/^(?:"(.*)"|'(.*)')$/u, (_match, doubleQuoted: string, singleQuoted: string) => doubleQuoted ?? singleQuoted ?? "");
			this.options.attachmentController.loadImage(path, line);
		} else if (name === "refresh" && args.length === 0) {
			this.options.refreshWorkspace(this.options.state.cwd);
			this.options.showNotice("Refreshing Git status.");
		} else {
			this.options.showNotice("Unknown local command. Use /phi help. This input was not sent to the model.");
		}
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
