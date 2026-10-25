import {
	CombinedAutocompleteProvider,
	Editor,
	TuiMainScreen,
	type ProgramStatus,
} from "@earendil-works/pi-tui";
import {
	type Query,
	type SDKControlInitializeResponse,
	type SDKMessage,
	type EffortLevel,
	type PermissionMode,
} from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { buildOptions, type LaunchOptions } from "../config.js";
import { dispatchLocalCommand, parseLocalCommand, type LocalCommand, type WorkflowSize } from "../commands.js";
import { InteractionQueue } from "../interactions.js";
import { startSession, type Session } from "../session.js";
import { createState, resetStateForProcess, type PhiState } from "../state.js";
import { AppAttachmentController } from "./app-attachments.js";
import { AppCommandPaletteController, type PaletteCommandChoice } from "./app-command-palette.js";
import { AppExitConfirmationController } from "./app-exit-confirmation.js";
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
import { formatErrorText } from "./error-text.js";

const SESSION_LOOKUP_PAGE_SIZE = 1_000;

export interface SessionControlSelections {
	model?: string;
	effort?: EffortLevel;
	permissionMode?: PermissionMode;
	ultracode?: boolean;
	workflowSize?: WorkflowSize;
}

type SessionTransition = Extract<LocalCommand, { kind: "new" | "resume" | "fork" }>;
interface PendingSessionTransition {
	key: string;
	expiresAt: number;
	launch: LaunchOptions;
	sessionId: string;
	cwdWarning?: string;
}

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
	private readonly commandPalette: AppCommandPaletteController;
	private readonly exitConfirmation: AppExitConfirmationController;
	private readonly keyboard: AppKeyboardController;
	private readonly dialogController: AppDialogController;
	private readonly submission: AppSubmissionController;
	private readonly exitPromise: Promise<number>;
	private resolveExit!: (code: number) => void;
	private runPromise: Promise<number> | undefined;
	private exitRequested = false;
	private closing = false;
	private exitCode = 0;
	private processGeneration = 0;
	private terminalStarted = false;
	private suspended = false;
	private notice: string | undefined;
	private sessionId: string | undefined;
	private lastCheckpointId: string | undefined;
	private reportedModelValueOverride: string | undefined;
	private sessionControlSelections: SessionControlSelections = {};
	private transitionTail: Promise<void> = Promise.resolve();
	private localCommandTail: Promise<void> = Promise.resolve();
	private pendingTransition: PendingSessionTransition | undefined;
	private sessionTransitionInProgress = false;
	private sessionError: string | undefined;
	private pendingRewindId: string | undefined;
	private userInteractionVersion = 0;
	private completedInteractionVersion = -1;
	private lastProgramStatus: string | undefined;
	private lastProgressState: boolean | undefined;
	private removeInputListener: (() => void) | undefined;
	private readonly signalListeners = new Map<NodeJS.Signals, () => void>();
	private draftRevision = 0;

	constructor(private launch: LaunchOptions, dependencies: Partial<AppDependencies> = {}) {
		this.dependencies = { ...createDefaultDependencies(launch.home), ...dependencies, configRoot: launch.home };
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
		this.commandPalette = new AppCommandPaletteController(
			tui,
			editor,
			(choice) => this.dispatchPaletteChoice(choice),
			(restoreDialog) => { if (restoreDialog) this.dialogController.reopen(); },
			() => this.render(),
		);
		this.exitConfirmation = new AppExitConfirmationController(
			tui,
			editor,
			() => { void this.close(0); },
			() => this.render(),
		);
		this.attachmentController = new AppAttachmentController({
			dependencies: this.dependencies,
			editor,
			draftRevision: () => this.draftRevision,
			sessionId: () => this.sessionId,
			processGeneration: () => this.processGeneration,
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
			() => this.processGeneration,
			launch.home,
		);
		this.keyboard = new AppKeyboardController(this.views, this.state, this.shell, this.attachmentController, {
			dialogVisible: () => this.dialogController.visible,
			handleDialogInput: (data) => this.dialogController.handleKey(data),
			exitConfirmationVisible: () => this.exitConfirmation.visible,
			handleExitConfirmationInput: (data) => this.exitConfirmation.handleInput(data),
			commandPaletteVisible: () => this.commandPalette.visible,
			handleCommandPaletteInput: (data) => this.commandPalette.handleInput(data),
			toggleCommandPalette: () => this.toggleCommandPalette(),
			openTranscriptInspector: () => this.openTranscriptInspector(),
			hideDialog: () => this.dialogController.hide(),
			leaveShellMode: () => this.shell.leave(),
			interruptForeground: () => { void this.interruptForeground(); },
			backgroundTasks: () => { void this.backgroundTasks(); },
			stopSelectedTask: () => { void this.stopSelectedTask(); },
			requestUserExit: () => this.requestUserExit(),
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
			isSessionTransitionInProgress: () => this.sessionTransitionInProgress,
			leaveShellMode: () => this.shell.leave(),
			dispatchLocalCommand: (command) => this.queueLocalCommand(command),
			onPromptSubmitted: () => this.notePromptSubmitted(),
			showNotice: (message) => this.showNotice(message),
		});
		editor.onChange = () => {
			this.draftRevision += 1;
			this.keyboard.editorChanged();
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

	get sessionControls(): Readonly<SessionControlSelections> {
		return this.sessionControlSelections;
	}

	get reportedModel(): string | undefined {
		return this.reportedModelValue();
	}

	get dangerousPermissionsEnabled(): boolean {
		return this.launch.dangerouslySkipPermissions;
	}

	get shellMode(): boolean {
		return this.shell.mode;
	}

	get shellCwdSnapshot(): string | undefined {
		return this.shell.cwdSnapshot;
	}

	get commandPaletteVisible(): boolean {
		return this.commandPalette.visible;
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

	requestUserExit(): void {
		const draft = this.views.editor.getExpandedText().trim().length > 0 || this.attachments.length > 0;
		const work = this.hasActiveWork();
		if (draft || work) {
			this.exitConfirmation.show({ draft, work });
			return;
		}
		void this.close(0);
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
		this.keyboard.clearInlinePastes();
		this.views.editor.setText(text);
	}

	submitPrompt(text: string): void {
		this.keyboard.clearInlinePastes();
		this.views.editor.setText(text);
		this.views.editor.setText("");
		this.submission.submit(text);
	}

	submitLiteral(text: string): void {
		this.submission.sendLiteral(text);
	}

	openShellMode(): void {
		this.shell.enter(this.state.cwd);
	}

	refreshWorkspace(cwd?: string): Promise<void> {
		return this.views.inspectors.refreshWorkspace(cwd);
	}

	async listSessions(options: Parameters<NonNullable<AppDependencies["listSessions"]>>[0]) {
		return this.views.inspectors.listSessions(options);
	}

	listProjectSessions(options: { limit?: number; offset?: number } = {}) {
		return this.views.inspectors.listProjectSessions(options);
	}

	listAllSessions(options: { limit?: number; offset?: number } = {}) {
		return this.views.inspectors.listAllSessions(options);
	}

	showNotice(message: string | undefined): void {
		this.notice = message === undefined ? undefined : this.formatDiagnostic(message);
		this.render();
	}

	private formatDiagnostic(value: unknown): string {
		return formatErrorText(value, this.dependencies.environment.ANTHROPIC_API_KEY);
	}

	private setSessionError(message: string | undefined): void {
		this.sessionError = message === undefined ? undefined : this.formatDiagnostic(message);
	}

	setSessionControl<K extends keyof SessionControlSelections>(key: K, value: SessionControlSelections[K]): void {
		this.sessionControlSelections = { ...this.sessionControlSelections, [key]: value };
	}

	setReportedModel(model: string): void {
		this.reportedModelValueOverride = model;
	}

	private queueLocalCommand(command: LocalCommand): void {
		if (command.kind === "attach") {
			// Capture the current draft and process generation before the next input event.
			void dispatchLocalCommand(command, this).catch((error: unknown) => {
				this.showNotice(`Could not run /phi ${command.kind}: ${errorText(error)}`);
			});
			return;
		}
		if (command.kind === "send") {
			// Let the transition guard see the literal input at submission time.
			void dispatchLocalCommand(command, this).catch((error: unknown) => {
				this.showNotice(`Could not run /phi ${command.kind}: ${errorText(error)}`);
			});
			return;
		}
		const operation = this.localCommandTail.then(() => dispatchLocalCommand(command, this));
		this.localCommandTail = operation.catch((error: unknown) => {
			this.showNotice(`Could not run /phi ${command.kind}: ${errorText(error)}`);
		});
	}

	private openTranscriptInspector(): void {
		if (this.commandPalette.visible) this.commandPalette.hide(false);
		if (this.dialogController.visible) this.dialogController.hide();
		this.showInspector("history");
		this.views.tui.setFocus(this.views.editor);
	}

	private dispatchPaletteChoice(choice: PaletteCommandChoice): void {
		if (choice.kind === "native") {
			this.submission.sendNativeCommand(choice.command);
			return;
		}
		const command = parseLocalCommand(choice.command);
		if (command) this.queueLocalCommand(command);
	}

	refreshNativeCommands(commands: SDKControlInitializeResponse["commands"]): void {
		if (this.ready) this.ready = { ...this.ready, commands };
		this.views.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(commands, this.state.cwd));
		this.commandPalette.setNativeCommands(commands);
	}

	openCommandPalette(): void {
		if (this.commandPalette.visible) return;
		const restoreDialog = this.dialogController.visible;
		if (restoreDialog) this.dialogController.hide();
		this.commandPalette.show(restoreDialog);
	}

	toggleCommandPalette(): void {
		if (this.commandPalette.visible) {
			this.commandPalette.hide();
			return;
		}
		this.openCommandPalette();
	}

	reopenQuestions(): void {
		this.dialogController.reopen();
	}

	showMcpStatus(statuses: unknown): void {
		this.dialogController.showMcpStatus(statuses);
	}

	loadImage(path: string, restoreDraft: string): void {
		this.attachmentController.loadImage(resolve(this.state.cwd, path), restoreDraft);
	}

	copySelectedOutput(): Promise<void> {
		return this.attachmentController.copySelectedOutput();
	}

	backgroundTasks(): Promise<void> {
		const query = this.query;
		if (!query) {
			this.showNotice("The SDK session is not ready.");
			return Promise.resolve();
		}
		const generation = this.processGeneration;
		return query.backgroundTasks().then((backgrounded) => {
			if (generation !== this.processGeneration) return;
			this.showNotice(backgrounded ? "Foreground tasks were backgrounded by the SDK." : "The SDK found no foreground task to background.");
		}).catch((error: unknown) => {
			if (generation === this.processGeneration) this.showNotice(`Could not background foreground work: ${errorText(error)}`);
		});
	}

	async stopSelectedTask(): Promise<void> {
		const taskId = this.views.inspectors.model.selectedTaskId;
		const task = taskId ? this.state.tasks.get(taskId) : undefined;
		const query = this.query;
		if (!taskId || !task || task.status !== "running" || !query) {
			this.showNotice("Select a running SDK task before requesting stop.");
			return;
		}
		const generation = this.processGeneration;
		try {
			await query.stopTask(taskId);
			if (generation === this.processGeneration) this.showNotice(`Stop requested for task ${taskId}.`);
		} catch (error) {
			if (generation === this.processGeneration) this.showNotice(`Could not stop task ${taskId}: ${errorText(error)}`);
		}
	}

	async interruptForeground(): Promise<void> {
		const query = this.query;
		if (!query) return;
		const generation = this.processGeneration;
		try {
			await query.interrupt();
			if (generation === this.processGeneration) this.showNotice("Foreground interruption was accepted by the SDK.");
		} catch (error) {
			if (generation === this.processGeneration) this.showNotice(`Could not interrupt foreground work: ${errorText(error)}`);
		}
	}

	replaceSession(command: SessionTransition): Promise<void> {
		const operation = this.transitionTail.then(() => this.replaceSessionNow(command));
		this.transitionTail = operation.catch(() => undefined);
		return operation;
	}

	async rewindFiles(): Promise<void> {
		const query = this.query;
		if (!query) throw new Error("The SDK session is not ready.");
		if (this.hasActiveWork()) {
			this.pendingRewindId = undefined;
			this.showNotice("File rewind requires an idle session. Stop or finish active tasks first.");
			return;
		}
		const checkpointId = this.lastCheckpointId;
		if (!checkpointId) {
			this.showNotice("No SDK user-message checkpoint has been captured in this session.");
			return;
		}
		const generation = this.processGeneration;
		let preview: Awaited<ReturnType<Query["rewindFiles"]>>;
		try {
			preview = await query.rewindFiles(checkpointId, { dryRun: true });
		} catch (error) {
			if (generation === this.processGeneration) {
				this.pendingRewindId = undefined;
				this.showNotice(`File rewind preview failed: ${errorText(error)}`);
			}
			return;
		}
		if (generation !== this.processGeneration) return;
		if (!preview.canRewind) {
			this.pendingRewindId = undefined;
			this.showNotice(`Files cannot be rewound to ${checkpointId}: ${preview.error ?? "the SDK did not approve the preview"}`);
			return;
		}
		if (this.hasActiveWork()) {
			this.pendingRewindId = undefined;
			this.showNotice("File rewind stopped because work became active during the SDK preview. Wait for an idle session and preview again.");
			return;
		}
		if (this.lastCheckpointId !== checkpointId) {
			this.pendingRewindId = undefined;
			this.showNotice("The latest SDK checkpoint changed during the rewind preview. Run /phi rewind again to preview the current checkpoint.");
			return;
		}
		const confirmed = this.pendingRewindId === checkpointId;
		if (!confirmed) {
			this.pendingRewindId = checkpointId;
			this.showNotice(`Fresh preview for ${checkpointId}: ${preview.filesChanged?.length ?? 0} tracked file(s), ${preview.insertions ?? 0} insertion(s), ${preview.deletions ?? 0} deletion(s). This changes files only; Git and shell effects are outside rewind. Run /phi rewind again to confirm.`);
			return;
		}
		this.pendingRewindId = undefined;
		let result: Awaited<ReturnType<Query["rewindFiles"]>>;
		try {
			result = await query.rewindFiles(checkpointId, { dryRun: false });
		} catch (error) {
			if (generation === this.processGeneration) this.showNotice(`File rewind failed: ${errorText(error)}`);
			return;
		}
		if (generation !== this.processGeneration) return;
		if (!result.canRewind) {
			this.showNotice(`File rewind failed: ${result.error ?? "the SDK did not complete the rewind"}${result.skippedLinks !== undefined ? `; skipped links: ${result.skippedLinks}` : ""}`);
			return;
		}
		this.showNotice(`Rewound ${result.filesChanged?.length ?? 0} tracked file(s) to ${checkpointId}${result.skippedLinks !== undefined ? `; skipped links: ${result.skippedLinks}` : ""}. Git and shell effects were not changed.`);
	}

	private async runInternal(): Promise<number> {
		if (!this.dependencies.isInteractive()) return 2;
		let result = 0;
		try {
			this.startTerminal();
			this.registerSignals();
			const lookupReader = this.launch.continue && !this.dependencies.listSessions
				? this.dependencies.createHistoryReader(this.launch.home)
				: undefined;
			try {
				this.launch = await this.dependencies.resolveLaunchOptions(
					this.launch,
					this.dependencies.listSessions ?? (lookupReader
						? (options) => lookupReader.list(options)
						: async () => []),
				);
			} finally {
				await lookupReader?.close();
			}
			if (!this.exitRequested) {
				this.resetSessionControls(this.launch);
				const generation = ++this.processGeneration;
				await this.openSession(this.launch, generation, false);
				if (!this.exitRequested) void this.refreshWorkspace(this.state.cwd);
				result = await this.exitPromise;
			} else {
				result = this.exitCode;
			}
		} catch (error) {
			this.showNotice(`Could not start Phi: ${errorText(error)}`);
			this.views.tui.renderNow();
			result = this.exitRequested ? this.exitCode : 1;
		} finally {
			const cleanupErrors = await this.cleanup();
			if (cleanupErrors.length > 0 && result === 0) result = 1;
		}
		return result;
	}

	private async openSession(launch: LaunchOptions, generation: number, replacement: boolean): Promise<void> {
		const isCurrent = (): boolean => generation === this.processGeneration && !this.exitRequested && !this.closing;
		if (!isCurrent()) return;
		const observer = new AppSessionObserver(
			this.state,
			this.interactions,
			this.views.inspectors,
			() => this.dialogController.sync(),
			(sessionId) => { if (isCurrent()) this.sessionId = sessionId; },
			() => this.render(),
			(message) => this.showNotice(message),
			() => this.closing,
			isCurrent,
			(commands) => this.refreshNativeCommands(commands),
			() => this.refreshNativeCommands(this.ready?.commands ?? []),
			(uuid) => { this.lastCheckpointId = uuid; },
			() => { this.completedInteractionVersion = this.userInteractionVersion; this.setSessionError(undefined); },
			(message) => { this.setSessionError(message); },
			(error) => this.formatDiagnostic(error),
		);
		const callbacks = observer.callbacks();
		const options = buildOptions(launch, {
			canUseTool: callbacks.canUseTool,
			onElicitation: callbacks.onElicitation,
			hooks: callbacks.hooks,
		}, this.dependencies.environment);
		this.sessionId = launch.sessionId ?? launch.resume ?? options.sessionId;
		this.views.inspectors.setSession(this.sessionId ?? "", generation, launch.cwd, true);
		this.session = startSession(options, callbacks, this.dependencies.createQuery);
		const session = this.session;
		this.ready = undefined;
		this.setSessionError(undefined);
		this.pendingRewindId = undefined;
		void session.done.then(
			() => {
				if (!isCurrent()) return;
				if (replacement) {
					this.session = undefined;
					this.ready = undefined;
					this.setSessionError("The SDK output stream ended.");
					this.showNotice(`Session ${this.sessionId ?? "unknown"} ended.`);
				} else {
					this.requestExit(0);
				}
			},
			(error: unknown) => {
				if (!isCurrent()) return;
				const detail = `Session ended with an error: ${errorText(error)}`;
				this.setSessionError(detail);
				if (replacement) {
					this.session = undefined;
					this.ready = undefined;
				}
				try {
					this.showNotice(detail);
					this.views.tui.renderNow();
				} catch (renderError) {
					this.setSessionError(`${detail}; terminal diagnostic rendering failed: ${errorText(renderError)}`);
					if (replacement) this.requestExit(1);
				}
				if (!replacement) this.requestExit(1);
			},
		);
		try {
			const ready = await Promise.race([
				session.ready,
				this.exitPromise.then(() => undefined),
			]);
			if (!ready) return;
			if (!isCurrent()) return;
			this.ready = ready;
			this.refreshNativeCommands(ready.commands);
			if (ready.hooks_applied === false) this.showNotice("The SDK did not apply this session's hooks.");
			if (ready.plugins_applied === false) this.showNotice("The SDK did not load every requested plugin.");
			try {
				const statuses = await session.query.mcpServerStatus();
				if (isCurrent()) this.dialogController.showMcpStatus(statuses);
			} catch (error) {
				if (isCurrent()) this.showNotice(`MCP status is unavailable: ${errorText(error)}`);
			}
		} catch (error) {
			if (isCurrent()) {
				this.setSessionError(`Could not open session ${this.sessionId ?? "unknown"}: ${errorText(error)}`);
				this.showNotice(this.sessionError);
			}
			if (replacement) {
				try {
					await session.close();
					if (isCurrent()) this.session = undefined;
				} catch (closeError) {
					if (isCurrent()) {
						this.setSessionError(`Could not open session ${this.sessionId ?? "unknown"}: ${errorText(error)}. Query cleanup failed: ${errorText(closeError)}`);
						this.showNotice(this.sessionError);
					}
				}
			}
			throw error;
		}
	}

	private async replaceSessionNow(command: SessionTransition): Promise<void> {
		let generation = this.processGeneration;
		const isCurrent = (): boolean => generation === this.processGeneration && !this.exitRequested && !this.closing;
		if (!isCurrent()) return;
		let target: PendingSessionTransition | undefined;
		const key = command.kind === "resume" ? `resume:${command.sessionId}` : command.kind;
		if (this.pendingTransition?.key === key && this.pendingTransition.expiresAt >= Date.now()) {
			target = this.pendingTransition;
		} else {
			target = await this.createSessionTarget(command, key, isCurrent);
		}
		if (!target || !isCurrent()) return;
		const confirmed = this.pendingTransition?.key === key && this.pendingTransition.expiresAt >= Date.now();
		this.pendingTransition = undefined;
		if (this.hasActiveWork() && !confirmed) {
			this.pendingTransition = { ...target, expiresAt: Date.now() + 30_000 };
			this.showNotice(`Active SDK or local work must stop before this session switch. Run ${this.transitionCommand(command)} again within 30 seconds to confirm stop-and-switch.`);
			return;
		}

		this.sessionTransitionInProgress = true;
		try {
			const oldSession = this.session;
			const oldQuery = oldSession?.query;
			if (oldQuery) {
				try {
					if (this.state.effectiveStatus.foreground === "running") {
						await oldQuery.interrupt();
						if (!isCurrent()) return;
					}
					for (const taskId of this.tasksToStopBeforeSwitch()) {
						await oldQuery.stopTask(taskId);
						if (!isCurrent()) return;
					}
				} catch (error) {
					if (isCurrent()) this.showNotice(`Could not stop current SDK work; ${target.sessionId} was not opened: ${errorText(error)}`);
					return;
				}
			}

			this.interactions.cancelPending("Session switch requested");
			generation = ++this.processGeneration;
			this.views.inspectors.setSession(this.sessionId ?? "", generation, this.state.cwd);
			await this.shell.stop();
			if (!isCurrent()) return;
			this.shell.leave();
			try {
				await oldSession?.close();
			} catch (error) {
				if (!isCurrent()) return;
				if (this.session === oldSession) this.session = undefined;
				this.ready = undefined;
				this.setSessionError(`Could not close the current SDK query; ${target.sessionId} was not opened: ${errorText(error)}`);
				this.showNotice(this.sessionError);
				return;
			}
			if (!isCurrent()) return;
			if (this.session === oldSession) this.session = undefined;
			this.ready = undefined;
			this.setSessionError(undefined);
			this.lastCheckpointId = undefined;
			this.reportedModelValueOverride = undefined;
			this.state.cwd = target.launch.cwd;
			resetStateForProcess(this.state, target.launch.cwd);
			this.sessionId = target.sessionId;
			this.launch = target.launch;
			this.resetSessionControls(target.launch);
			this.userInteractionVersion = 0;
			this.completedInteractionVersion = -1;
			this.pendingRewindId = undefined;
			this.showNotice(target.cwdWarning
				? `Opening session ${target.sessionId} with working directory ${target.launch.cwd}. ${target.cwdWarning}`
				: `Opening session ${target.sessionId}.`);
			try {
				await this.openSession(target.launch, generation, true);
				if (!this.exitRequested && generation === this.processGeneration) void this.refreshWorkspace(target.launch.cwd);
			} catch (error) {
				if (generation === this.processGeneration && !this.sessionError) {
					this.setSessionError(`Could not open session ${target.sessionId}: ${errorText(error)}`);
					this.showNotice(this.sessionError);
				}
			}
		} finally {
			this.sessionTransitionInProgress = false;
		}
	}

	private async createSessionTarget(
		command: SessionTransition,
		key: string,
		isCurrent: () => boolean,
	): Promise<PendingSessionTransition | undefined> {
		if (!isCurrent()) return undefined;
		if (command.kind === "new") {
			const sessionId = randomUUID();
			return {
				key,
				expiresAt: Date.now() + 30_000,
				sessionId,
				launch: { ...this.launch, cwd: this.state.cwd, resume: undefined, forkSession: false, sessionId, continue: false },
			};
		}
		if (command.kind === "fork") {
			if (!this.sessionId) throw new Error("There is no current SDK session to fork.");
			const sessionId = randomUUID();
			return {
				key,
				expiresAt: Date.now() + 30_000,
				sessionId,
				launch: { ...this.launch, cwd: this.state.cwd, resume: this.sessionId, forkSession: true, sessionId, continue: false },
			};
		}
		let sessionCwd = this.launch.cwd;
		let cwdWarning: string | undefined;
		try {
			let offset = 0;
			let sessionFound = false;
			let sessionCwdFound = false;
			for (;;) {
				if (!isCurrent()) return undefined;
				const sessions = await this.listAllSessions({ limit: SESSION_LOOKUP_PAGE_SIZE, offset });
				if (!isCurrent()) return undefined;
				const session = sessions.find((candidate) => candidate.sessionId === command.sessionId);
				if (session) {
					sessionFound = true;
					if (session.cwd) {
						sessionCwd = session.cwd;
						sessionCwdFound = true;
					}
					break;
				}
				if (sessions.length < SESSION_LOOKUP_PAGE_SIZE) break;
				offset += sessions.length;
			}
			if (sessionFound && !sessionCwdFound) {
				cwdWarning = `Local history did not report a working directory for ${command.sessionId}; this resume uses the current directory.`;
			} else if (!sessionFound) {
				cwdWarning = `Local history did not contain ${command.sessionId}; this resume uses the current directory.`;
			}
		} catch (error) {
			if (!isCurrent()) return undefined;
			cwdWarning = `Local session metadata could not be read (${this.formatDiagnostic(error)}); this resume uses the current directory.`;
		}
		if (!isCurrent()) return undefined;
		return {
			key,
			expiresAt: Date.now() + 30_000,
			sessionId: command.sessionId,
			...(cwdWarning ? { cwdWarning } : {}),
			launch: { ...this.launch, cwd: sessionCwd, resume: command.sessionId, forkSession: false, sessionId: undefined, continue: false },
		};
	}

	private transitionCommand(command: SessionTransition): string {
		if (command.kind === "resume") return `/phi resume ${command.sessionId}`;
		return `/phi ${command.kind}`;
	}

	private hasActiveWork(): boolean {
		return this.shell.running
			|| this.interactions.pending.length > 0
			|| this.state.effectiveStatus.foreground === "running"
			|| this.state.liveBackgroundTaskIds.size > 0
			|| [...this.state.tasks.values()].some((task) => task.status === "running");
	}

	private tasksToStopBeforeSwitch(): string[] {
		const ids = new Set(this.state.liveBackgroundTaskIds);
		for (const task of this.state.tasks.values()) {
			if (task.status === "running" && (task.ambient || task.isBackgrounded)) ids.add(task.taskId);
		}
		return [...ids];
	}

	private resetSessionControls(launch: LaunchOptions): void {
		this.sessionControlSelections = {
			...(launch.model ? { model: launch.model } : {}),
			...(launch.effort ? { effort: launch.effort } : {}),
			...(launch.permissionMode ? { permissionMode: launch.permissionMode } : {}),
		};
	}

	private reportedModelValue(): string | undefined {
		if (this.reportedModelValueOverride) return this.reportedModelValueOverride;
		const models = this.state.usage?.modelUsage;
		return models ? Object.keys(models).at(-1) : undefined;
	}

	private notePromptSubmitted(): void {
		this.userInteractionVersion += 1;
		this.setSessionError(undefined);
	}

	private startTerminal(): void {
		this.removeInputListener?.();
		this.terminalStarted = true;
		this.keyboard.beginStartupTerminalReplyCapture();
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
		const runningTask = [...this.state.tasks.values()].some((task) => task.status === "running" && !task.ambient);
		const taskFailed = [...this.state.tasks.values()].some((task) => task.status === "failed");
		const working = this.shell.running || this.state.effectiveStatus.foreground === "running" || runningTask;
		const completed = this.userInteractionVersion > 0 && this.completedInteractionVersion === this.userInteractionVersion;
		const status: ProgramStatus = pending
			? { state: "blocked", app: "phi", ...(kind ? { kind } : {}), message: pending.kind }
			: this.sessionError || taskFailed
				? { state: "error" as const, app: "phi", message: "session error" }
				: working
					? { state: "working" as const, app: "phi", message: this.shellMode ? "local shell" : "session" }
					: completed
						? { state: "done" as const, app: "phi" }
						: { state: "idle" as const, app: "phi" };
		const signature = JSON.stringify(status);
		if (signature !== this.lastProgramStatus) {
			this.dependencies.terminal.setProgramStatus(status);
			this.lastProgramStatus = signature;
		}
		const progress = status.state === "working";
		if (progress !== this.lastProgressState) {
			this.dependencies.terminal.setProgress(progress);
			this.lastProgressState = progress;
		}
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

	private async cleanup(): Promise<string[]> {
		if (this.closing) return [];
		this.closing = true;
		this.keyboard.endStartupTerminalReplyCapture();
		this.processGeneration += 1;
		this.removeInputListener?.();
		this.removeInputListener = undefined;
		for (const [signal, listener] of this.signalListeners) this.dependencies.signals.off(signal, listener);
		this.signalListeners.clear();
		this.interactions.cancelAll("Phi is shutting down");
		const errors: string[] = [];
		try {
			await this.session?.close();
		} catch (error) {
			errors.push(`SDK query: ${errorText(error)}`);
		}
		try {
			await this.shell.close();
		} catch (error) {
			errors.push(`local shell: ${errorText(error)}`);
		}
		try {
			await this.views.inspectors.close();
		} catch (error) {
			errors.push(`history and polling: ${errorText(error)}`);
		}
		try {
			await this.attachmentController.close();
		} catch (error) {
			errors.push(`attachment operations: ${errorText(error)}`);
		}
		if (errors.length > 0) {
			try {
				this.showNotice(`Cleanup failed: ${errors.join("; ")}`);
			} catch (error) {
				errors.push(`diagnostic rendering: ${errorText(error)}`);
			}
		}
		if (this.terminalStarted || this.suspended) {
			this.terminalStarted = false;
			this.suspended = false;
			try {
				this.dependencies.terminal.setProgramStatus({ state: "clear" });
				this.dependencies.terminal.setProgress(false);
				this.views.tui.stop();
			} catch (error) {
				errors.push(`terminal UI: ${errorText(error)}`);
				try {
					this.dependencies.terminal.stop();
				} catch (fallbackError) {
					errors.push(`terminal restore: ${errorText(fallbackError)}`);
				}
			}
		}
		return errors;
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
