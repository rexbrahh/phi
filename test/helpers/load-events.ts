import type { SDKBackgroundTasksChangedMessage, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
	assistantMessage,
	textBlock,
	toolResultMessage,
	toolUseBlock,
} from "./sdk-event-core.js";
import { backgroundTasksChanged, sessionStateChanged, taskNotification, taskStarted } from "./sdk-task-events.js";

export const LOAD_TOOL_CALLS = 7_000;
export const LOAD_CHILD_CONVERSATIONS = 200;
export const LOAD_RESULT_BYTES = [1_397, 11_017, 37_034] as const;
export const LOAD_OVERSIZED_BYTES = 1_048_576;

const FIRST_COMPLETION_CALL = 3_000;

interface LoadTask {
	taskId: string;
	toolUseId: string;
	runId: string;
	description: string;
}

export function createLoadEvents(): SDKMessage[] {
	const events: SDKMessage[] = [];
	const resultBodies = LOAD_RESULT_BYTES.map((size) => "R".repeat(size));
	const activeTasks: SDKBackgroundTasksChangedMessage["tasks"] = [];
	const completionCalls = new Map<number, LoadTask[]>();
	const tasks = Array.from({ length: LOAD_CHILD_CONVERSATIONS }, (_unused, index) => makeTask(index));

	for (const [taskIndex, task] of tasks.entries()) {
		const callIndex = FIRST_COMPLETION_CALL + Math.floor(
			(taskIndex * (LOAD_TOOL_CALLS - 1 - FIRST_COMPLETION_CALL)) /
				(LOAD_CHILD_CONVERSATIONS - 1),
		);
		const scheduled = completionCalls.get(callIndex) ?? [];
		scheduled.push(task);
		completionCalls.set(callIndex, scheduled);
	}

	events.push(sessionStateChanged("running", "load-session-running"));

	for (let callIndex = 0; callIndex < LOAD_TOOL_CALLS; callIndex += 1) {
		const toolUseId = toolUseIdFor(callIndex);
		const task = tasks[callIndex];
		const content = [toolUseBlock(toolUseId, task ? "Task" : "Read", task ? { description: task.description } : { path: `/tmp/load-${callIndex}.txt` })];
		events.push(assistantMessage({
			envelopeId: `load-call-${callIndex}`,
			modelMessageId: `load-model-${callIndex}`,
			content,
		}));

		if (task) {
			activeTasks.push(snapshotFor(task));
			events.push(backgroundTasksChanged({
				envelopeId: `load-task-added-${callIndex}`,
				tasks: [...activeTasks],
			}));
			events.push(taskStarted({
				envelopeId: `load-task-started-${callIndex}`,
				taskId: task.taskId,
				runId: task.runId,
				toolUseId: task.toolUseId,
				description: task.description,
				taskType: "local_agent",
				ambient: false,
				isBackgrounded: true,
			}));
			events.push(assistantMessage({
				envelopeId: `load-child-message-${callIndex}`,
				modelMessageId: `load-child-model-${callIndex}`,
				content: [textBlock(`Child ${callIndex} completed its fixture step.`)],
				parentToolUseId: task.toolUseId,
				agentId: task.taskId,
			}));
		}

		events.push(toolResultMessage({
			envelopeId: `load-result-${callIndex}`,
			toolUseId,
			text: resultBodies[callIndex % resultBodies.length] ?? "",
		}));

		for (const completedTask of completionCalls.get(callIndex) ?? []) {
			events.push(taskNotification({
				envelopeId: `load-task-completed-${completedTask.taskId}`,
				taskId: completedTask.taskId,
				runId: completedTask.runId,
				toolUseId: completedTask.toolUseId,
				status: "completed",
			}));
			const activeIndex = activeTasks.findIndex((item) => item.task_id === completedTask.taskId);
			if (activeIndex >= 0) activeTasks.splice(activeIndex, 1);
			events.push(backgroundTasksChanged({
				envelopeId: `load-task-removed-${completedTask.taskId}`,
				tasks: [...activeTasks],
			}));
		}
	}

	return events;
}

export function createOversizedOutputEvent(): SDKMessage {
	return toolResultMessage({
		envelopeId: "load-oversized-output",
		toolUseId: toolUseIdFor(LOAD_TOOL_CALLS - 1),
		text: "O".repeat(LOAD_OVERSIZED_BYTES),
	});
}

export function loadToolUseId(index: number): string {
	return toolUseIdFor(index);
}

function makeTask(index: number): LoadTask {
	const suffix = String(index).padStart(3, "0");
	return {
		taskId: `load-child-${suffix}`,
		toolUseId: toolUseIdFor(index),
		runId: `load-run-${suffix}`,
		description: `Load child conversation ${suffix}`,
	};
}

function snapshotFor(task: LoadTask): SDKBackgroundTasksChangedMessage["tasks"][number] {
	return {
		task_id: task.taskId,
		run_id: task.runId,
		task_type: "local_agent",
		subagent_type: "general-purpose",
		description: task.description,
		ambient: false,
	};
}

function toolUseIdFor(index: number): string {
	return `load-tool-${String(index).padStart(4, "0")}`;
}
