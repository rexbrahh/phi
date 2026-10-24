import assert from "node:assert/strict";
import test from "node:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
	applySdkMessage,
	createState,
	markInputsDeliveryUnknown,
	recordSubmittedInput,
	type PhiState,
} from "../src/state.js";
import {
	assistantMessage,
	backgroundTasksChanged,
	compactBoundary,
	conversationReset,
	nativeUuid,
	inputJsonDelta,
	replayUserMessage,
	refusalFallbackMessage,
	resultMessage,
	sdkStatus,
	sessionStateChanged,
	streamEvent,
	taskNotification,
	taskStarted,
	taskUpdated,
	textBlock,
	textDelta,
	textStreamStart,
	toolResultMessage,
	toolProgressMessage,
	toolJsonStart,
	toolUseBlock,
	userTextMessage,
} from "./helpers/sdk-events.js";

function projectionApi() {
	return { applySdkMessage, createState, markInputsDeliveryUnknown, recordSubmittedInput };
}

function textOf(state: PhiState, index: number): string | undefined {
	const content: unknown = state.conversationBlocks[index]?.content;
	if (content === null || typeof content !== "object" || !("text" in content)) return undefined;
	return typeof content.text === "string" ? content.text : undefined;
}

test("older and unversioned terminal task events cannot finish a newer task run", async () => {
	const { createState, applySdkMessage } = await projectionApi();
	const state = createState("/repo");
	applySdkMessage(state, taskStarted({ envelopeId: "run-start", taskId: "task-1", runId: "0002" }));
	applySdkMessage(state, taskNotification({
		envelopeId: "old-run-end",
		taskId: "task-1",
		runId: "0001",
		status: "failed",
	}));
	applySdkMessage(state, taskNotification({
		envelopeId: "unknown-run-end",
		taskId: "task-1",
		status: "completed",
	}));

	assert.equal(state.tasks.get("task-1")?.taskRunId, "0002");
	assert.equal(state.tasks.get("task-1")?.status, "running");
	assert.equal(state.notices.length, 2);
	assert.equal((state.notices[0]?.sourceMessage as { run_id?: string } | undefined)?.run_id, "0001");
});

test("native task output references stay joined to their originating tool receipt", async () => {
	const { createState, applySdkMessage } = await projectionApi();
	const state = createState("/repo");
	applySdkMessage(state, assistantMessage({
		envelopeId: "mcp-call-message",
		modelMessageId: "msg-mcp-call",
		content: [toolUseBlock("mcp-call", "MCP", {})],
	}));
	applySdkMessage(state, taskStarted({
		envelopeId: "mcp-task-start",
		taskId: "mcp-task",
		runId: "run-1",
		toolUseId: "mcp-call",
		taskType: "mcp_task",
		ambient: false,
	}));
	const resourceLinks = [{ uri: "file:///tmp/result.csv", name: "result.csv", mimeType: "text/csv" }];
	applySdkMessage(state, taskNotification({
		envelopeId: "mcp-task-result",
		taskId: "mcp-task",
		runId: "run-1",
		toolUseId: "mcp-call",
		status: "completed",
		resourceLinks,
	}));

	assert.equal(state.tasks.get("mcp-task")?.toolUseId, "mcp-call");
	assert.deepEqual(state.tasks.get("mcp-task")?.resourceLinks, resourceLinks);
	assert.deepEqual(state.toolReceipts.get("mcp-call")?.resourceLinks, resourceLinks);
	assert.equal(state.toolReceipts.get("mcp-call")?.resultEnvelopeId, nativeUuid("mcp-task-result"));
	assert.ok(state.toolReceipts.get("mcp-call")?.sourceEnvelopeIds.includes(nativeUuid("mcp-task-result")));
});

test("a structured workflow result arriving first creates a task with a separate workflow run id", async () => {
	const { createState, applySdkMessage } = await projectionApi();
	const state = createState("/repo");
	applySdkMessage(
		state,
		assistantMessage({
			envelopeId: "workflow-call",
			modelMessageId: "msg-workflow",
			content: [toolUseBlock("workflow-use", "Workflow", {})],
		}),
	);
	applySdkMessage(
		state,
		toolResultMessage({
			envelopeId: "workflow-result",
			toolUseId: "workflow-use",
			text: "launched",
			toolUseResult: {
				status: "async_launched",
				taskId: "workflow-task",
				taskType: "local_workflow",
				workflowName: "spec",
				runId: "workflow-run-z",
				summary: "running spec",
			},
		}),
	);
	applySdkMessage(state, taskStarted({
		envelopeId: "workflow-task-start",
		taskId: "workflow-task",
		runId: "task-run-1",
		toolUseId: "workflow-use",
		taskType: "local_workflow",
		description: "spec",
	}));

	assert.equal(state.toolReceipts.get("workflow-use")?.executionState, "completed");
	assert.equal(state.tasks.get("workflow-task")?.workflowRunId, "workflow-run-z");
	assert.equal(state.tasks.get("workflow-task")?.taskRunId, "task-run-1");
});

