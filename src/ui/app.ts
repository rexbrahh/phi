import {
	CombinedAutocompleteProvider,
	Editor,
	TuiMainScreen,
	type ProgramStatus,
} from "@earendil-works/pi-tui";
import {
	type Query,
	type SDKControlInitializeResponse,
} from "@anthropic-ai/claude-agent-sdk";
import { buildOptions, type LaunchOptions } from "../config.js";
import { InteractionQueue } from "../interactions.js";
import { startSession, type Session } from "../session.js";
import { createState, type PhiState } from "../state.js";
import { AppAttachmentController } from "./app-attachments.js";
import { AppKeyboardController } from "./app-keyboard.js";
import { AppDialogController } from "./app-dialogs.js";
import { AppInspectorController } from "./app-inspectors.js";
import { AppShellController } from "./app-shell.js";
import { AppSessionObserver } from "./app-session-observer.js";
import { AppSubmissionController } from "./app-submission.js";
import { createDefaultDependencies, type AppDependencies } from "./app-types.js";
export type { AppDependencies } from "./app-types.js";
import { MainScreen } from "./app-screen.js";
import { editorTheme, theme } from "./theme.js";
import { TranscriptView } from "./transcript.js";
import type { InspectorPanel } from "./inspectors.js";

export interface AppViews {
	tui: TuiMainScreen;
	screen: MainScreen;
	editor: Editor;
	transcript: TranscriptView;
	dialogs: AppDialogController["view"];
	inspectors: AppInspectorController;
	readonly active: InspectorPanel | "transcript";
}

class ControllerViews implements AppViews {
	constructor(
		readonly tui: TuiMainScreen,
		readonly screen: MainScreen,
		readonly editor: Editor,
		readonly transcript: TranscriptView,
		readonly dialogs: AppDialogController["view"],
		readonly inspectors: AppInspectorController,
	) {}

	get active(): InspectorPanel | "transcript" {
		return this.inspectors.model.panel ?? "transcript";
	}
}

export class AppController {
	readonly state: PhiState;
	readonly interactions = new InteractionQueue();
	readonly views: AppViews;
	readonly attachments: AppAttachmentController["attachments"];
	session: Session | undefined;
	ready: SDKControlInitializeResponse | undefined;

	private readonly dependencies: AppDependencies;
	private readonly shell: AppShellController;
	private readonly attachmentController: AppAttachmentController;
	private readonly keyboard: AppKeyboardController;
	private readonly dialogController: AppDialogController;
	private readonly submission: AppSubmissionController;
	private readonly exitPromise: Promise<number>;
	private resolveExit!: (code: number) => void;
	private runPromise: Promise<number> | undefined;
	private exitRequested = false;
	private closing = false;
	private exitCode = 0;
	private terminalStarted = false;
	private suspended = false;
	private notice: string | undefined;
	private sessionId: string | undefined;
	private removeInputListener: (() => void) | undefined;
	private readonly signalListeners = new Map<NodeJS.Signals, () => void>();
	private draftRevision = 0;

