import assert from "node:assert/strict";
import { test } from "node:test";
import type { HookJSONOutput, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import type { NativeControlTrace } from "./live.js";

type FindAgentTaskIDs = (messages: readonly unknown[], workflowTaskId?: string) => string[];
type FindMatchingNativeAgentTaskID = (
	messages: readonly unknown[],
	workflowTaskId: string,
	agentStart: import("./live.js").NativeAgentLifecycleRecord,
) => string | undefined;

test("pending Monitor gate holds real hook work and denies on stop or final cleanup", async () => {
	type PendingGate = {
		hold(input: PreToolUseHookInput, callbackToolUseId: string | undefined, signal: AbortSignal): Promise<HookJSONOutput>;
		isPending(toolUseId: string): boolean;
		denyPending(): Promise<void>;
	};
	const live = await import("./live.js") as unknown as {
		PendingMonitorGate?: new (trace: NativeControlTrace) => PendingGate;
		FIXED_WORKFLOW_MONITOR_INPUTS: typeof import("./live.js")["FIXED_WORKFLOW_MONITOR_INPUTS"];
	};
	assert.ok(live.PendingMonitorGate, "native Monitor hook gate must exist");
	const trace: NativeControlTrace = {
		lifecycle: [],
		monitorRequests: [],
		backgroundControls: [],
		stopAttempts: [],
	};
	const gate = new live.PendingMonitorGate(trace);
	const createInput = (agentId: string, toolUseId: string, scenario: "stopped" | "continued"): PreToolUseHookInput => ({
		hook_event_name: "PreToolUse",
		session_id: "private-session-id",
		transcript_path: "/private/synthetic/subagent-transcript.jsonl",
		cwd: "/private/synthetic/repository",
		agent_id: agentId,
		agent_type: "general-purpose",
		tool_name: "Monitor",
		tool_input: live.FIXED_WORKFLOW_MONITOR_INPUTS[scenario],
		tool_use_id: toolUseId,
	});
	const stoppedAbort = new AbortController();
	const stoppedToolUseId = "private-stopped-monitor-use-id";
	const stoppedRequest = gate.hold(
		createInput("private-stopped-agent-id", stoppedToolUseId, "stopped"),
		stoppedToolUseId,
		stoppedAbort.signal,
	);
	let stoppedSettled = false;
	void stoppedRequest.then(() => { stoppedSettled = true; });
	await Promise.resolve();
	assert.equal(stoppedSettled, false, "the exact Monitor request must remain pending until controlled cancellation");
	assert.equal(gate.isPending(stoppedToolUseId), true);
	stoppedAbort.abort();
	const stoppedOutput = (await stoppedRequest) as { hookSpecificOutput?: { permissionDecision?: string } };
	assert.equal(stoppedOutput.hookSpecificOutput?.permissionDecision, "deny");
	assert.equal(gate.isPending(stoppedToolUseId), false);

	const siblingToolUseId = "private-sibling-monitor-use-id";
	const siblingRequest = gate.hold(
		createInput("private-sibling-agent-id", siblingToolUseId, "continued"),
		siblingToolUseId,
		new AbortController().signal,
	);
	assert.equal(gate.isPending(siblingToolUseId), true);
	await gate.denyPending();
	const siblingOutput = (await siblingRequest) as { hookSpecificOutput?: { permissionDecision?: string } };
	assert.equal(siblingOutput.hookSpecificOutput?.permissionDecision, "deny");
	assert.equal(gate.isPending(siblingToolUseId), false);
	assert.deepEqual(trace.monitorRequests.map((record) => record.settlement), ["signal-aborted", "cleanup-denied"]);
	assert.equal(JSON.stringify(trace).includes("/private/synthetic/subagent-transcript.jsonl"), false);
});

function taskStarted(taskId: string, taskType: string | undefined, details: string) {
	return {
		type: "system",
		subtype: "task_started",
		task_id: taskId,
		...(taskType === undefined ? {} : { task_type: taskType }),
		prompt: details,
		description: details,
	};
}

test("agent task lookup requires local_agent type and excludes the Workflow parent", async () => {
	const live = await import("./live.js") as unknown as { findAgentTaskIDs?: FindAgentTaskIDs };
	assert.equal(typeof live.findAgentTaskIDs, "function", "native agent task lookup helper must be exported");

	const labels = "phi-live-agent-stopped phi-live-agent-continued";
	const messages = [
		taskStarted("workflow-parent", "local_agent", labels),
		taskStarted("bash-task", "local_bash", labels),
		taskStarted("nested-workflow", "local_workflow", labels),
		taskStarted("stopped-agent", "local_agent", "phi-live-agent-stopped"),
		taskStarted("continued-agent", "local_agent", "phi-live-agent-continued"),
		taskStarted("label-only", undefined, labels),
		taskStarted("missing-type", undefined, "ordinary task without an agent label"),
	];

	assert.deepEqual(live.findAgentTaskIDs!(messages, "workflow-parent"), [
		"stopped-agent",
		"continued-agent",
	]);
});
