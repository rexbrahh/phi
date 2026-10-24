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

test("AskUserQuestion preserves native questions and maps one choice by question text", async () => {
	const queue = new InteractionQueue();
	const input = questionInput([
		{
			question: "Run the command?",
			header: "Execution",
			options: [{ label: "Run", description: "Execute it" }, { label: "Skip", description: "Do not execute" }],
		},
	]);
	const request = questionRequest(queue, "question-choice", input);
	const pending = queue.pending[0];
	assert.ok(pending?.kind === "question");
	assert.strictEqual((pending.nativePayload as { input: unknown }).input, input);
	assert.deepEqual(pending.questions, input.questions);

	assert.equal(queue.answer("question-choice", {
		kind: "question",
		answers: { "Run the command?": { kind: "choice", label: "Run" } },
	}), true);
	const response = permissionAllow(await request.promise);
	assert.equal(response.behavior, "allow");
	assert.ok(response.updatedInput);
	assert.strictEqual(response.updatedInput.questions, input.questions);
	assert.deepEqual(response.updatedInput, {
		...input,
		answers: { "Run the command?": "Run" },
	});
	assert.deepEqual(pendingIds(queue), []);
});

test("AskUserQuestion returns multiselect answers as label arrays", async () => {
	const queue = new InteractionQueue();
	const input = questionInput([{
		question: "Include which checks?",
		header: "Checks",
		multiSelect: true,
		options: [{ label: "Unit" }, { label: "Integration" }, { label: "UI" }],
	}]);
	const request = questionRequest(queue, "question-multiple", input);

	assert.equal(queue.answer("question-multiple", {
		kind: "question",
		answers: { "Include which checks?": { kind: "choices", labels: ["Unit", "UI"] } },
	}), true);
	const response = permissionAllow(await request.promise);
	assert.ok(response.updatedInput);
	assert.deepEqual(response.updatedInput.answers, { "Include which checks?": ["Unit", "UI"] });
	assert.deepEqual(pendingIds(queue), []);
});

test("AskUserQuestion preserves __proto__ as an own multiselect answer key", async () => {
	const queue = new InteractionQueue();
	const input = questionInput([{
		question: "__proto__",
		multiSelect: true,
		options: [{ label: "Read" }, { label: "Write" }],
	}]);
	const request = questionRequest(queue, "question-proto-key", input);
	const answers = JSON.parse('{"__proto__":{"kind":"choices","labels":["Read","Write"]}}') as Record<
		string,
		{ kind: "choices"; labels: string[] }
	>;
	const inputPrototype = Object.getPrototypeOf(input);

	assert.equal(Object.hasOwn(answers, "__proto__"), true);
	assert.equal(queue.answer("question-proto-key", { kind: "question", answers }), true);
	const response = permissionAllow(await request.promise);
	assert.ok(response.updatedInput);
	const updatedAnswers = response.updatedInput.answers as Record<string, unknown>;
	assert.equal(Object.hasOwn(updatedAnswers, "__proto__"), true);
	assert.deepEqual(updatedAnswers["__proto__"], ["Read", "Write"]);
	assert.strictEqual(Object.getPrototypeOf(answers), Object.prototype);
	assert.strictEqual(Object.getPrototypeOf(updatedAnswers), Object.prototype);
	assert.strictEqual(Object.getPrototypeOf(response.updatedInput), Object.prototype);
	assert.strictEqual(Object.getPrototypeOf(input), inputPrototype);
});

test("AskUserQuestion returns actual free text", async () => {
	const queue = new InteractionQueue();
	const input = questionInput([{ question: "What should the branch be called?", header: "Branch", options: [] }]);
	const request = questionRequest(queue, "question-text", input);
	const freeText = "  fix/request-correlation  ";

	assert.equal(queue.answer("question-text", {
		kind: "question",
		answers: { "What should the branch be called?": { kind: "text", text: freeText } },
	}), true);
	const response = permissionAllow(await request.promise);
	assert.ok(response.updatedInput);
	assert.deepEqual(response.updatedInput.answers, { "What should the branch be called?": freeText });
	assert.deepEqual(pendingIds(queue), []);
});

