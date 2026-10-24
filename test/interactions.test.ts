import assert from "node:assert/strict";
import { test } from "node:test";
import type { ElicitationRequest, ElicitationResult, Options, PermissionResult, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import {
	InteractionQueue,
	isHttpElicitationUrl,
	type InteractionAnswer,
	type PendingFormElicitationRequest,
	type PendingPermissionRequest,
	type PendingUrlElicitationRequest,
} from "../src/interactions.js";
import { buildOptions, parseArgs } from "../src/config.js";
import { startSession } from "../src/session.js";
import { FakeQueryHarness } from "./helpers/fake-query.js";

type ToolOptions = Parameters<NonNullable<Options["canUseTool"]>>[2];

function pendingIds(queue: InteractionQueue): string[] {
	return queue.pending.map((request) => request.requestId);
}

async function permissionResult(promise: Promise<PermissionResult | null>): Promise<PermissionResult> {
	const result = await promise;
	assert.ok(result);
	return result;
}

async function elicitationResult(promise: Promise<ElicitationResult | null>): Promise<ElicitationResult> {
	const result = await promise;
	assert.ok(result);
	return result;
}

function permissionAllow(result: PermissionResult | null): Extract<PermissionResult, { behavior: "allow" }> {
	assert.ok(result);
	if (result.behavior !== "allow") assert.fail(`Expected allow, received ${result.behavior}`);
	return result;
}

function permissionDeny(result: PermissionResult | null | undefined): Extract<PermissionResult, { behavior: "deny" }> {
	assert.ok(result);
	if (result.behavior !== "deny") assert.fail(`Expected deny, received ${result.behavior}`);
	return result;
}

function permissionRequest(
	queue: InteractionQueue,
	requestId: string,
	options: Omit<Partial<ToolOptions>, "signal" | "requestId" | "toolUseID"> = {},
) {
	const controller = new AbortController();
	const promise = queue.canUseTool("Bash", { command: `echo ${requestId}` }, {
		...options,
		signal: controller.signal,
		toolUseID: `tool-${requestId}`,
		requestId,
	});
	return { controller, promise };
}

function questionInput(questions: Array<Record<string, unknown>>) {
	return { questions, metadata: { origin: "native" } };
}

function questionRequest(queue: InteractionQueue, requestId: string, input: unknown) {
	const controller = new AbortController();
	const promise = queue.canUseTool("AskUserQuestion", input as Record<string, unknown>, {
		signal: controller.signal,
		toolUseID: `tool-${requestId}`,
		requestId,
	});
	return { controller, promise };
}

function elicitationRequest(
	queue: InteractionQueue,
	requestId: string,
	request: ElicitationRequest,
) {
	const controller = new AbortController();
	const promise = queue.onElicitation(request, { signal: controller.signal, requestId });
	return { controller, promise };
}

function formPending(queue: InteractionQueue): PendingFormElicitationRequest {
	const pending = queue.pending[0];
	assert.ok(pending?.kind === "elicitation" && pending.mode === "form");
	return pending;
}

function urlPending(queue: InteractionQueue): PendingUrlElicitationRequest {
	const pending = queue.pending[0];
	assert.ok(pending?.kind === "elicitation" && pending.mode === "url");
	return pending;
}

test("answer_targets_request_id", async () => {
	const queue = new InteractionQueue();
	const first = permissionRequest(queue, "request-1");
	const second = permissionRequest(queue, "request-2");
	let firstSettled = false;
	const firstObserved = first.promise.then((value) => {
		firstSettled = true;
		return value;
	});

	assert.deepEqual(pendingIds(queue), ["request-1", "request-2"]);
	assert.equal(queue.answer("request-2", { kind: "permission", action: "deny", message: "No" }), true);
	assert.equal((await permissionResult(second.promise)).behavior, "deny");
	assert.equal(firstSettled, false);
	assert.deepEqual(pendingIds(queue), ["request-1"]);

	assert.equal(queue.answer("request-1", { kind: "permission", action: "allow-once" }), true);
	assert.equal(permissionAllow(await firstObserved).behavior, "allow");
	assert.deepEqual(pendingIds(queue), []);
});

test("abort_removes_only_its_request", async () => {
	const queue = new InteractionQueue();
	const aborted = permissionRequest(queue, "request-aborted");
	const remaining = permissionRequest(queue, "request-remaining");
	const abortedPending = queue.pending[0];
	assert.ok(abortedPending);
	assert.deepEqual(abortedPending.abort, { aborted: false });

	aborted.controller.abort(new Error("native cancellation"));
	const abortedResult = await permissionDeny(await aborted.promise);
	assert.equal(abortedResult.behavior, "deny");
	assert.deepEqual(abortedPending.abort, { aborted: true, reason: "native cancellation" });
	assert.deepEqual(pendingIds(queue), ["request-remaining"]);

	assert.equal(queue.answer("request-remaining", { kind: "permission", action: "allow-once" }), true);
	assert.equal(permissionAllow(await remaining.promise).behavior, "allow");
	assert.deepEqual(pendingIds(queue), []);
});

test("answer_abort_race_settles_once", async () => {
	const queue = new InteractionQueue();
	const answerWins = permissionRequest(queue, "answer-wins");
	let answerSettlements = 0;
	const answerObserved = answerWins.promise.then((value) => {
		answerSettlements += 1;
		return value;
	});
	assert.equal(queue.answer("answer-wins", { kind: "permission", action: "allow-once" }), true);
	answerWins.controller.abort();
	assert.equal(permissionAllow(await answerObserved).behavior, "allow");
	assert.equal(answerSettlements, 1);
	assert.equal(queue.answer("answer-wins", { kind: "permission", action: "deny" }), false);
	assert.deepEqual(pendingIds(queue), []);

	const abortWins = permissionRequest(queue, "abort-wins");
	let abortSettlements = 0;
	const abortObserved = abortWins.promise.then((value) => {
		abortSettlements += 1;
		return value;
	});
	abortWins.controller.abort();
	assert.equal(queue.answer("abort-wins", { kind: "permission", action: "allow-once" }), false);
	assert.equal(permissionDeny(await abortObserved).behavior, "deny");
	assert.equal(abortSettlements, 1);
	assert.deepEqual(pendingIds(queue), []);
});

test("duplicate_request_does_not_duplicate_dialog", async () => {
	const queue = new InteractionQueue();
	const first = permissionRequest(queue, "request-shared");
	const duplicate = permissionRequest(queue, "request-shared");

	assert.strictEqual(duplicate.promise, first.promise);
	assert.deepEqual(pendingIds(queue), ["request-shared"]);
	assert.equal(queue.answer("request-shared", { kind: "permission", action: "deny" }), true);
	assert.deepEqual(await Promise.all([first.promise, duplicate.promise]), [
		{ behavior: "deny", message: "Permission denied by user", decisionClassification: "user_reject", toolUseID: "tool-request-shared" },
		{ behavior: "deny", message: "Permission denied by user", decisionClassification: "user_reject", toolUseID: "tool-request-shared" },
	]);
	assert.deepEqual(pendingIds(queue), []);
});

test("permission suggested updates are preserved exactly", async () => {
	const queue = new InteractionQueue();
	const suggestion: PermissionUpdate = {
		type: "addRules",
		rules: [{ toolName: "Bash", ruleContent: "echo safe" }],
		behavior: "allow",
		destination: "session",
	};
	const request = permissionRequest(queue, "request-suggested", { suggestions: [suggestion] });
	const pending = queue.pending[0] as PendingPermissionRequest;
	assert.equal(pending.canAlwaysAllow, true);
	assert.deepEqual(pending.suggestions, [suggestion]);

	assert.equal(queue.answer("request-suggested", { kind: "permission", action: "allow-suggested" }), true);
	const response = permissionAllow(await request.promise);
	assert.equal(response.behavior, "allow");
	assert.deepEqual(response.updatedPermissions, [suggestion]);
	assert.equal(response.decisionClassification, "user_permanent");
	assert.deepEqual(pendingIds(queue), []);
});

test("permission flags suppress persistent approval and expose the safe default", async () => {
	const queue = new InteractionQueue();
	const suggestion: PermissionUpdate = {
		type: "addRules",
		rules: [{ toolName: "Bash", ruleContent: "echo safe" }],
		behavior: "allow",
		destination: "session",
	};
	const suppressed = permissionRequest(queue, "suppressed", {
		suggestions: [suggestion],
		suppressAlwaysAllowRule: true,
		defaultToNo: true,
	});
	const suppressedPending = queue.pending[0] as PendingPermissionRequest;
	assert.equal(suppressedPending.canAlwaysAllow, false);
	assert.equal(suppressedPending.defaultToNo, true);
	assert.throws(
		() => queue.answer("suppressed", { kind: "permission", action: "allow-suggested" }),
		/always-allow|suggested permission/i,
	);
	assert.deepEqual(pendingIds(queue), ["suppressed"]);
	assert.equal(queue.answer("suppressed", { kind: "permission", action: "deny", message: "reviewed" }), true);
	assert.equal(permissionDeny(await suppressed.promise).message, "reviewed");

	const askRule = permissionRequest(queue, "matched-ask", {
		suggestions: [suggestion],
		matchedAskRule: { source: "project", toolName: "Bash" },
	});
	assert.equal((queue.pending[0] as PendingPermissionRequest).canAlwaysAllow, false);
	assert.equal(queue.answer("matched-ask", { kind: "permission", action: "allow-once" }), true);
	assert.equal(permissionAllow(await askRule.promise).decisionClassification, "user_temporary");
	assert.deepEqual(pendingIds(queue), []);
});

test("permission prompts never resolve to an implicit allow", async () => {
	const queue = new InteractionQueue();
	const request = permissionRequest(queue, "explicit-only", { defaultToNo: true });
	let resolved = false;
	void request.promise.then(() => {
		resolved = true;
	});
	await Promise.resolve();
	assert.equal(resolved, false);
	assert.deepEqual(pendingIds(queue), ["explicit-only"]);
	assert.equal(queue.answer("explicit-only", { kind: "permission", action: "allow-once" }), true);
	assert.equal(permissionAllow(await request.promise).behavior, "allow");
});

test("explicit permission cancellation returns a deny", async () => {
	const queue = new InteractionQueue();
	const request = permissionRequest(queue, "cancel-permission");
	assert.equal(queue.answer("cancel-permission", { kind: "permission", action: "cancel", reason: "overlay dismissed" }), true);
	const response = permissionDeny(await request.promise);
	assert.equal(response.behavior, "deny");
	assert.match(response.message, /overlay dismissed/);
	assert.equal(response.decisionClassification, "user_reject");
	assert.deepEqual(pendingIds(queue), []);
});

test("permission decisions reject unknown actions without settling", async () => {
	const queue = new InteractionQueue();
	const request = permissionRequest(queue, "invalid-permission-answer");

	assert.throws(
		() => queue.answer("invalid-permission-answer", { kind: "permission", action: "approve" } as unknown as InteractionAnswer),
		/permission response|allow once|deny|cancel/i,
	);
	assert.deepEqual(pendingIds(queue), ["invalid-permission-answer"]);
	assert.equal(queue.answer("invalid-permission-answer", { kind: "permission", action: "deny" }), true);
	assert.equal(permissionDeny(await request.promise).behavior, "deny");
});
