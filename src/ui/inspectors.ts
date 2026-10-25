import { Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { JournalPage, WorkflowJournalRecord } from "../workflows.js";
import type { PhiState, TaskRecord } from "../state.js";
import { boundedPreview, boundedPreviewValue, getContentType, getDisplayText, getProperty } from "../state-utils.js";
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
	workflowScriptPath?: string;
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
			case "tasks": return fitLines(this.renderTasks(width), width);
			case "history": return fitLines(this.renderHistory(width), width);
			case "workspace": return fitLines(this.renderWorkspace(width), width);
		}
	}

	invalidate(): void {}

	private renderTasks(width: number): string[] {
		const lines = [
			...wrapLine(theme.accent("Tasks · Ctrl+T"), width),
			...wrapLine("Tab cycles tasks and children · Enter opens · x stops selected task", width),
		];
		const tasks = [...this.state.tasks.values()].filter((task) => !task.ambient);
		if (tasks.length === 0) lines.push(...wrapLine("No SDK tasks have been reported.", width));
		for (const task of tasks) lines.push(...this.renderTaskRow(task, width));

		const selectedTask = this.model.selectedTaskId ? this.state.tasks.get(this.model.selectedTaskId) : undefined;
		if (selectedTask) {
			lines.push("");
			lines.push(...wrapLine(theme.accent(`Selected task · ${sanitizeTerminalText(selectedTask.taskId)}`), width));
			const taskType = selectedTask.taskType ? ` · ${sanitizeTerminalText(selectedTask.taskType)}` : "";
			lines.push(...wrapLine(`Status: ${selectedTask.status}${taskType}`, width));
			if (selectedTask.description) lines.push(...new Text(sanitizeTerminalText(selectedTask.description)).render(width));
			if (selectedTask.progressSummary) lines.push(...new Text(sanitizeTerminalText(selectedTask.progressSummary)).render(width));
			if (selectedTask.error) lines.push(...new Text(theme.dim(`Error: ${sanitizeTerminalText(selectedTask.error)}`)).render(width));
			if (selectedTask.outputFile) lines.push(...new Text(`Output: ${sanitizeTerminalText(selectedTask.outputFile)}`).render(width));
			if (selectedTask.workflowRunId || selectedTask.taskType === "local_workflow" || selectedTask.workflowName) {
				lines.push(...wrapLine(`Workflow run: ${sanitizeTerminalText(selectedTask.workflowRunId ?? "unavailable")}`, width));
				lines.push(...wrapLine(`Workflow script: ${sanitizeTerminalText(this.model.workflowScriptPath ?? "unavailable")}`, width));
				lines.push(...wrapLine("Workflow journal events are observations. SDK task state determines completion.", width));
				const phaseCounts = new Map<string, number>();
				for (const record of this.model.workflowRecords) {
					if (record.phase) phaseCounts.set(record.phase, (phaseCounts.get(record.phase) ?? 0) + 1);
				}
			if (phaseCounts.size) {
					lines.push(...wrapLine(`Observed phases: ${[...phaseCounts].map(([phase, count]) => `${sanitizeTerminalText(phase)} ×${count}`).join(" · ")}`, width));
				}
				for (const record of this.model.workflowRecords) lines.push(...new Text(formatWorkflowRecord(record)).render(width));
				for (const warning of this.model.workflowWarnings) lines.push(...new Text(theme.dim(sanitizeTerminalText(warning))).render(width));
				if (this.model.workflowUnavailable) lines.push(...new Text(theme.dim(sanitizeTerminalText(this.model.workflowUnavailable))).render(width));
			}
		}

		const children = this.model.childAgentIds;
		lines.push("");
		lines.push(...wrapLine(theme.accent("Child conversations"), width));
		if (children.length === 0) lines.push(...wrapLine("No child transcripts have been reported.", width));
		for (const childId of children) {
			const selected = childId === this.model.selectedChildId ? "› " : "  ";
			lines.push(...wrapLine(`${selected}${sanitizeTerminalText(childId)}`, width));
		}
		if (this.model.selectedChildId) {
			lines.push(...this.renderMessages(this.model.childMessages, width, `Child ${sanitizeTerminalText(this.model.selectedChildId)}`));
		}
		return lines;
	}

	private renderTaskRow(task: TaskRecord, width: number): string[] {
		const selected = task.taskId === this.model.selectedTaskId ? "› " : "  ";
		const taskType = sanitizeTerminalText(task.taskType ?? "task");
		const taskId = sanitizeTerminalText(task.taskId);
		const description = task.description ? ` · ${sanitizeTerminalText(task.description)}` : "";
		return new Text(`${selected}${task.status} · ${taskType} · ${taskId}${description}`).render(width)
			.map(sanitizeTerminalText);
	}

	private renderHistory(width: number): string[] {
		const lines = [
			...wrapLine(theme.accent("Session history · Ctrl+R"), width),
			...wrapLine(`Session: ${sanitizeTerminalText(this.state.conversationId ?? "waiting for SDK session metadata")}`, width),
		];
		lines.push(...wrapLine(`Messages ${this.model.historyOffset + 1}–${this.model.historyOffset + this.model.historyMessages.length} · page size 200 · [ older · ] newer`, width));
		if (this.model.historyLoading) lines.push(...wrapLine(theme.dim("Loading history…"), width));
		if (this.model.historyError) lines.push(...wrapLine(theme.dim(`History unavailable: ${sanitizeTerminalText(this.model.historyError)}`), width));
		if (this.model.searchText) lines.push(...wrapLine(`Search: ${sanitizeTerminalText(this.model.searchText)}`, width));
		lines.push(...this.renderMessages(this.model.historyMessages, width, "Transcript"));
		lines.push(...wrapLine("Children: open Tasks (Ctrl+T); Tab selects the next task or child transcript.", width));
		return lines;
	}

	private renderWorkspace(width: number): string[] {
		const workspace = this.model.workspace;
		const lines = [
			...wrapLine(theme.accent("Workspace · Ctrl+W"), width),
			...wrapLine("Ctrl+G refreshes Git status.", width),
		];
		if (!workspace) return [...lines, ...wrapLine(theme.dim("Reading workspace status…"), width)];
		if (workspace.kind === "error") return [...lines, ...wrapLine(`Unavailable: ${sanitizeTerminalText(workspace.error)}`, width)];
		if (workspace.kind === "not-repository") return [...lines, ...wrapLine(`Not a Git repository · ${sanitizeTerminalText(workspace.cwd)}`, width)];
		lines.push(...wrapLine(`Root: ${sanitizeTerminalText(workspace.root)}`, width));
		lines.push(...wrapLine(`Branch: ${sanitizeTerminalText(workspace.branch ?? "detached HEAD")}${workspace.dirty ? " · changes present" : " · clean"}`, width));
		lines.push(...new Text("Observed worktrees:").render(width));
		for (const worktree of workspace.worktrees) {
			const details = [worktree.detached ? worktree.head.slice(0, 12) : worktree.branch ?? "no branch", worktree.locked ? "locked" : "", worktree.prunable ? "prunable" : ""]
				.filter(Boolean).join(" · ");
			lines.push(...new Text(`${sanitizeTerminalText(worktree.path)} · ${sanitizeTerminalText(details)}`).render(width));
		}
		return lines;
	}

	private renderMessages(messages: readonly SessionMessage[], width: number, heading: string): string[] {
		const lines = wrapLine(theme.dim(heading), width);
		if (messages.length === 0) return [...lines, ...(this.model.historyLoading ? [""] : wrapLine("No messages loaded.", width))];
		for (const message of messages) {
			const role = message.type === "assistant" ? "Phi" : message.type === "user" ? "You" : "System";
			const content = getHistoryMessageSearchText(message.message);
			if (this.model.searchText && !content.toLocaleLowerCase().includes(this.model.searchText.toLocaleLowerCase())) continue;
			lines.push(...wrapLine(theme.accent(`${role}:`), width));
			lines.push(...new Text(boundedPreview(sanitizeTerminalText(content))).render(width));
		}
		return lines;
	}
}