test("AskUserQuestion rejects empty required answers and keeps the dialog pending", async () => {
	const queue = new InteractionQueue();
	const input = questionInput([{ question: "Describe the change", header: "Details", options: [] }]);
	const request = questionRequest(queue, "question-required", input);

	assert.throws(() => queue.answer("question-required", {
		kind: "question",
		answers: { "Describe the change": { kind: "text", text: "   " } },
	}), /required|empty/i);
	assert.deepEqual(pendingIds(queue), ["question-required"]);
	assert.equal(queue.answer("question-required", {
		kind: "question",
		answers: { "Describe the change": { kind: "text", text: "Use the failing test" } },
	}), true);
	const response = permissionAllow(await request.promise);
	assert.ok(response.updatedInput);
	assert.deepEqual(response.updatedInput.answers, { "Describe the change": "Use the failing test" });
});

test("AskUserQuestion rejects labels, missing questions, and extra question keys", async () => {
	const queue = new InteractionQueue();
	const input = questionInput([{ question: "Choose", options: [{ label: "A" }, { label: "B" }] }]);
	const request = questionRequest(queue, "question-invalid", input);

	for (const answers of [
		{ Choose: { kind: "choice", label: "not an option" } },
		{},
		{ Choose: { kind: "choice", label: "A" }, Other: { kind: "text", text: "extra" } },
	]) {
		assert.throws(
			() => queue.answer("question-invalid", { kind: "question", answers } as InteractionAnswer),
			/answer|option|question/i,
		);
		assert.deepEqual(pendingIds(queue), ["question-invalid"]);
	}
	assert.throws(
		() => queue.answer("question-invalid", { kind: "question", action: "approve" } as unknown as InteractionAnswer),
		/question response|cancel/i,
	);

	assert.equal(queue.answer("question-invalid", {
		kind: "question",
		answers: { Choose: { kind: "choice", label: "B" } },
	}), true);
	const response = permissionAllow(await request.promise);
	assert.ok(response.updatedInput);
	assert.deepEqual(response.updatedInput.answers, { Choose: "B" });
});

test("AskUserQuestion explicit cancellation returns a deny", async () => {
	const queue = new InteractionQueue();
	const request = questionRequest(queue, "question-cancel", questionInput([{ question: "Continue?", options: [] }]));

	assert.equal(queue.answer("question-cancel", { kind: "question", action: "cancel", reason: "user declined" }), true);
	const response = permissionDeny(await request.promise);
	assert.match(response.message, /user declined/);
	assert.deepEqual(pendingIds(queue), []);
});

test("malformed AskUserQuestion input is denied without opening a dialog", async () => {
	const queue = new InteractionQueue();
	const request = questionRequest(queue, "question-malformed", { questions: [{ question: "Duplicate" }, { question: "Duplicate" }] });
	const response = permissionDeny(await request.promise);
	assert.equal(response.behavior, "deny");
	assert.match(response.message, /question/i);
	assert.deepEqual(pendingIds(queue), []);
});

test("form elicitation exposes supported fields and accepts validated content", async () => {
	const queue = new InteractionQueue();
	const schema = {
		type: "object",
		title: "Access request",
		required: ["name", "role", "count", "approved", "tags"],
		properties: {
			name: { type: "string", minLength: 1, maxLength: 32 },
			role: { type: "string", enum: ["reader", "writer"] },
			count: { type: "integer", minimum: 1, maximum: 3 },
			approved: { type: "boolean" },
			tags: { type: "array", items: { type: "string", enum: ["red", "blue"] }, minItems: 1, maxItems: 2, uniqueItems: true },
		},
	};
	const request = elicitationRequest(queue, "elicitation-form", {
		mode: "form",
		serverName: "test-server",
		message: "Provide access details",
		requestedSchema: schema,
	});
	const pending = formPending(queue);
	assert.equal(pending.form.supported, true);
	assert.deepEqual(pending.form.required, ["name", "role", "count", "approved", "tags"]);
	assert.deepEqual(pendingIds(queue), ["elicitation-form"]);

	assert.equal(queue.answer("elicitation-form", {
		kind: "elicitation",
		response: {
			action: "accept",
			content: { name: "Rex", role: "reader", count: 2, approved: true, tags: ["red", "blue"] },
		},
	}), true);
	const response = await elicitationResult(request.promise);
	assert.deepEqual(response, {
		action: "accept",
		content: { name: "Rex", role: "reader", count: 2, approved: true, tags: ["red", "blue"] },
	});
	assert.deepEqual(pendingIds(queue), []);
});