	constructor(private readonly launch: LaunchOptions, dependencies: Partial<AppDependencies> = {}) {
		this.dependencies = { ...createDefaultDependencies(), ...dependencies };
		this.state = createState(launch.cwd);
		this.exitPromise = new Promise((resolve) => {
			this.resolveExit = resolve;
		});
		const tui = new TuiMainScreen(this.dependencies.terminal);
		const editor = new Editor(tui, editorTheme);
		const transcript = new TranscriptView(this.state);
		const inspectors = new AppInspectorController(this.state, launch.cwd, this.dependencies, () => this.render());
		const screen = new MainScreen(tui, this.state, transcript, inspectors.view, editor);
		const dialogController = new AppDialogController(
			tui,
			editor,
			this.interactions,
			this.dependencies.openUrl,
			(message) => this.showNotice(message),
			() => this.render(),
		);
		const dialogs = dialogController.view;
		tui.addChild(screen.root);
		tui.setFocus(editor);
		this.views = new ControllerViews(tui, screen, editor, transcript, dialogs, inspectors);
		this.dialogController = dialogController;
		this.attachmentController = new AppAttachmentController({
			dependencies: this.dependencies,
			editor,
			draftRevision: () => this.draftRevision,
			sessionId: () => this.sessionId,
			selectedOutput: () => this.views.inspectors.selectedOutput(),
			isClosing: () => this.closing,
			showNotice: (message) => this.showNotice(message),
		});
		this.attachments = this.attachmentController.attachments;
		this.shell = new AppShellController(
			this.dependencies.runUserShell,
			() => this.render(),
			(message) => this.showNotice(message),
			(receipt, preview, command, cwd, sessionId) => this.submission.sendShellReceipt(receipt, preview, command, cwd, sessionId),
		);
		this.keyboard = new AppKeyboardController(this.views, this.state, this.shell, this.attachmentController, {
			dialogVisible: () => this.dialogController.visible,
			handleDialogInput: (data) => this.dialogController.handleKey(data),
			hideDialog: () => this.dialogController.hide(),
			reopenDialog: () => this.dialogController.reopen(),
			leaveShellMode: () => this.shell.leave(),
			interruptForeground: () => {
				void this.query?.interrupt().catch((error: unknown) => this.showNotice(`Could not interrupt the current turn: ${errorText(error)}`));
			},
			close: () => void this.close(0),
			suspendTerminal: () => this.suspendTerminal(),
			refreshWorkspace: () => void this.refreshWorkspace(this.state.cwd),
			showInspector: (panel) => this.showInspector(panel),
			searchLoadedHistory: (query) => this.searchLoadedHistory(query),
			selectTask: (taskId) => void this.selectTask(taskId),
			selectChild: (agentId) => void this.selectChild(agentId),
			render: () => this.render(),
		});
		this.submission = new AppSubmissionController({
			state: this.state,
			editor,
			attachments: this.attachments,
			attachmentController: this.attachmentController,
			keyboard: this.keyboard,
			shell: this.shell,
			session: () => this.session,
			sessionId: () => this.sessionId,
			leaveShellMode: () => this.shell.leave(),
			refreshWorkspace: (cwd) => { void this.refreshWorkspace(cwd); },
			showNotice: (message) => this.showNotice(message),
		});
		editor.onChange = () => {
			this.draftRevision += 1;
			this.render();
		};
		editor.onSubmit = (text) => this.submission.submit(text);
	}

	get query(): Query | undefined {
		return this.session?.query;
	}

	get currentSessionId(): string | undefined {
		return this.sessionId;
	}

	get shellMode(): boolean {
		return this.shell.mode;
	}

	get shellCwdSnapshot(): string | undefined {
		return this.shell.cwdSnapshot;
	}

	run(): Promise<number> {
		if (this.runPromise) return this.runPromise;
		this.runPromise = this.runInternal();
		return this.runPromise;
	}

	close(exitCode = 0): Promise<void> {
		this.requestExit(exitCode);
		return this.runPromise?.then(() => undefined) ?? Promise.resolve();
	}

	showInspector(panel: InspectorPanel | null): void {
		this.views.inspectors.show(panel);
	}

	selectTask(taskId: string): Promise<void> {
		return this.views.inspectors.selectTask(taskId);
	}

	selectChild(agentId: string): Promise<void> {
		return this.views.inspectors.selectChild(agentId);
	}

	searchLoadedHistory(query: string): void {
		this.views.inspectors.searchLoadedHistory(query);
	}

	setDraft(text: string): void {
		this.views.editor.setText(text);
	}

	submitPrompt(text: string): void {
		this.views.editor.setText(text);
		this.views.editor.setText("");
		this.submission.submit(text);
	}

	openShellMode(): void {
		this.shell.enter(this.state.cwd);
	}

	refreshWorkspace(cwd?: string): Promise<void> {
		return this.views.inspectors.refreshWorkspace(cwd);
	}

	async listSessions(options: Parameters<AppDependencies["listSessions"]>[0]) {
		return this.views.inspectors.listSessions(options);
	}

	listProjectSessions(options: { limit?: number; offset?: number } = {}) {
		return this.views.inspectors.listProjectSessions(options);
	}

	listAllSessions(options: { limit?: number; offset?: number } = {}) {
		return this.views.inspectors.listAllSessions(options);
	}

