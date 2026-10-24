import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { PhiState } from "../state.js";
import type { HistoryReader } from "../history.js";
import type { JournalCursor, JournalPage, WorkflowReference, WorkflowJournalRecord } from "../workflows.js";
import type { AppDependencies } from "./app-types.js";
import { createInspectorModel, getHistoryMessageSearchText, getHistoryMessageText, InspectorView, type InspectorPanel } from "./inspectors.js";

const HISTORY_PAGE_SIZE = 200;

export class AppInspectorController {
	readonly model = createInspectorModel();
	readonly view: InspectorView;
	private reader: HistoryReader | undefined;
	private sessionId: string | undefined;
	private readonly workflowReferences = new Map<string, WorkflowReference>();
	private readonly workflowCursors = new Map<string, JournalCursor>();
	private readonly workflowRecords = new Map<string, Map<string, WorkflowJournalRecord>>();
	private workflowTimer: ReturnType<typeof setInterval> | undefined;
	private workflowPollActive = false;
	private historyGeneration = 0;
	private workspaceGeneration = 0;
	private workflowGeneration = 0;
	private workspaceRefreshTimer: ReturnType<typeof setTimeout> | undefined;
	private scheduledWorkspaceCwd: string | undefined;
	private closed = false;

	constructor(
		private readonly state: PhiState,
		private readonly launchCwd: string,
		private readonly dependencies: AppDependencies,
		private readonly onChange: () => void,
	) {
		this.view = new InspectorView(state, this.model);
	}

	setSession(sessionId: string): void {
		if (this.sessionId === sessionId) return;
		this.sessionId = sessionId;
		this.historyGeneration += 1;
		this.workflowGeneration += 1;
		this.workflowReferences.clear();
		this.workflowCursors.clear();
		this.workflowRecords.clear();
		this.model.historyMessages = [];
		this.model.childMessages = [];
		this.model.childAgentIds = [];
		this.model.historyOffset = 0;
		this.model.selectedChildId = undefined;
		this.model.selectedTaskId = undefined;
		this.model.workflowRecords = [];
		this.stopWorkflowPolling();
		this.onChange();
	}

	onSdkMessage(message: SDKMessage): void {
		if ("session_id" in message && typeof message.session_id === "string") this.setSession(message.session_id);
		if (message.type === "user") this.rememberWorkflowReference(message);
		this.mergeObservedChildren();
		if (this.model.panel === "tasks" && this.model.selectedTaskId) {
			const selectedTaskId = this.model.selectedTaskId;
			if (this.isSelectedActiveWorkflow(selectedTaskId) && !this.workflowTimer && !this.workflowPollActive) {
				void this.selectTask(selectedTaskId);
			} else if (!this.isSelectedActiveWorkflow(selectedTaskId) && this.workflowTimer) {
				this.workflowGeneration += 1;
				this.stopWorkflowPolling();
			}
		}
		if (this.model.panel === "tasks" && !this.model.selectedTaskId && !this.model.selectedChildId) {
			const firstTask = [...this.state.tasks.values()].find((task) => !task.ambient);
			if (firstTask) void this.selectTask(firstTask.taskId);
		}
		this.onChange();
	}

	show(panel: InspectorPanel | null): void {
		if (panel !== this.model.panel) this.workflowGeneration += 1;
		this.model.panel = panel;
		if (panel === "history") void this.loadHistoryPage(0);
		if (panel === "tasks") {
			void this.loadChildAgentIds();
			const firstTask = [...this.state.tasks.values()].find((task) => !task.ambient);
			if (firstTask && !this.model.selectedTaskId && !this.model.selectedChildId) void this.selectTask(firstTask.taskId);
			else if (this.model.selectedTaskId) void this.selectTask(this.model.selectedTaskId);
		}
		if (panel === "workspace") void this.refreshWorkspace();
		if (panel !== "tasks") this.stopWorkflowPolling();
		this.onChange();
	}

