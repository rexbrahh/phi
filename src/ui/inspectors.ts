import { Text, type Component } from "@earendil-works/pi-tui";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { JournalPage, WorkflowJournalRecord } from "../workflows.js";
import type { PhiState, TaskRecord } from "../state.js";
import { getDisplayText, getProperty, getStringProperty, previewUnknown } from "../state-utils.js";
import type { WorkspaceInfo } from "../workspace.js";
import { sanitizeTerminalText } from "./safe-text.js";
import { theme } from "./theme.js";

export type InspectorPanel = "tasks" | "history" | "workspace";

export interface InspectorModel {
	panel: InspectorPanel | null;
	selectedTaskId?: string;
	selectedChildId?: string;
	childAgentIds: string[];
	historyMessages: SessionMessage[];
	historyOffset: number;
	childMessages: SessionMessage[];
	historyError?: string;
	historyLoading: boolean;
	workspace?: WorkspaceInfo;
	workflowRecords: WorkflowJournalRecord[];
	workflowWarnings: string[];
	workflowUnavailable?: string;
	searchText?: string;
}

export function createInspectorModel(): InspectorModel {
	return {
		panel: null,
		childAgentIds: [],
		historyMessages: [],
		historyOffset: 0,
		childMessages: [],
		historyLoading: false,
		workflowRecords: [],
		workflowWarnings: [],
	};
}

export class InspectorView implements Component {
	constructor(
		private readonly state: PhiState,
		readonly model: InspectorModel,
	) {}

	render(width: number): string[] {
		if (!this.model.panel) return [];
		switch (this.model.panel) {
			case "tasks": return this.renderTasks(width);
			case "history": return this.renderHistory(width);
			case "workspace": return this.renderWorkspace(width);
		}
	}

	invalidate(): void {}

	private renderTasks(width: number): string[] {
		const lines = [theme.accent("Tasks · Ctrl+T"), "Tab selects the next task or child transcript · Enter opens selection"];
		const tasks = [...this.state.tasks.values()].filter((task) => !task.ambient);
		if (tasks.length === 0) lines.push("No SDK tasks have been reported.");
		for (const task of tasks) lines.push(...this.renderTaskRow(task, width));

		const selectedTask = this.model.selectedTaskId ? this.state.tasks.get(this.model.selectedTaskId) : undefined;
		if (selectedTask) {
			lines.push("");
			lines.push(theme.accent(`Selected task · ${selectedTask.taskId}`));
			lines.push(`Status: ${selectedTask.status}${selectedTask.taskType ? ` · ${selectedTask.taskType}` : ""}`);
			if (selectedTask.description) lines.push(...new Text(sanitizeTerminalText(selectedTask.description)).render(width));
			if (selectedTask.progressSummary) lines.push(...new Text(sanitizeTerminalText(selectedTask.progressSummary)).render(width));
			if (selectedTask.error) lines.push(...new Text(theme.dim(`Error: ${sanitizeTerminalText(selectedTask.error)}`)).render(width));
			if (selectedTask.outputFile) lines.push(...new Text(`Output: ${sanitizeTerminalText(selectedTask.outputFile)}`).render(width));
			if (selectedTask.workflowRunId || selectedTask.taskType === "local_workflow" || selectedTask.workflowName) {
				lines.push(`Workflow run: ${sanitizeTerminalText(selectedTask.workflowRunId ?? "unavailable")}`);
				lines.push("Workflow journal events are observations. SDK task state determines completion.");
				const phaseCounts = new Map<string, number>();
				for (const record of this.model.workflowRecords) {
					if (record.phase) phaseCounts.set(record.phase, (phaseCounts.get(record.phase) ?? 0) + 1);
				}
			if (phaseCounts.size) {
					lines.push(`Observed phases: ${[...phaseCounts].map(([phase, count]) => `${sanitizeTerminalText(phase)} ×${count}`).join(" · ")}`);
				}
				for (const record of this.model.workflowRecords) lines.push(...new Text(formatWorkflowRecord(record)).render(width));
				for (const warning of this.model.workflowWarnings) lines.push(...new Text(theme.dim(sanitizeTerminalText(warning))).render(width));
				if (this.model.workflowUnavailable) lines.push(...new Text(theme.dim(sanitizeTerminalText(this.model.workflowUnavailable))).render(width));
			}
		}

		const children = this.model.childAgentIds;
		lines.push("");
		lines.push(theme.accent("Child conversations"));
		if (children.length === 0) lines.push("No child transcripts have been reported.");
		for (const childId of children) {
			const selected = childId === this.model.selectedChildId ? "› " : "  ";
			lines.push(`${selected}${sanitizeTerminalText(childId)}`);
		}
		if (this.model.selectedChildId) {
			lines.push(...this.renderMessages(this.model.childMessages, width, `Child ${this.model.selectedChildId}`));
		}
		return lines;
	}