	private async runInternal(): Promise<number> {
		if (!this.dependencies.isInteractive()) return 2;
		try {
			this.startTerminal();
			this.registerSignals();
			const launch = await this.dependencies.resolveLaunchOptions(
				this.launch,
				this.dependencies.listSessions,
			);
			if (this.exitRequested) return await this.exitPromise;
			void this.refreshWorkspace(launch.cwd);
			const observer = new AppSessionObserver(
				this.state,
				this.interactions,
				this.views.inspectors,
				() => this.dialogController.sync(),
				(sessionId) => { this.sessionId = sessionId; },
				() => this.render(),
				(message) => this.showNotice(message),
				() => this.closing,
			);
			const callbacks = observer.callbacks();
			const options = buildOptions(launch, {
				canUseTool: callbacks.canUseTool,
				onElicitation: callbacks.onElicitation,
				hooks: callbacks.hooks,
			});
			this.sessionId = launch.resume ?? options.sessionId;
			if (this.sessionId) this.views.inspectors.setSession(this.sessionId);
			this.session = startSession(options, callbacks, this.dependencies.createQuery);
			void this.session.done.then(
				() => this.requestExit(0),
				(error: unknown) => {
					this.showNotice(`Session ended with an error: ${errorText(error)}`);
					this.requestExit(1);
				},
			);
			const ready = await Promise.race([
				this.session.ready,
				this.exitPromise.then(() => undefined),
			]);
			if (!ready) return await this.exitPromise;
			this.ready = ready;
			this.views.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(ready.commands, launch.cwd));
			if (ready.hooks_applied === false) this.showNotice("The SDK did not apply this session's hooks.");
			if (ready.plugins_applied === false) this.showNotice("The SDK did not load every requested plugin.");
			try {
				const statuses = await this.session.query.mcpServerStatus();
				this.dialogController.showMcpStatus(statuses);
			} catch (error) {
				this.showNotice(`MCP status is unavailable: ${errorText(error)}`);
			}
			return await this.exitPromise;
		} catch (error) {
			this.showNotice(`Could not start Phi: ${errorText(error)}`);
			return this.exitRequested ? this.exitCode : 1;
		} finally {
			await this.cleanup();
		}
	}

	private startTerminal(): void {
		this.removeInputListener?.();
		this.terminalStarted = true;
		this.views.tui.start();
		this.removeInputListener = this.views.tui.addInputListener((data) => this.keyboard.onInput(data));
		this.render();
	}

	private registerSignals(): void {
		const bindings: Array<[NodeJS.Signals, () => void]> = [
			["SIGINT", () => this.requestExit(130)],
			["SIGTERM", () => this.requestExit(143)],
			["SIGCONT", () => this.resumeTerminal()],
		];
		for (const [signal, listener] of bindings) {
			this.signalListeners.set(signal, listener);
			this.dependencies.signals.on(signal, listener);
		}
	}

	private showNotice(message: string | undefined): void {
		this.notice = message;
		this.render();
	}

	private render(): void {
		if (!this.views) return;
		const shell = this.shell.screenState();
		this.views.screen.update({
			workspace: this.views.inspectors.model.workspace,
			notice: this.notice,
			shellMode: shell.mode,
			shellCwd: shell.cwdSnapshot,
			shellPreview: shell.preview,
			shellJob: shell.job,
			attachments: this.attachments,
		});
		this.updateProgramStatus();
	}

	private updateProgramStatus(): void {
		const pending = this.interactions.pending[0];
		const kind: ProgramStatus["kind"] = pending?.kind === "permission" ? "permission" : pending ? "question" : undefined;
		const status: ProgramStatus = pending
			? { state: "blocked", app: "phi", ...(kind ? { kind } : {}), message: pending.kind }
			: this.shell.running || this.state.effectiveStatus.foreground === "running"
				? { state: "working" as const, app: "phi", message: this.shellMode ? "local shell" : "session" }
				: { state: "idle" as const, app: "phi" };
		this.dependencies.terminal.setProgramStatus(status);
		this.dependencies.terminal.setProgress(Boolean(this.shell.running || this.state.effectiveStatus.foreground === "running"));
	}

	private requestExit(code: number): void {
		if (this.exitRequested) return;
		this.exitRequested = true;
		this.exitCode = code;
		this.resolveExit(code);
	}

	private suspendTerminal(): void {
		if (!this.terminalStarted || process.platform === "win32") return;
		this.suspended = true;
		this.terminalStarted = false;
		this.views.tui.stop({ preserveScreen: true });
		this.dependencies.suspendProcess();
		if (this.suspended) this.resumeTerminal();
	}

	private resumeTerminal(): void {
		if (!this.suspended || this.closing) return;
		this.suspended = false;
		this.startTerminal();
	}

	private async cleanup(): Promise<void> {
		if (this.closing) return;
		this.closing = true;
		this.removeInputListener?.();
		this.removeInputListener = undefined;
		for (const [signal, listener] of this.signalListeners) this.dependencies.signals.off(signal, listener);
		this.signalListeners.clear();
		await this.views.inspectors.close().catch(() => undefined);
		await this.session?.close().catch(() => undefined);
		await this.shell.close();
		await this.attachmentController.close();
		if (this.terminalStarted || this.suspended) {
			this.terminalStarted = false;
			this.suspended = false;
			try {
				this.views.tui.stop();
			} catch {
				this.dependencies.terminal.stop();
			}
		}
	}
}

export async function runApp(launch: LaunchOptions, dependencies?: Partial<AppDependencies>): Promise<number> {
	const isInteractive = dependencies?.isInteractive ?? (() => Boolean(process.stdin.isTTY && process.stdout.isTTY));
	if (!isInteractive()) return 2;
	const controller = new AppController(launch, dependencies);
	return controller.run();
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