	async selectTask(taskId: string): Promise<void> {
		const task = this.state.tasks.get(taskId);
		if (!task || task.ambient) return;
		const generation = ++this.workflowGeneration;
		this.model.selectedTaskId = taskId;
		this.model.selectedChildId = undefined;
		this.model.childMessages = [];
		this.model.workflowRecords = [];
		this.model.workflowWarnings = [];
		this.model.workflowUnavailable = undefined;
		this.stopWorkflowPolling();
		this.onChange();
		this.model.workflowRecords = [...(this.workflowRecords.get(taskId)?.values() ?? [])];
		const reference = this.workflowReferences.get(taskId);
		if (!task.workflowRunId && !reference && task.taskType !== "local_workflow" && !task.workflowName) return;
		if (!reference) {
			this.model.workflowUnavailable = "Workflow path metadata was not reported by the SDK.";
			this.onChange();
			return;
		}
		if (!reference.output.runId || !reference.output.transcriptDir) {
			this.model.workflowUnavailable = "This workflow did not report a local run ID and transcript directory.";
			this.onChange();
			return;
		}
		if (this.isSelectedActiveWorkflow(taskId)) {
			await this.pollSelectedWorkflow(taskId, reference, generation);
			if (generation === this.workflowGeneration && this.isSelectedActiveWorkflow(taskId)) {
				this.startWorkflowPolling(taskId, reference, generation);
			}
		}
	}

	async selectChild(agentId: string): Promise<void> {
		const sessionId = this.sessionId;
		if (!sessionId || !this.model.childAgentIds.includes(agentId)) return;
		this.workflowGeneration += 1;
		this.model.selectedTaskId = undefined;
		this.model.selectedChildId = agentId;
		this.model.childMessages = [];
		this.model.workflowRecords = [];
		this.model.workflowWarnings = [];
		this.model.workflowUnavailable = undefined;
		this.stopWorkflowPolling();
		this.model.historyLoading = true;
		const generation = ++this.historyGeneration;
		this.onChange();
		try {
			const messages = await this.getReader().agentMessages(sessionId, agentId, {
				dir: this.launchCwd,
				limit: HISTORY_PAGE_SIZE,
				offset: 0,
			});
			if (this.closed || generation !== this.historyGeneration || this.sessionId !== sessionId || this.model.selectedChildId !== agentId) return;
			this.model.childMessages = messages;
			this.model.historyError = undefined;
		} catch (error) {
			if (generation === this.historyGeneration) this.model.historyError = errorText(error);
		} finally {
			if (generation === this.historyGeneration) {
				this.model.historyLoading = false;
				this.onChange();
			}
		}
	}

	async loadHistoryPage(offset: number): Promise<void> {
		const sessionId = this.sessionId;
		if (!sessionId || this.closed) return;
		const generation = ++this.historyGeneration;
		this.model.historyOffset = Math.max(0, offset);
		this.model.historyLoading = true;
		this.model.historyError = undefined;
		this.onChange();
		try {
			const messages = await this.getReader().messages(sessionId, {
				dir: this.launchCwd,
				limit: HISTORY_PAGE_SIZE,
				offset: this.model.historyOffset,
				includeSystemMessages: true,
			});
			if (this.closed || generation !== this.historyGeneration || this.sessionId !== sessionId) return;
			this.model.historyMessages = messages;
		} catch (error) {
			if (generation === this.historyGeneration) this.model.historyError = errorText(error);
		} finally {
			if (generation === this.historyGeneration) {
				this.model.historyLoading = false;
				this.onChange();
			}
		}
	}

	searchLoadedHistory(query: string): void {
		this.model.searchText = query.trim() || undefined;
		this.onChange();
	}

