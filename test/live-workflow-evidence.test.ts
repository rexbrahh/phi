import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const FIXTURE_NAME = "phi-live-acceptance";
const WORKFLOW_ID = "private-workflow-tool-use-id";
const SECRET_PROMPT = "PRIVATE_MODEL_PROMPT_DO_NOT_PRINT";
const SECRET_PATH = "/private/synthetic/transcript/path";

type EvidenceFormatter = (messages: readonly unknown[], selectedApiKey?: string, fixtureName?: string) => string;
type ExtendedEvidenceFormatter = typeof import("./live.js")["formatWorkflowFailureEvidence"];
type WorkflowOutputProbe = (
	messages: readonly unknown[],
	workflowToolUseId: string,
) => Record<string, unknown> | undefined;
type FailureTraceWriter = (
	root: string,
	initialMessages: readonly unknown[],
	resumedMessages: readonly unknown[],
	selectedApiKey?: string,
) => Promise<string>;

const FAILURE_TRACE_FILENAME = "native-sdk-failure-trace.json";

async function writeFailureTrace(
	root: string,
	initialMessages: readonly unknown[],
	resumedMessages: readonly unknown[],
	selectedApiKey?: string,
): Promise<string> {
	const harness = await import("./live.js") as unknown as { writeLiveFailureTrace?: FailureTraceWriter };
	assert.equal(typeof harness.writeLiveFailureTrace, "function", "private SDK failure trace writer must exist");
	return harness.writeLiveFailureTrace!(root, initialMessages, resumedMessages, selectedApiKey);
}