function wrapLine(text: string, width: number): string[] {
	return new Text(text, 0, 0).render(Math.max(1, width));
}

function fitLines(lines: string[], width: number): string[] {
	const availableWidth = Math.max(1, width);
	return lines.map((line) => visibleWidth(line) <= availableWidth ? line : truncateToWidth(line, availableWidth));
}

export function getHistoryMessageText(message: unknown): string | undefined {
	if (typeof message === "string") return message;
	const content = getProperty(message, "content");
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;

	const parts: string[] = [];
	for (const block of content) {
		if (getContentType(block) === "tool_result") {
			const result = getProperty(block, "content");
			if (typeof result === "string") {
				if (result) parts.push(result);
			} else if (Array.isArray(result)) {
				for (const item of result) {
					const text = getDisplayText(item);
					if (text) parts.push(text);
				}
			}
			continue;
		}
		const text = getDisplayText(block);
		if (text) parts.push(text);
	}
	return parts.join("\n");
}

export function getHistoryMessageSearchText(message: unknown): string {
	const text = getHistoryMessageText(message);
	if (text !== undefined && (text !== "" || !Array.isArray(getProperty(message, "content")))) return text;
	const content = getProperty(message, "content");
	return boundedPreviewValue(Array.isArray(content) ? content : message);
}

function formatWorkflowRecord(record: WorkflowJournalRecord): string {
	const pieces = [record.type, record.phase, record.label ?? record.name, record.agentId ? `agent ${record.agentId}` : undefined, record.taskId ? `task ${record.taskId}` : undefined]
		.filter((value): value is string => Boolean(value));
	return sanitizeTerminalText(pieces.join(" · "));
}