test("form elicitation rejects empty required fields", async () => {
	const queue = new InteractionQueue();
	const request = elicitationRequest(queue, "elicitation-required", {
		mode: "form",
		serverName: "test-server",
		message: "Name is required",
		requestedSchema: { type: "object", properties: { name: { type: "string", minLength: 1 } }, required: ["name"] },
	});

	assert.throws(() => queue.answer("elicitation-required", {
		kind: "elicitation",
		response: { action: "accept", content: { name: "" } },
	}), /name|required|length/i);
	assert.deepEqual(pendingIds(queue), ["elicitation-required"]);
	assert.equal(queue.answer("elicitation-required", {
		kind: "elicitation",
		response: { action: "accept", content: { name: "Ada" } },
	}), true);
	assert.deepEqual((await elicitationResult(request.promise)).content, { name: "Ada" });
});

test("form elicitation enforces enum and numeric constraints", async () => {
	const queue = new InteractionQueue();
	const request = elicitationRequest(queue, "elicitation-bounds", {
		mode: "form",
		serverName: "test-server",
		message: "Choose a level",
		requestedSchema: {
			type: "object",
			properties: {
				level: { type: "string", enum: ["low", "high"] },
				count: { type: "number", minimum: 1.5, exclusiveMaximum: 4 },
			},
			required: ["level", "count"],
		},
	});

	for (const content of [
		{ level: "medium", count: 2 },
		{ level: "low", count: 1 },
		{ level: "high", count: 4 },
		{ level: "low", count: "2" },
	]) {
		assert.throws(() => queue.answer("elicitation-bounds", {
			kind: "elicitation",
			response: { action: "accept", content },
		}), /enum|level|count|number|minimum|maximum/i);
		assert.deepEqual(pendingIds(queue), ["elicitation-bounds"]);
	}

	assert.equal(queue.answer("elicitation-bounds", {
		kind: "elicitation",
		response: { action: "accept", content: { level: "high", count: 3.5 } },
	}), true);
	assert.deepEqual((await elicitationResult(request.promise)).content, { level: "high", count: 3.5 });
});

test("form elicitation validates recognized formats and item limits", async () => {
	const queue = new InteractionQueue();
	const request = elicitationRequest(queue, "elicitation-formats", {
		mode: "form",
		serverName: "test-server",
		message: "Enter contact details",
		requestedSchema: {
			type: "object",
			properties: {
				email: { type: "string", format: "email" },
				when: { type: "string", format: "date" },
				roles: { type: "array", items: { type: "string", enum: ["reader", "writer"] }, minItems: 1, maxItems: 2 },
			},
			required: ["email", "when", "roles"],
		},
	});

	assert.throws(() => queue.answer("elicitation-formats", {
		kind: "elicitation",
		response: { action: "accept", content: { email: "not-email", when: "2026-02-30", roles: [] } },
	}), /email|date|roles|minimum/i);
	assert.deepEqual(pendingIds(queue), ["elicitation-formats"]);
	assert.equal(queue.answer("elicitation-formats", {
		kind: "elicitation",
		response: { action: "accept", content: { email: "rex@example.com", when: "2026-02-28", roles: ["reader"] } },
	}), true);
	assert.deepEqual((await elicitationResult(request.promise)).content, { email: "rex@example.com", when: "2026-02-28", roles: ["reader"] });
});