	async refreshWorkspace(cwd = this.state.cwd): Promise<void> {
		if (this.workspaceRefreshTimer) clearTimeout(this.workspaceRefreshTimer);
		this.workspaceRefreshTimer = undefined;
		this.scheduledWorkspaceCwd = undefined;
		const generation = ++this.workspaceGeneration;
		try {
			const workspace = await this.dependencies.readWorkspace(cwd);
			if (this.closed || generation !== this.workspaceGeneration || this.state.cwd !== cwd) return;
			this.model.workspace = workspace;
			this.onChange();
		} catch (error) {
			if (this.closed || generation !== this.workspaceGeneration || this.state.cwd !== cwd) return;
			this.model.workspace = { kind: "error", cwd, error: errorText(error) };
			this.onChange();
		}
	}

	scheduleWorkspaceRefresh(cwd: string): void {
		if (this.scheduledWorkspaceCwd === cwd && this.workspaceRefreshTimer) return;
		if (this.workspaceRefreshTimer) clearTimeout(this.workspaceRefreshTimer);
		this.scheduledWorkspaceCwd = cwd;
		this.workspaceRefreshTimer = setTimeout(() => {
			this.workspaceRefreshTimer = undefined;
			this.scheduledWorkspaceCwd = undefined;
			void this.refreshWorkspace(cwd);
		}, 100);
	}

	async listSessions(options: Parameters<HistoryReader["list"]>[0]): ReturnType<HistoryReader["list"]> {
		return this.getReader().list(options);
	}

	listProjectSessions(options: Pick<Parameters<HistoryReader["list"]>[0], "limit" | "offset"> = {}): ReturnType<HistoryReader["list"]> {
		return this.getReader().list({
			...options,
			dir: this.launchCwd,
			includeWorktrees: true,
			includeProgrammatic: true,
		});
	}

	listAllSessions(options: Pick<Parameters<HistoryReader["list"]>[0], "limit" | "offset"> = {}): ReturnType<HistoryReader["list"]> {
		return this.getReader().list({
			...options,
			includeWorktrees: true,
			includeProgrammatic: true,
		});
	}

	selectedOutput(): string | undefined {
		const search = this.model.panel === "history" ? this.model.searchText?.toLocaleLowerCase() : undefined;
		if (search) {
			for (let index = this.model.historyMessages.length - 1; index >= 0; index -= 1) {
				const candidate = this.model.historyMessages[index];
				if (!candidate) continue;
				const content = getHistoryMessageSearchText(candidate.message);
				if (content.toLocaleLowerCase().includes(search)) return copiedMessageText(candidate.message);
			}
			return undefined;
		}
		if (this.model.selectedChildId) {
			const last = this.model.childMessages.at(-1);
			return last ? copiedMessageText(last.message) : undefined;
		}
		if (this.model.selectedTaskId) {
			const task = this.state.tasks.get(this.model.selectedTaskId);
			if (task) return task.progressSummary ?? task.error ?? task.description ?? task.outputFile;
		}
		const messages = this.model.selectedChildId ? this.model.childMessages : this.model.historyMessages;
		const last = messages.at(-1);
		return last ? copiedMessageText(last.message) : undefined;
	}

	close(): Promise<void> {
		if (this.closed) return Promise.resolve();
		this.closed = true;
		this.historyGeneration += 1;
		this.workspaceGeneration += 1;
		this.workflowGeneration += 1;
		if (this.workspaceRefreshTimer) clearTimeout(this.workspaceRefreshTimer);
		this.workspaceRefreshTimer = undefined;
		this.stopWorkflowPolling();
		return this.reader?.close() ?? Promise.resolve();
	}

	private getReader(): HistoryReader {
		this.reader ??= this.dependencies.createHistoryReader(this.dependencies.configRoot);
		return this.reader;
	}

