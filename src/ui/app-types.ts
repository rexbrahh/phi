import { spawn } from "node:child_process";
import { query as sdkQuery, type ListSessionsOptions, type SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import {
	copyText,
	loadImage,
	readClipboardImage,
	type ImageAttachment,
} from "../attachments.js";
import { editPrompt } from "../prompt-editor.js";
import { resolveLaunchOptions } from "../config.js";
import { createHistoryReader, type HistoryReader } from "../history.js";
import { readWorkflowJournal, type JournalCursor, type JournalPage, type WorkflowReference } from "../workflows.js";
import { readWorkspace, type WorkspaceInfo } from "../workspace.js";
import { runUserShell, type ShellJob, type ShellPreview } from "../shell.js";
import { ProcessTerminal, type Terminal } from "@earendil-works/pi-tui";

export interface SignalSource {
	on(signal: NodeJS.Signals, listener: () => void): unknown;
	off(signal: NodeJS.Signals, listener: () => void): unknown;
}

export interface AppDependencies {
	createQuery: typeof sdkQuery;
	editPrompt: typeof editPrompt;
	terminal: Terminal;
	readClipboardImage(signal?: AbortSignal): Promise<ImageAttachment | null>;
	copyText(text: string, signal?: AbortSignal): Promise<void>;
	loadImage(path: string, signal?: AbortSignal): Promise<ImageAttachment>;
	createHistoryReader(configRoot?: string): HistoryReader;
	readWorkflowJournal(reference: WorkflowReference, cursor?: JournalCursor): Promise<JournalPage>;
	readWorkspace(cwd: string): Promise<WorkspaceInfo>;
	runUserShell(
		command: string,
		cwd: string,
		sessionId: string,
		signal: AbortSignal,
		onUpdate: (preview: ShellPreview) => void,
		home?: string,
	): ShellJob;
	resolveLaunchOptions: typeof resolveLaunchOptions;
	listSessions?(options: ListSessionsOptions): Promise<SDKSessionInfo[]>;
	isInteractive(): boolean;
	signals: SignalSource;
	suspendProcess(): void;
	openUrl(url: string): void;
	configRoot: string;
	environment: NodeJS.ProcessEnv;
}

export function createDefaultDependencies(home: string): AppDependencies {
	return {
		createQuery: sdkQuery,
		editPrompt,
		terminal: new ProcessTerminal(),
		readClipboardImage,
		copyText,
		loadImage,
		createHistoryReader: (configRoot) => createHistoryReader({ configRoot }),
		readWorkflowJournal,
		readWorkspace,
		runUserShell,
		resolveLaunchOptions,
		environment: process.env,
		isInteractive: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
		signals: {
			on: (signal, listener) => process.on(signal, listener),
			off: (signal, listener) => process.off(signal, listener),
		},
		suspendProcess: () => {
			if (process.platform !== "win32") process.kill(process.pid, "SIGTSTP");
		},
		openUrl: openExternalUrl,
		configRoot: home,
	};
}

function openExternalUrl(url: string): void {
	const executable = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
	const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
	const child = spawn(executable, args, { detached: true, stdio: "ignore" });
	child.once("error", () => undefined);
	child.unref();
}