test("structured tool data without the native workflow status is not a workflow task", async () => {
	const { createState, applySdkMessage } = await projectionApi();
	const state = createState("/repo");
	applySdkMessage(state, assistantMessage({
		envelopeId: "generic-call",
		modelMessageId: "msg-generic-call",
		content: [toolUseBlock("generic-tool", "CustomTool", {})],
	}));
	applySdkMessage(state, toolResultMessage({
		envelopeId: "generic-result",
		toolUseId: "generic-tool",
		text: "data",
		toolUseResult: { taskId: "payload-task-id", runId: "payload-run-id" },
	}));

	assert.equal(state.tasks.has("payload-task-id"), false);
	assert.equal(state.toolReceipts.get("generic-tool")?.executionState, "completed");
});

test("a workflow launch error stays failed even when it includes launch metadata", async () => {
	const { createState, applySdkMessage } = await projectionApi();
	const state = createState("/repo");
	applySdkMessage(
		state,
		assistantMessage({
			envelopeId: "workflow-error-call",
			modelMessageId: "msg-workflow-error",
			content: [toolUseBlock("workflow-error-use", "Workflow", {})],
		}),
	);
	applySdkMessage(
		state,
		toolResultMessage({
			envelopeId: "workflow-error-result",
			toolUseId: "workflow-error-use",
			text: "failed to launch",
			toolUseResult: { status: "async_launched", taskId: "failed-task", error: "spawn failed" },
		}),
	);

	assert.equal(state.toolReceipts.get("workflow-error-use")?.executionState, "failed");
	assert.equal(state.tasks.get("failed-task")?.status, "failed");
});

test("background task snapshots can create records before task_started", async () => {
	const { createState, applySdkMessage } = await projectionApi();
	const state = createState("/repo");
	applySdkMessage(state, backgroundTasksChanged({
		envelopeId: "snapshot-first",
		tasks: [{
			task_id: "snapshot-task",
			run_id: "run-1",
			task_type: "local_agent",
			description: "read files",
			ambient: false,
		}],
	}));
	applySdkMessage(state, taskStarted({
		envelopeId: "start-after-snapshot",
		taskId: "snapshot-task",
		runId: "run-1",
		description: "read files",
		taskType: "local_agent",
	}));

	assert.deepEqual([...state.liveBackgroundTaskIds], ["snapshot-task"]);
	assert.equal(state.tasks.size, 1);
	assert.equal(state.tasks.get("snapshot-task")?.description, "read files");
});

test("background snapshots replace live membership without deleting task history", async () => {
	const { createState, applySdkMessage } = await projectionApi();
	const state = createState("/repo");
	applySdkMessage(state, backgroundTasksChanged({
		envelopeId: "background-before",
		tasks: [{ task_id: "task-finished", task_type: "local_agent", description: "finished later" }],
	}));
	applySdkMessage(state, backgroundTasksChanged({ envelopeId: "background-after", tasks: [] }));

	assert.equal(state.liveBackgroundTaskIds.size, 0);
	assert.equal(state.tasks.has("task-finished"), true);
	assert.equal(state.tasks.get("task-finished")?.status, "running");
});

test("a turn result does not settle a live task before its notification", async () => {
	const { createState, applySdkMessage } = await projectionApi();
	const state = createState("/repo");
	applySdkMessage(state, taskStarted({ envelopeId: "task-start", taskId: "task-live", runId: "run-1" }));
	applySdkMessage(state, backgroundTasksChanged({
		envelopeId: "task-is-live",
		tasks: [{ task_id: "task-live", run_id: "run-1", task_type: "local_agent", description: "work" }],
	}));
	applySdkMessage(state, resultMessage({ envelopeId: "turn-finished", cost: 1 }));
	assert.deepEqual([...state.liveBackgroundTaskIds], ["task-live"]);
	assert.equal(state.tasks.get("task-live")?.status, "running");

	applySdkMessage(state, taskNotification({
		envelopeId: "task-finished",
		taskId: "task-live",
		runId: "run-1",
		status: "completed",
	}));
	assert.equal(state.tasks.get("task-live")?.status, "completed");
	assert.deepEqual([...state.liveBackgroundTaskIds], ["task-live"]);
	applySdkMessage(state, backgroundTasksChanged({ envelopeId: "task-left-background", tasks: [] }));
	assert.equal(state.liveBackgroundTaskIds.size, 0);
	assert.equal(state.tasks.has("task-live"), true);
});

