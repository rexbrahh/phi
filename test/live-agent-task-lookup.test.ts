import assert from "node:assert/strict";
import { test } from "node:test";

type FindAgentTaskIDs = (messages: readonly unknown[], workflowTaskId?: string) => string[];

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