	private renderTaskRow(task: TaskRecord, width: number): string[] {
		const selected = task.taskId === this.model.selectedTaskId ? "› " : "  ";
		const description = task.description ? ` · ${task.description}` : "";
		return new Text(`${selected}${task.status} · ${task.taskType ?? "task"} · ${task.taskId}${description}`).render(width)
			.map(sanitizeTerminalText);
	}

	private renderHistory(width: number): string[] {
		const lines = [theme.accent("Session history · Ctrl+R"), `Session: ${sanitizeTerminalText(this.state.conversationId ?? "waiting for SDK session metadata")}`];
		lines.push(`Messages ${this.model.historyOffset + 1}–${this.model.historyOffset + this.model.historyMessages.length} · page size 200 · [ older · ] newer`);
		if (this.model.historyLoading) lines.push(theme.dim("Loading history…"));
		if (this.model.historyError) lines.push(theme.dim(`History unavailable: ${sanitizeTerminalText(this.model.historyError)}`));
		if (this.model.searchText) lines.push(`Search: ${sanitizeTerminalText(this.model.searchText)}`);
		lines.push(...this.renderMessages(this.model.historyMessages, width, "Transcript"));
		lines.push("Children: Tab cycles a reported child transcript.");
		return lines;
	}

	private renderWorkspace(width: number): string[] {
		const workspace = this.model.workspace;
		const lines = [theme.accent("Workspace · Ctrl+W"), "Ctrl+G refreshes Git status."];
		if (!workspace) return [...lines, theme.dim("Reading workspace status…")];
		if (workspace.kind === "error") return [...lines, `Unavailable: ${sanitizeTerminalText(workspace.error)}`];
		if (workspace.kind === "not-repository") return [...lines, `Not a Git repository · ${sanitizeTerminalText(workspace.cwd)}`];
		lines.push(`Root: ${sanitizeTerminalText(workspace.root)}`);
		lines.push(`Branch: ${sanitizeTerminalText(workspace.branch ?? "detached HEAD")}${workspace.dirty ? " · changes present" : " · clean"}`);
		lines.push(...new Text("Observed worktrees:").render(width));
		for (const worktree of workspace.worktrees) {
			const details = [worktree.detached ? worktree.head.slice(0, 12) : worktree.branch ?? "no branch", worktree.locked ? "locked" : "", worktree.prunable ? "prunable" : ""]
				.filter(Boolean).join(" · ");
			lines.push(...new Text(`${sanitizeTerminalText(worktree.path)} · ${sanitizeTerminalText(details)}`).render(width));
		}
		return lines;
	}

	private renderMessages(messages: readonly SessionMessage[], width: number, heading: string): string[] {
		const lines = [theme.dim(heading)];
		if (messages.length === 0) return [...lines, this.model.historyLoading ? "" : "No messages loaded."];
		for (const message of messages) {
			const role = message.type === "assistant" ? "Phi" : message.type === "user" ? "You" : "System";
			const content = messageText(message.message);
			if (this.model.searchText && !content.toLocaleLowerCase().includes(this.model.searchText.toLocaleLowerCase())) continue;
			lines.push(theme.accent(`${role}:`));
			lines.push(...new Text(sanitizeTerminalText(content)).render(width));
		}
		return lines;
	}
}

function messageText(message: unknown): string {
	if (typeof message === "string") return message;
	const content = getProperty(message, "content");
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const text = content.map(getDisplayText).filter(Boolean).join("\n");
		return text || previewUnknown(content);
	}
	return previewUnknown(message);
}

function formatWorkflowRecord(record: WorkflowJournalRecord): string {
	const pieces = [record.type, record.phase, record.label ?? record.name, record.agentId ? `agent ${record.agentId}` : undefined, record.taskId ? `task ${record.taskId}` : undefined]
		.filter((value): value is string => Boolean(value));
	return sanitizeTerminalText(pieces.join(" · "));
}
