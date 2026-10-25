import assert from "node:assert/strict";
import { test } from "node:test";

const FIXTURE_NAME = "phi-live-acceptance";
const WORKFLOW_ID = "private-workflow-tool-use-id";
const SECRET_PROMPT = "PRIVATE_MODEL_PROMPT_DO_NOT_PRINT";
const SECRET_PATH = "/private/synthetic/transcript/path";

type EvidenceFormatter = (messages: readonly unknown[], selectedApiKey?: string, fixtureName?: string) => string;
type WorkflowOutputProbe = (
	messages: readonly unknown[],
	workflowToolUseId: string,
) => Record<string, unknown> | undefined;

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