test("URI formats and HTTP URL guard reject raw spaces and controls", async () => {
	const queue = new InteractionQueue();
	const request = elicitationRequest(queue, "elicitation-uri-raw", {
		mode: "form",
		serverName: "test-server",
		message: "Provide URI values",
		requestedSchema: {
			type: "object",
			properties: {
				destination: { type: "string", format: "uri" },
				reference: { type: "string", format: "uri-reference" },
			},
			required: ["destination", "reference"],
		},
	});

	for (const content of [
		{ destination: "https://example.test/a b", reference: "../valid%20path" },
		{ destination: "https://example.test/a\nb", reference: "../valid%20path" },
		{ destination: "https://example.test/valid%20path", reference: "../a b" },
		{ destination: "https://example.test/valid%20path", reference: "../a\tb" },
	]) {
		assert.throws(() => queue.answer("elicitation-uri-raw", {
			kind: "elicitation",
			response: { action: "accept", content },
		}), /URI|format/i);
		assert.deepEqual(pendingIds(queue), ["elicitation-uri-raw"]);
	}

	assert.equal(isHttpElicitationUrl("https://example.test/a b"), false);
	assert.equal(isHttpElicitationUrl("https://example.test/a\nb"), false);
	assert.equal(isHttpElicitationUrl("https://example.test/a%20b"), true);
	assert.equal(queue.answer("elicitation-uri-raw", {
		kind: "elicitation",
		response: {
			action: "accept",
			content: {
				destination: "https://example.test/a%20b",
				reference: "../a%20b",
			},
		},
	}), true);
	assert.deepEqual((await elicitationResult(request.promise)).content, {
		destination: "https://example.test/a%20b",
		reference: "../a%20b",
	});
});

test("URI formats reject raw brackets outside IP-literal hosts", async () => {
	const queue = new InteractionQueue();
	const request = elicitationRequest(queue, "elicitation-uri-brackets", {
		mode: "form",
		serverName: "test-server",
		message: "Provide URI values",
		requestedSchema: {
			type: "object",
			properties: {
				destination: { type: "string", format: "uri" },
				reference: { type: "string", format: "uri-reference" },
			},
			required: ["destination", "reference"],
		},
	});
	const invalidContent = [
		{ destination: "https://example.test/a[b]", reference: "../valid" },
		{ destination: "https://example.test/?q=[x]", reference: "../valid" },
		{ destination: "https://example.test/#[x]", reference: "../valid" },
		{ destination: "https://example.test/#first#second", reference: "../valid" },
		{ destination: "https://user[name]@example.test/", reference: "../valid" },
		{ destination: "https://example.test/", reference: "../a[b]" },
		{ destination: "https://example.test/", reference: "../?q=[x]" },
		{ destination: "https://example.test/", reference: "../#[x]" },
		{ destination: "https://example.test/", reference: "../#first#second" },
		{ destination: "https://example.test/", reference: "//user[name]@example.test/" },
	];

	for (const content of invalidContent) {
		assert.throws(() => queue.answer("elicitation-uri-brackets", {
			kind: "elicitation",
			response: { action: "accept", content },
		}), /URI|format/i);
		assert.deepEqual(pendingIds(queue), ["elicitation-uri-brackets"]);
	}

	assert.equal(isHttpElicitationUrl("https://example.test/a[b]"), false);
	assert.equal(isHttpElicitationUrl("https://example.test/?q=[x]"), false);
	assert.equal(isHttpElicitationUrl("https://example.test/#[x]"), false);
	assert.equal(isHttpElicitationUrl("https://example.test/#first#second"), false);
	assert.equal(isHttpElicitationUrl("https://user[name]@example.test/"), false);
	assert.equal(isHttpElicitationUrl("https://example.test/a%5Bb%5D"), true);
	assert.equal(isHttpElicitationUrl("https://[2001:db8::1]/path"), true);
});

test("URI formats retain encoded brackets, IPv6 hosts, and absolute and relative references", async () => {
	const queue = new InteractionQueue();
	const request = elicitationRequest(queue, "elicitation-uri-valid-components", {
		mode: "form",
		serverName: "test-server",
		message: "Provide valid URI values",
		requestedSchema: {
			type: "object",
			properties: {
				uri: { type: "string", format: "uri" },
				uriReference: { type: "string", format: "uri-reference" },
				absoluteUri: { type: "string", format: "uri" },
				relativeReference: { type: "string", format: "uri-reference" },
			},
			required: ["uri", "uriReference", "absoluteUri", "relativeReference"],
		},
	});
	const content = {
		uri: "https://[2001:db8::1]/a%5Bb%5D?q=%5Bx%5D#%5By%5D",
		uriReference: "//[2001:db8::2]/a%5Bb%5D?q=%5Bx%5D#%5By%5D",
		absoluteUri: "urn:example:resource",
		relativeReference: "../a%5Bb%5D?q=%5Bx%5D#%5By%5D",
	};

	assert.equal(queue.answer("elicitation-uri-valid-components", {
		kind: "elicitation",
		response: { action: "accept", content },
	}), true);
	assert.deepEqual((await elicitationResult(request.promise)).content, content);
	assert.equal(isHttpElicitationUrl(content.uri), true);
	assert.equal(isHttpElicitationUrl("https://[2001:db8::2]/a%5Bb%5D"), true);
});