async function withFailureTraceRoot(run: (root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "phi-live-failure-trace-test-"));
	try {
		await run(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function formatEvidence(messages: readonly unknown[], selectedApiKey?: string): Promise<string> {
	const harness = await import("./live.js") as unknown as { formatWorkflowFailureEvidence?: EvidenceFormatter };
	assert.equal(typeof harness.formatWorkflowFailureEvidence, "function", "workflow evidence formatter must exist");
	return harness.formatWorkflowFailureEvidence!(messages, selectedApiKey, FIXTURE_NAME);
}

function workflowUse(id = WORKFLOW_ID, input: Record<string, unknown> = { name: FIXTURE_NAME }) {
	return {
		type: "assistant",
		message: {
			content: [{ type: "tool_use", id, name: "Workflow", input }],
		},
	};
}

test("reports an absent Workflow tool result without exposing tool or prompt values", async () => {
	const summary = await formatEvidence([workflowUse(WORKFLOW_ID, {
		name: FIXTURE_NAME,
		prompt: SECRET_PROMPT,
		path: SECRET_PATH,
	})]);

	assert.match(summary, /toolUseSeen=true/);
	assert.match(summary, /fixtureNameMatched=true/);
	assert.match(summary, /resultMatched=false/);
	assert.match(summary, /inputKeys=/);
	assert.equal(summary.includes(WORKFLOW_ID), false);
	assert.equal(summary.includes(SECRET_PROMPT), false);
	assert.equal(summary.includes(SECRET_PATH), false);
});

test("includes a bounded correlated tool error excerpt after key redaction", async () => {
	const key = "offline-synthetic-api-key-for-error-redaction";
	const errorText = `\u001b[31mWorkflow launch failed: ${"x".repeat(270)}${key} then stopped ${"y".repeat(200)}`;
	const summary = await formatEvidence([
		workflowUse(),
		{
			type: "user",
			message: {
				content: [{ type: "tool_result", tool_use_id: WORKFLOW_ID, is_error: true, content: [{ type: "text", text: errorText }] }],
			},
		},
	], key);

	assert.match(summary, /resultMatched=true/);
	assert.match(summary, /is_error=true/);
	assert.match(summary, /Workflow launch failed/);
	assert.match(summary, /\[redacted API key\]/);
	assert.equal(summary.includes(key), false);
	assert.doesNotMatch(summary, /[\u0000-\u001f\u007f-\u009f]/);
	assert.ok(summary.length <= 2_000);
	const excerpt = summary.slice(summary.indexOf("errorExcerpt=") + "errorExcerpt=".length);
	assert.ok(excerpt.length <= 320, "error excerpt must stay within 320 characters");
});

test("reports structured launch shape without launch identifiers or transcript paths", async () => {
	const taskId = "private-task-id";
	const runId = "private-run-id";
	const summary = await formatEvidence([
		workflowUse(),
		{
			type: "user",
			message: {
				content: [{ type: "tool_result", tool_use_id: WORKFLOW_ID, is_error: false, content: [{ type: "text", text: SECRET_PROMPT }] }],
			},
			tool_use_result: {
				status: "async_launched",
				taskId,
				workflowName: FIXTURE_NAME,
				runId,
				transcriptDir: SECRET_PATH,
			},
		},
	]);

	assert.match(summary, /resultMatched=true/);
	assert.match(summary, /contentKinds=\[text\]/);
	assert.match(summary, /structuredPresent=true/);
	assert.match(summary, /status=async_launched/);
	assert.match(summary, /taskId=string\/present/);
	assert.match(summary, /workflowName=string\/present/);
	assert.match(summary, /runId=string\/present/);
	assert.match(summary, /transcriptDir=string\/present/);
	assert.equal(summary.includes(taskId), false);
	assert.equal(summary.includes(runId), false);
	assert.equal(summary.includes(SECRET_PATH), false);
	assert.equal(summary.includes(SECRET_PROMPT), false);
});

test("projects bounded task and journal evidence with redaction", async () => {
	const key = "offline-synthetic-task-error-api-key";
	const workflowTaskId = "private-workflow-task-id";
	const stoppedTaskId = "private-stopped-task-id";
	const continuedTaskId = "private-continued-task-id";
	const journalAgentId = "private-journal-agent-id";
	const prompt = "PRIVATE_MODEL_PROMPT_DO_NOT_PRINT";
	const summary = (await import("./live.js")) as unknown as {
		formatWorkflowFailureEvidence?: ExtendedEvidenceFormatter;
	};
	assert.equal(typeof summary.formatWorkflowFailureEvidence, "function");

	const evidence = summary.formatWorkflowFailureEvidence!([
		workflowUse(),
		{
			type: "system",
			subtype: "task_started",
			task_id: stoppedTaskId,
			task_type: "local_agent",
			label: "phi-live-agent-stopped",
			description: "fixture worker",
			prompt,
			parent_task_id: workflowTaskId,
		},
		{
			type: "system",
			subtype: "task_started",
			task_id: continuedTaskId,
			task_type: "/private/synthetic/task-type",
			label: { name: "phi-live-agent-continued" },
			description: "fixture sibling",
			parent_task_id: workflowTaskId,
		},
		{ type: "system", subtype: "task_notification", task_id: stoppedTaskId, status: "failed", summary: "failed" },
		{ type: "system", subtype: "task_notification", task_id: continuedTaskId, status: "stopped", summary: "stopped" },
		{
			type: "system",
			subtype: "task_updated",
			task_id: stoppedTaskId,
			patch: {
				status: "failed",
				error: [
					`Failed after ${prompt}; see /private/synthetic/transcript/path for task ${stoppedTaskId}`,
					`journal agent ${journalAgentId}, and ${key}`,
				].join(" "),
			},
		},
		{ type: "system", subtype: "task_progress", task_id: continuedTaskId, description: "working" },
		{
			type: "system",
			subtype: "background_tasks_changed",
			tasks: [
				{ task_id: stoppedTaskId, task_type: "local_agent" },
				{ task_id: continuedTaskId, task_type: "/private/synthetic/task-type" },
			],
		},
	], key, FIXTURE_NAME, {
		workflowTaskId,
		journal: {
			records: [
				{ type: "launched" },
				{
					type: "started",
					id: "private-journal-event-id",
					agentId: journalAgentId,
					phase: "Parallel fixture probes",
					label: "phi-live-agent-stopped",
				},
				{
					type: "started",
					taskId: "private-journal-task-id",
					phase: "Parallel fixture probes",
					label: "phi-live-agent-continued",
				},
				{ type: "failed", phase: "Private phase must not print" },
			],
		},
	});

	assert.match(evidence, /taskEvents=.*task_started:2/);
	assert.match(evidence, /taskTypes=.*local_agent:1.*other:1/);
	assert.match(evidence, /expectedLabels=.*stopped:1.*continued:0/);
	assert.match(evidence, /workflowParentMatches=2/);
	assert.match(evidence, /workflowTaskStarts=2;withoutId=0/);
	assert.match(evidence, /taskTerminalStatuses=.*failed:1.*stopped:1/);
	assert.match(evidence, /workflowTaskTerminalStatuses=.*failed:1.*stopped:1/);
	assert.match(evidence, /nativeTaskFailureSummary=/);
	assert.match(evidence, /nativeTaskFailureSummary=Failed after \[redacted\].*\[redacted API key\]; workflowJournalRecords=/);
	assert.match(evidence, /workflowJournalRecords=.*started:2.*expectedPhaseStarted=2/);
	assert.match(evidence, /workflowJournalLabels=\[stopped:1,continued:1\]/);
	for (const secret of [
		key,
		workflowTaskId,
		stoppedTaskId,
		continuedTaskId,
		journalAgentId,
		prompt,
		SECRET_PATH,
		"Private phase must not print",
	]) {
		assert.equal(evidence.includes(secret), false, `failure evidence must not include ${secret}`);
	}
	assert.ok(evidence.length <= 1_900, "failure evidence must keep the existing total bound");
	assert.doesNotMatch(evidence, /[\u0000-\u001f\u007f-\u009f]/);
});

test("ignores an unrelated tool result and its structured payload", async () => {
	const unrelatedId = "private-unrelated-tool-result-id";
	const summary = await formatEvidence([
		workflowUse(),
		{
			type: "user",
			message: {
				content: [{ type: "tool_result", tool_use_id: unrelatedId, is_error: true, content: [{ type: "text", text: SECRET_PROMPT }] }],
			},
			tool_use_result: { status: "private-unrelated-status", taskId: "private-unrelated-task" },
		},
	]);

	assert.match(summary, /resultMatched=false/);
	assert.match(summary, /structuredPresent=false/);
	assert.equal(summary.includes(unrelatedId), false);
	assert.equal(summary.includes(SECRET_PROMPT), false);
	assert.equal(summary.includes("private-unrelated-status"), false);
	assert.equal(summary.includes("private-unrelated-task"), false);
});

test("launch wait fails on a correlated tool error and preserves pending and successful results", async () => {
	const harness = await import("./live.js") as unknown as { findWorkflowOutput?: WorkflowOutputProbe };
	assert.equal(typeof harness.findWorkflowOutput, "function", "Workflow output probe must exist");
	const findOutput = harness.findWorkflowOutput!;

	assert.equal(findOutput([workflowUse()], WORKFLOW_ID), undefined, "a pending launch must keep waiting");
	assert.equal(findOutput([
		workflowUse(),
		{
			type: "user",
			message: {
				content: [{ type: "tool_result", tool_use_id: "unrelated-workflow-id", is_error: true, content: [] }],
			},
		},
	], WORKFLOW_ID), undefined, "an unrelated error must not fail the launch wait");

	const successfulOutput = {
		status: "async_launched",
		taskId: "fixture-workflow-task",
		workflowName: FIXTURE_NAME,
		runId: "fixture-workflow-run",
		transcriptDir: SECRET_PATH,
	};
	const output = findOutput([
		workflowUse(),
		{
			type: "user",
			message: { content: [{ type: "tool_result", tool_use_id: WORKFLOW_ID, is_error: false, content: [] }] },
			tool_use_result: successfulOutput,
		},
	], WORKFLOW_ID);
	assert.deepEqual(output, successfulOutput);

	assert.throws(() => findOutput([
		workflowUse(),
		{
			type: "user",
			message: {
				content: [{
					type: "tool_result",
					tool_use_id: WORKFLOW_ID,
					is_error: true,
					content: [{ type: "text", text: SECRET_PROMPT }],
				}],
			},
			tool_use_result: successfulOutput,
		},
	], WORKFLOW_ID), (error: unknown) => {
		assert.ok(error instanceof Error);
		assert.equal(error.message, "Native Workflow launch returned an error result.");
		assert.equal(error.message.includes(SECRET_PROMPT), false);
		return true;
	});
});

test("reports only the latest result subtype, turn count, and model names", async () => {
	const summary = await formatEvidence([
		workflowUse(),
		{ type: "result", subtype: "success", num_turns: 1, modelUsage: { "old-model": { input_tokens: 7 } } },
		{ type: "result", subtype: "error_max_budget_usd", num_turns: 6, modelUsage: { "claude-haiku-5-5": { input_tokens: 12345 } } },
	]);

	assert.match(summary, /latestResultSubtype=error_max_budget_usd/);
	assert.match(summary, /latestResultNumTurns=6/);
	assert.match(summary, /modelUsageModels=\[claude-haiku-5-5\]/);
	assert.equal(summary.includes("old-model"), false);
	assert.equal(summary.includes("12345"), false);
	assert.equal(summary.includes("input_tokens"), false);
});

test("redacts secrets in input and model names and status while bounding large input", async () => {
	const key = "offline-synthetic-api-key-in-name-and-status";
	const input: Record<string, unknown> = { name: FIXTURE_NAME, [`private-${key}`]: SECRET_PROMPT };
	for (let index = 0; index < 100; index += 1) input[`field-${index}`] = SECRET_PATH;
	const summary = await formatEvidence([
		workflowUse(WORKFLOW_ID, input),
		{
			type: "user",
			message: { content: [{ type: "tool_result", tool_use_id: WORKFLOW_ID, is_error: false, content: [] }] },
			tool_use_result: { status: `status-${key}`, [`private-${key}`]: SECRET_PATH },
		},
		{ type: "result", subtype: "success", num_turns: 2, modelUsage: { [key]: { input_tokens: 999 } } },
	], key);

	assert.match(summary, /\[redacted API key\]/);
	assert.match(summary, /inputKeys=.*omitted/);
	assert.equal(summary.includes(key), false);
	assert.equal(summary.includes(SECRET_PROMPT), false);
	assert.equal(summary.includes(SECRET_PATH), false);
	assert.equal(summary.includes("999"), false);
	assert.ok(summary.length <= 2_000);
});

test("private SDK failure trace retains native task IDs and event payloads", async () => {
	await withFailureTraceRoot(async (root) => {
		const initialMessages = [{
			type: "system",
			subtype: "task_started",
			task_id: "native-task-start-7",
			tool_use_id: "native-control-use-7",
			parent_task_id: "native-workflow-task-3",
			task_type: "local_agent",
			prompt: "synthetic initial agent prompt",
		}];
		const resumedMessages = [{
			type: "system",
			subtype: "task_updated",
			task_id: "native-task-resumed-9",
			patch: { status: "failed", error: "synthetic task payload" },
		}];

		const path = await writeFailureTrace(root, initialMessages, resumedMessages);
		assert.equal(path, join(root, FAILURE_TRACE_FILENAME));
		assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { initialMessages, resumedMessages });
	});
});

test("private SDK failure trace redacts the selected API key", async () => {
	await withFailureTraceRoot(async (root) => {
		const selectedApiKey = "offline-synthetic-selected-api-key";
		const path = await writeFailureTrace(root, [{ type: "assistant", message: { content: selectedApiKey } }], [], selectedApiKey);
		const serialized = await readFile(path, "utf8");

		assert.equal(serialized.includes(selectedApiKey), false);
		assert.ok(serialized.includes("[redacted API key]"));
	});
});

test("private SDK failure trace uses mode 0600 and does not replace an existing artifact", async () => {
	await withFailureTraceRoot(async (root) => {
		const path = await writeFailureTrace(root, [{ type: "system", task_id: "native-task-private" }], []);
		assert.equal((await stat(path)).mode & 0o777, 0o600);
		const original = await readFile(path, "utf8");

		await assert.rejects(writeFailureTrace(root, [{ type: "system", task_id: "replacement" }], []), { code: "EEXIST" });
		assert.equal(await readFile(path, "utf8"), original);
	});
});

test("private SDK failure trace refuses serialized data above 2 MiB", async () => {
	await withFailureTraceRoot(async (root) => {
		const oversizedText = "é".repeat(1_048_577);
		await assert.rejects(
			writeFailureTrace(root, [{ type: "assistant", message: { content: oversizedText } }], []),
			/exceeds 2 MiB/,
		);
		assert.deepEqual(await readdir(root), []);
	});
});
