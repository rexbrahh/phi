import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { PhiState, TaskRecord } from "./state.js";
import { addNotice, addUnique, getOrCreateTask } from "./state-utils.js";
import { getOrCreateToolReceipt } from "./state-tools.js";
import { removeSupersededMessages } from "./state-conversation.js";

export function applySystemEvent(state: PhiState, message: SDKMessage): void {
	if (message.type === "system" && message.subtype === "compact_boundary") {
		addNotice(state, message, "compaction boundary");
		return;
	}
	if (message.type === "system" && message.subtype === "model_refusal_fallback") {
		removeSupersededMessages(state, message.retracted_message_uuids ?? []);
		addNotice(state, message, "model refusal fallback");
		return;
	}
	if (message.type === "system" && message.subtype === "task_started") {
		const task = getOrCreateTask(state, message.task_id);
		if (acceptTaskRun(state, task, message.run_id, "task_started", message)) {
			task.status = "running";
			task.taskRunId = message.run_id ?? task.taskRunId;
			task.taskType = message.task_type ?? task.taskType;
			task.description = message.description;
			task.ambient = message.ambient ?? task.ambient;
			task.isBackgrounded = message.is_backgrounded ?? task.isBackgrounded;
			task.parentTaskId = message.parent_task_id ?? task.parentTaskId;
			task.toolUseId = message.tool_use_id ?? task.toolUseId;
			task.subagentType = message.subagent_type ?? task.subagentType;
			task.workflowName = message.workflow_name ?? task.workflowName;
			task.spawnDepth = message.spawn_depth ?? task.spawnDepth;
			task.skipTranscript = message.skip_transcript ?? task.skipTranscript;
			recomputeBackgroundActivity(state);
		}
		return;
	}
	if (message.type === "system" && message.subtype === "task_updated") {
		const task = getOrCreateTask(state, message.task_id);
		if (acceptTaskRun(state, task, message.run_id, "task_updated", message)) {
			mergeTaskPatch(task, message.patch);
			task.taskRunId = message.run_id ?? task.taskRunId;
		}
		return;
	}
	if (message.type === "system" && message.subtype === "task_progress") {
		const task = getOrCreateTask(state, message.task_id);
		if (acceptTaskRun(state, task, message.run_id, "task_progress", message)) {
			task.status = "running";
			task.taskRunId = message.run_id ?? task.taskRunId;
			task.description = message.description;
			task.progressSummary = message.summary;
			task.subagentType = message.subagent_type ?? task.subagentType;
			task.usage = message.usage;
			task.lastToolName = message.last_tool_name ?? task.lastToolName;
		}
		return;
	}
	if (message.type === "system" && message.subtype === "task_notification") {
		const task = getOrCreateTask(state, message.task_id);
		if (acceptTaskRun(state, task, message.run_id, "task_notification", message)) {
			task.status = message.status === "stopped" ? "stopped" : message.status;
			task.taskRunId = message.run_id ?? task.taskRunId;
			task.outputFile = message.output_file;
			task.progressSummary = message.summary;
			task.toolUseId = message.tool_use_id ?? task.toolUseId;
			task.ambient = message.ambient ?? task.ambient;
			task.skipTranscript = message.skip_transcript ?? task.skipTranscript;
			task.usage = message.usage ?? task.usage;
			task.resourceLinks = message.resource_links ?? task.resourceLinks;
			if (message.tool_use_id) {
				const receipt = state.toolReceipts.get(message.tool_use_id);
				if (receipt) {
					receipt.executionState = message.status === "stopped" ? "stopped" : message.status;
					receipt.sourceEnvelopeIds = addUnique(receipt.sourceEnvelopeIds, message.uuid);
					receipt.resultEnvelopeId = message.uuid;
					receipt.resourceLinks = message.resource_links;
				}
			}
			recomputeBackgroundActivity(state);
		}
		return;
	}
	if (message.type === "system" && message.subtype === "background_tasks_changed") {
		state.liveBackgroundTaskIds = new Set(message.tasks.map((task) => task.task_id));
		for (const taskSnapshot of message.tasks) {
			const task = getOrCreateTask(state, taskSnapshot.task_id);
			if (acceptTaskRun(state, task, taskSnapshot.run_id, "background_tasks_changed", message)) {
				task.status = task.status === "pending" ? "running" : task.status;
				task.taskRunId = taskSnapshot.run_id ?? task.taskRunId;
				task.taskType = taskSnapshot.task_type;
				task.description = taskSnapshot.description;
				task.ambient = taskSnapshot.ambient ?? task.ambient;
				task.parentTaskId = taskSnapshot.parent_task_id;
				task.subagentType = taskSnapshot.subagent_type ?? task.subagentType;
			}
		}
		recomputeBackgroundActivity(state);
		return;
	}
	if (message.type === "tool_progress") {
		const receipt = state.toolReceipts.get(message.tool_use_id);
		if (receipt) receipt.executionState = "running";
		return;
	}
	if (message.type === "system" && message.subtype === "permission_denied") {
		const receipt = getOrCreateToolReceipt(state, message.tool_use_id);
		receipt.toolName = message.tool_name;
		receipt.executionState = "permission_denied";
		return;
	}
	if (message.type === "system") {
		addNotice(state, message, `system event ${message.subtype}`);
		return;
	}
	addNotice(state, message, `SDK event ${message.type}`);
}

function acceptTaskRun(
	state: PhiState,
	task: TaskRecord,
	incomingRunId: string | undefined,
	eventType: string,
	message: SDKMessage,
): boolean {
	if (incomingRunId && task.taskRunId && incomingRunId < task.taskRunId) {
		addNotice(state, message, `ignored stale ${eventType} for task ${task.taskId}`);
		return false;
	}
	if (!incomingRunId && task.taskRunId && isTerminalTaskEvent(message)) {
		addNotice(state, message, `ignored unversioned terminal ${eventType} for task ${task.taskId}`);
		return false;
	}
	if (incomingRunId && (!task.taskRunId || incomingRunId > task.taskRunId)) {
		task.taskRunId = incomingRunId;
		task.status = "running";
	}
	return true;
}

function isTerminalTaskEvent(message: SDKMessage): boolean {
	if (message.type !== "system") return false;
	if (message.subtype === "task_notification") return true;
	if (message.subtype === "task_updated") {
		return ["completed", "failed", "killed"].includes(message.patch.status ?? "");
	}
	return false;
}

function mergeTaskPatch(task: TaskRecord, patch: Record<string, unknown>): void {
	if (typeof patch.status === "string") task.status = patch.status as TaskRecord["status"];
	if (typeof patch.description === "string") task.description = patch.description;
	if (typeof patch.error === "string") task.error = patch.error;
	if (typeof patch.is_backgrounded === "boolean") task.isBackgrounded = patch.is_backgrounded;
}

function recomputeBackgroundActivity(state: PhiState): void {
	let count = 0;
	for (const taskId of state.liveBackgroundTaskIds) {
		if (!state.tasks.get(taskId)?.ambient) count += 1;
	}
	state.effectiveStatus.busyBackgroundTaskCount = count;
}