	private async loadChildAgentIds(): Promise<void> {
		const sessionId = this.sessionId;
		if (!sessionId || this.closed) return;
		const generation = this.historyGeneration;
		try {
			const childIds = await this.getReader().agents(sessionId, { dir: this.launchCwd });
			if (this.closed || generation !== this.historyGeneration || this.sessionId !== sessionId) return;
			this.model.childAgentIds = [...new Set([...childIds, ...this.state.childMessages.keys()])];
			this.onChange();
		} catch (error) {
			if (generation !== this.historyGeneration) return;
			this.model.historyError = errorText(error);
			this.onChange();
		}
	}

	private mergeObservedChildren(): void {
		const observed = [...this.state.childMessages.keys()];
		this.model.childAgentIds = [...new Set([...this.model.childAgentIds, ...observed])];
	}

	private rememberWorkflowReference(message: SDKUserMessage): void {
		const output = message.tool_use_result;
		if (!isWorkflowOutput(output)) return;
		const sessionId = message.session_id ?? this.sessionId;
		if (!sessionId) return;
		this.workflowReferences.set(output.taskId, {
			sessionId,
			output,
			configRoot: this.dependencies.configRoot,
		});
	}

	private isSelectedActiveWorkflow(taskId: string): boolean {
		return this.model.panel === "tasks" && this.model.selectedTaskId === taskId && this.state.tasks.get(taskId)?.status === "running";
	}

	private stopWorkflowPolling(): void {
		if (this.workflowTimer) clearInterval(this.workflowTimer);
		this.workflowTimer = undefined;
	}

	private startWorkflowPolling(taskId: string, reference: WorkflowReference, generation: number): void {
		if (this.workflowTimer) clearInterval(this.workflowTimer);
		this.workflowTimer = setInterval(() => {
			void this.pollSelectedWorkflow(taskId, reference, generation);
		}, 1_000);
	}

	private async pollSelectedWorkflow(taskId: string, reference: WorkflowReference, generation: number): Promise<void> {
		if (this.workflowPollActive || generation !== this.workflowGeneration || !this.isSelectedActiveWorkflow(taskId)) return;
		this.workflowPollActive = true;
		try {
			const page = await this.dependencies.readWorkflowJournal(reference, this.workflowCursors.get(taskId));
			if (this.closed || generation !== this.workflowGeneration || !this.isSelectedActiveWorkflow(taskId)) return;
			this.mergeWorkflowPage(taskId, page);
		} catch (error) {
			if (!this.closed && generation === this.workflowGeneration && this.isSelectedActiveWorkflow(taskId)) {
				this.model.workflowWarnings = [errorText(error)];
			}
		} finally {
			this.workflowPollActive = false;
			this.onChange();
		}
	}

	private mergeWorkflowPage(taskId: string, page: JournalPage): void {
		if (page.reset) {
			this.workflowRecords.set(taskId, new Map());
			this.workflowCursors.delete(taskId);
			this.model.workflowWarnings = [];
		}
		const records = this.workflowRecords.get(taskId) ?? new Map<string, WorkflowJournalRecord>();
		for (const record of page.metadata.records) records.set(workflowRecordKey(record), record);
		this.workflowRecords.set(taskId, records);
		this.model.workflowRecords = [...records.values()];
		this.model.workflowWarnings = [...new Set([...this.model.workflowWarnings, ...page.warnings])];
		if (page.cursor) this.workflowCursors.set(taskId, page.cursor);
	}
}

function isWorkflowOutput(value: unknown): value is WorkflowReference["output"] {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return typeof record.taskId === "string" && (record.status === "async_launched" || record.status === "remote_launched");
}

function workflowRecordKey(record: WorkflowJournalRecord): string {
	return record.id
		? `${record.type}:${record.id}`
		: `${record.type}:${record.taskId ?? ""}:${record.agentId ?? ""}:${record.phase ?? ""}:${record.timestamp ?? ""}:${record.label ?? record.name ?? ""}`;
}

function copiedMessageText(message: unknown): string {
	return getHistoryMessageText(message) ?? JSON.stringify(message) ?? String(message);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