test("unsupported elicitation schema can only be declined or cancelled", async () => {
	const queue = new InteractionQueue();
	const request = elicitationRequest(queue, "elicitation-unsupported", {
		mode: "form",
		serverName: "test-server",
		message: "Nested forms are not supported",
		requestedSchema: {
			type: "object",
			properties: { profile: { type: "object", properties: { name: { type: "string" } } } },
		},
	});
	const pending = formPending(queue);
	assert.equal(pending.form.supported, false);
	if (pending.form.supported) assert.fail("Nested forms must be declined as unsupported");
	assert.match(pending.form.reason, /nested|profile|unsupported/i);
	assert.throws(() => queue.answer("elicitation-unsupported", {
		kind: "elicitation",
		response: { action: "accept" },
	}), /unsupported/i);
	assert.deepEqual(pendingIds(queue), ["elicitation-unsupported"]);
	assert.equal(queue.answer("elicitation-unsupported", {
		kind: "elicitation",
		response: { action: "decline" },
	}), true);
	assert.deepEqual(await elicitationResult(request.promise), { action: "decline" });
	assert.deepEqual(pendingIds(queue), []);
});

test("array-level enum schema cannot be accepted", async () => {
	const queue = new InteractionQueue();
	const request = elicitationRequest(queue, "elicitation-array-enum", {
		mode: "form",
		serverName: "test-server",
		message: "Choose allowed tags",
		requestedSchema: {
			type: "object",
			properties: {
				tags: {
					type: "array",
					enum: [["red"]],
					items: { type: "string", enum: ["red", "blue"] },
				},
			},
		},
	});
	const pending = formPending(queue);

	assert.throws(() => queue.answer("elicitation-array-enum", {
		kind: "elicitation",
		response: { action: "accept", content: { tags: ["red"] } },
	}), /unsupported|enum/i);
	assert.equal(pending.form.supported, false);
	assert.deepEqual(pendingIds(queue), ["elicitation-array-enum"]);
	assert.equal(queue.answer("elicitation-array-enum", {
		kind: "elicitation",
		response: { action: "decline" },
	}), true);
	assert.deepEqual(await elicitationResult(request.promise), { action: "decline" });
});

test("URL elicitation is not opened automatically and cancellation is returned natively", async () => {
	const queue = new InteractionQueue();
	const url = "https://auth.example.test/authorize?state=one";
	const request = elicitationRequest(queue, "elicitation-url", {
		mode: "url",
		serverName: "test-server",
		message: "Sign in to continue",
		url,
		elicitationId: "elicitation-native-id",
	});
	const pending = urlPending(queue);
	assert.equal(pending.url, url);
	assert.equal(pending.canOpenUrl, true);
	assert.equal(isHttpElicitationUrl(url), true);
	assert.equal(isHttpElicitationUrl("javascript:alert(1)"), false);
	assert.equal(isHttpElicitationUrl("file:///etc/passwd"), false);

	assert.equal(queue.answer("elicitation-url", {
		kind: "elicitation",
		response: { action: "cancel" },
	}), true);
	assert.deepEqual(await elicitationResult(request.promise), { action: "cancel" });
	assert.deepEqual(pendingIds(queue), []);
});