test("ambient background tasks remain live but do not count as busy activity", async () => {
	const { createState, applySdkMessage } = await projectionApi();
	const state = createState("/repo");
	applySdkMessage(state, backgroundTasksChanged({
		envelopeId: "ambient-only",
		tasks: [{
			task_id: "watcher",
			task_type: "monitor",
			description: "watch files",
			ambient: true,
		}],
	}));
	assert.deepEqual([...state.liveBackgroundTaskIds], ["watcher"]);
	assert.equal(state.effectiveStatus.busyBackgroundTaskCount, 0);

	applySdkMessage(state, backgroundTasksChanged({
		envelopeId: "ambient-and-work",
		tasks: [
			{ task_id: "watcher", task_type: "monitor", description: "watch files", ambient: true },
			{ task_id: "worker", task_type: "local_agent", description: "edit code", ambient: false },
		],
	}));
	assert.equal(state.effectiveStatus.busyBackgroundTaskCount, 1);
});

test("compaction is kept as an inspectable notice", async () => {
	const { createState, applySdkMessage } = await projectionApi();
	const state = createState("/repo");
	applySdkMessage(state, compactBoundary("compact-1"));

	assert.equal(state.notices.length, 1);
	assert.match(state.notices[0]?.text ?? "", /compaction/);
	assert.equal(
		(state.notices[0]?.sourceMessage as { compact_metadata?: { pre_tokens?: number } } | undefined)?.compact_metadata?.pre_tokens,
		100,
	);
});

test("conversation reset clears the view while retaining live task membership", async () => {
	const { createState, applySdkMessage, recordSubmittedInput } = await projectionApi();
	const state = createState("/repo");
	applySdkMessage(state, assistantMessage({
		envelopeId: "before-reset",
		modelMessageId: "msg-before-reset",
		content: [textBlock("old conversation")],
	}));
	applySdkMessage(state, backgroundTasksChanged({
		envelopeId: "reset-live-task",
		tasks: [{ task_id: "live-task", task_type: "local_agent", description: "still working" }],
	}));
	const inputUuid = nativeUuid("surviving-input");
	const clearUuid = nativeUuid("clear-input");
	recordSubmittedInput(state, inputUuid);
	recordSubmittedInput(state, clearUuid);
	applySdkMessage(state, resultMessage({ envelopeId: "usage-before-clear", cost: 3.5 }));
	applySdkMessage(state, conversationReset("clear-command", "clear-input"));

	assert.equal(state.conversationBlocks.length, 0);
	assert.equal(state.conversationId, nativeUuid("clear-command-new"));
	assert.equal(state.tasks.has("live-task"), true);
	assert.deepEqual([...state.liveBackgroundTaskIds], ["live-task"]);
	assert.equal(state.inputReceipts.get(inputUuid)?.status, "submitted");
	assert.equal(state.inputReceipts.get(clearUuid)?.status, "consumed");
	assert.equal(state.usage, null);
});

test("replaying mixed SDK records twice leaves collection sizes unchanged", async () => {
	const { createState, applySdkMessage } = await projectionApi();
	const state = createState("/repo");
	const records: SDKMessage[] = [
		assistantMessage({ envelopeId: "replay-main", modelMessageId: "msg-replay-main", content: [textBlock("hello")] }),
		taskStarted({ envelopeId: "replay-task", taskId: "task-replay", runId: "run-1" }),
		backgroundTasksChanged({
			envelopeId: "replay-background",
			tasks: [{ task_id: "task-replay", run_id: "run-1", task_type: "local_agent", description: "task" }],
		}),
		resultMessage({ envelopeId: "replay-result", cost: 1.25 }),
	];
	for (const record of records) applySdkMessage(state, record);
	const sizes = [
		state.conversationBlocks.length,
		state.tasks.size,
		state.liveBackgroundTaskIds.size,
		state.notices.length,
		state.seenEnvelopeIds.size,
	];
	for (const record of records) applySdkMessage(state, record);

	assert.deepEqual([
		state.conversationBlocks.length,
		state.tasks.size,
		state.liveBackgroundTaskIds.size,
		state.notices.length,
		state.seenEnvelopeIds.size,
	], sizes);
});
