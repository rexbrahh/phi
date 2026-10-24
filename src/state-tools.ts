import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { PhiState, ToolReceipt } from "./state.js";
import {
	addUnique,
	boundedPreview,
	getContentType,
	getDisplayText,
	getOrCreateTask,
	getProperty,
	getStringProperty,
	previewUnknown,
} from "./state-utils.js";

export function getOrCreateToolReceipt(state: PhiState, toolUseId: string): ToolReceipt {
	const existing = state.toolReceipts.get(toolUseId);
	if (existing) return existing;
	const receipt: ToolReceipt = {
		toolUseId,
		toolName: "unknown",
		inputComplete: false,
		executionState: "running",
		sourceEnvelopeIds: [],
	};
	state.toolReceipts.set(toolUseId, receipt);
	return receipt;
}

export function readToolResultIds(message: SDKUserMessage): string[] {
	const content = message.message.content;
	if (typeof content === "string") return [];
	return content.flatMap((block) => {
		if (getContentType(block) !== "tool_result") return [];
		const id = getStringProperty(block, "tool_use_id");
		return id ? [id] : [];
	});
}

export function readToolResultPreview(message: SDKUserMessage): string | undefined {
	const content = message.message.content;
	if (typeof content === "string") return boundedPreview(content);
	const parts: string[] = [];
	for (const block of content) {
		if (getContentType(block) !== "tool_result") continue;
		const result = getProperty(block, "content");
		if (typeof result === "string") parts.push(result);
		else if (Array.isArray(result)) {
			for (const item of result) {
				const text = getStringProperty(item, "text");
				if (text) parts.push(text);
			}
		}
	}
	return parts.length ? boundedPreview(parts.join("\n")) : undefined;
}

export function hasToolResultError(message: SDKUserMessage, toolUseId: string): boolean {
	const content = message.message.content;
	if (typeof content === "string") return false;
	return content.some(
		(block) => getContentType(block) === "tool_result" &&
			getStringProperty(block, "tool_use_id") === toolUseId &&
			getProperty(block, "is_error") === true,
	);
}

export function attachWorkflowResult(
	state: PhiState,
	receipt: ToolReceipt,
	result: { taskId: string; runId?: string; taskType?: string; workflowName?: string; summary?: string },
): void {
	receipt.taskId = result.taskId;
	receipt.workflowRunId = result.runId;
	const task = getOrCreateTask(state, result.taskId);
	task.workflowRunId = result.runId;
	task.taskType = result.taskType ?? task.taskType;
	task.description = result.summary ?? result.workflowName ?? task.description;
	if (task.status === "pending") task.status = "running";
}

export function getStructuredWorkflowResult(value: unknown):
	| {
		status: "async_launched" | "remote_launched";
		taskId: string;
		runId?: string;
		taskType?: string;
		workflowName?: string;
		summary?: string;
	}
	| undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	if (
		typeof record.taskId !== "string" ||
		(record.status !== "async_launched" && record.status !== "remote_launched")
	) return undefined;
	return {
		status: record.status,
		taskId: record.taskId,
		runId: typeof record.runId === "string" ? record.runId : undefined,
		taskType: typeof record.taskType === "string" ? record.taskType : undefined,
		workflowName: typeof record.workflowName === "string" ? record.workflowName : undefined,
		summary: typeof record.summary === "string" ? record.summary : undefined,
	};
}

export function hasWorkflowError(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const error = (value as Record<string, unknown>).error;
	return error === true || (typeof error === "string" && error.length > 0);
}

export function isDetachedToolCall(value: unknown): boolean {
	return Boolean(value && typeof value === "object" && (value as Record<string, unknown>).detachedToolCall === true);
}

export function readUserText(message: SDKUserMessage): string {
	const content = message.message.content;
	if (typeof content === "string") return content;
	return content
		.filter((block) => getContentType(block) !== "tool_result")
		.map((block) => getDisplayText(block))
		.filter(Boolean)
		.join("\n");
}