test("cancelAll settles every request and prevents later answers", async () => {
	const queue = new InteractionQueue();
	const permission = permissionRequest(queue, "cancel-all-permission");
	const elicitation = elicitationRequest(queue, "cancel-all-elicitation", {
		mode: "url",
		serverName: "test-server",
		message: "Authenticate",
		url: "https://auth.example.test/",
	});

	queue.cancelAll("Session closed");
	assert.deepEqual(pendingIds(queue), []);
	assert.equal(permissionDeny(await permission.promise).behavior, "deny");
	assert.deepEqual(await elicitationResult(elicitation.promise), { action: "cancel" });
	assert.equal(queue.answer("cancel-all-permission", { kind: "permission", action: "allow-once" }), false);
	assert.equal(queue.answer("cancel-all-elicitation", { kind: "elicitation", response: { action: "accept" } }), false);

	const lateRequest = permissionRequest(queue, "late-after-close");
	assert.deepEqual(pendingIds(queue), []);
	assert.match(permissionDeny(await lateRequest.promise).message, /session closed/i);
});

test("callbacks after close do not replay settled allow or accept results", async () => {
	const queue = new InteractionQueue();
	const tool = permissionRequest(queue, "settled-tool-after-close");
	assert.equal(queue.answer("settled-tool-after-close", { kind: "permission", action: "allow-once" }), true);
	assert.equal(permissionAllow(await tool.promise).behavior, "allow");

	const elicitation = elicitationRequest(queue, "settled-elicitation-after-close", {
		mode: "url",
		serverName: "test-server",
		message: "Authenticate",
		url: "https://auth.example.test/",
	});
	assert.equal(queue.answer("settled-elicitation-after-close", {
		kind: "elicitation",
		response: { action: "accept" },
	}), true);
	assert.deepEqual(await elicitationResult(elicitation.promise), { action: "accept" });

	queue.cancelAll("Session closed after acceptance");
	const lateTool = permissionRequest(queue, "settled-tool-after-close");
	const lateToolResult = permissionDeny(await lateTool.promise);
	assert.match(lateToolResult.message, /session closed after acceptance/i);
	const lateElicitation = elicitationRequest(queue, "settled-elicitation-after-close", {
		mode: "url",
		serverName: "test-server",
		message: "Authenticate",
		url: "https://auth.example.test/",
	});
	assert.deepEqual(await elicitationResult(lateElicitation.promise), { action: "cancel" });
});

test("answer types cannot cross permission, question, and elicitation requests", async () => {
	const queue = new InteractionQueue();
	const permission = permissionRequest(queue, "typed-permission");
	const question = questionRequest(queue, "typed-question", questionInput([{ question: "Proceed?", options: [] }]));
	const elicitation = elicitationRequest(queue, "typed-elicitation", {
		mode: "url",
		serverName: "test-server",
		message: "Authenticate",
		url: "https://auth.example.test/",
	});

	assert.throws(() => queue.answer("typed-permission", { kind: "question", action: "cancel" } as InteractionAnswer), /does not match/i);
	assert.throws(() => queue.answer("typed-question", { kind: "permission", action: "allow-once" } as InteractionAnswer), /does not match/i);
	assert.throws(() => queue.answer("typed-elicitation", { kind: "permission", action: "deny" } as InteractionAnswer), /does not match/i);
	assert.deepEqual(pendingIds(queue), ["typed-permission", "typed-question", "typed-elicitation"]);

	queue.cancelAll("test cleanup");
	assert.equal(permissionDeny(await permission.promise).behavior, "deny");
	assert.equal(permissionDeny(await question.promise).behavior, "deny");
	assert.deepEqual(await elicitationResult(elicitation.promise), { action: "cancel" });
});

test("session close settles native interaction callbacks", async () => {
	const queue = new InteractionQueue();
	const fake = new FakeQueryHarness();
	const options = buildOptions(parseArgs([]), {
		canUseTool: queue.canUseTool,
		onElicitation: queue.onElicitation,
		hooks: {},
	});
	const session = startSession(options, {
		onMessage() {},
		onError() {},
		onClosing(reason: string) {
			queue.cancelAll(reason);
		},
	}, fake.createQuery);
	await session.ready;

	const pending = fake.parameters?.options?.canUseTool?.("Bash", { command: "echo close" }, {
		signal: new AbortController().signal,
		toolUseID: "tool-close",
		requestId: "request-close",
	});
	assert.deepEqual(pendingIds(queue), ["request-close"]);
	await session.close();
	assert.ok(pending);
	assert.equal(permissionDeny(await pending).behavior, "deny");
	assert.deepEqual(pendingIds(queue), []);
	assert.equal(queue.answer("request-close", { kind: "permission", action: "allow-once" }), false);
});
