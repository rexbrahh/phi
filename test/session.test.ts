import assert from "node:assert/strict";
import { test } from "node:test";
import { buildOptions, parseArgs } from "../src/config.js";
import { startSession } from "../src/session.js";
import {
	FakeQueryHarness,
	initializedResponse,
	optionCallbacks,
	sdkMessage,
	userMessage,
} from "./helpers/fake-query.js";

test("api_route_mismatch_sends_no_prompt", async () => {
	const fake = new FakeQueryHarness(Promise.resolve(initializedResponse({
		apiProvider: "firstParty",
		apiKeySource: "oauth",
	})));
	const session = startSession(buildOptions(parseArgs([]), optionCallbacks()), {
		onMessage() {},
		onError() {},
	}, fake.createQuery);

	await session.ready;
	assert.throws(() => session.send(userMessage("must not be sent")), /first-party API-key route.*key source=oauth/);
	await session.close();
	assert.deepEqual(fake.receivedMessages, []);
});

test("accepted first-party API-key sources allow streamed prompts", async () => {
	for (const apiKeySource of ["ANTHROPIC_API_KEY", "apiKeyHelper", "/login managed key"]) {
		const fake = new FakeQueryHarness(Promise.resolve(initializedResponse({
			apiProvider: "firstParty",
			apiKeySource,
		})));
		const session = startSession(buildOptions(parseArgs([]), optionCallbacks()), {
			onMessage() {},
			onError() {},
		}, fake.createQuery);

		await session.ready;
		session.send(userMessage(apiKeySource));
		await fake.waitForInputCount(1);
		assert.deepEqual(fake.receivedMessages, [userMessage(apiKeySource)]);
		await session.close();
	}
});

test("initialization_consumes_callbacks_before_first_prompt", async () => {
	const fake = new FakeQueryHarness();
	const seen: unknown[] = [];
	let notifySeen!: () => void;
	const seenMessage = new Promise<void>((resolve) => {
		notifySeen = resolve;
	});
	const callbacks = optionCallbacks();
	const session = startSession(buildOptions(parseArgs([]), callbacks), {
		onMessage(message) {
			seen.push(message);
		notifySeen();
		},
		onError(error) {
			seen.push(error);
		},
	}, fake.createQuery);

	fake.pushMessage(sdkMessage());
	await session.ready;
	await seenMessage;
	assert.equal(seen.length, 1);
	assert.equal(fake.parameters?.options?.canUseTool, callbacks.canUseTool);
	assert.equal(fake.parameters?.options?.onElicitation, callbacks.onElicitation);
	assert.equal(fake.parameters?.options?.hooks, callbacks.hooks);
	const prompt = fake.parameters?.prompt;
	assert.ok(prompt && typeof prompt !== "string");
	assert.equal(typeof prompt[Symbol.asyncIterator], "function");
	assert.deepEqual(fake.parameters?.options?.systemPrompt, { type: "preset", preset: "claude_code" });
	assert.deepEqual(fake.parameters?.options?.tools, { type: "preset", preset: "claude_code" });
	assert.deepEqual(fake.parameters?.options?.settingSources, ["user", "project", "local"]);
	assert.deepEqual(fake.parameters?.options?.extraArgs, { "replay-user-messages": null });
	assert.equal(fake.receivedMessages.length > 0, false);

	session.send(userMessage("first prompt"));
	await fake.waitForInputCount(1);
	assert.deepEqual(fake.receivedMessages, [userMessage("first prompt")]);
	await session.close();
});

test("initialization rejection reports the error and keeps input closed", async () => {
	const initializationError = new Error("initialization failed");
	const fake = new FakeQueryHarness(Promise.reject(initializationError));
	const errors: unknown[] = [];
	const session = startSession(buildOptions(parseArgs([]), optionCallbacks()), {
		onMessage() {},
		onError(error) {
			errors.push(error);
		},
	}, fake.createQuery);

	await assert.rejects(session.ready, initializationError);
	assert.deepEqual(errors, [initializationError]);
	assert.throws(() => session.send(userMessage("blocked")), /ready/);
	await assert.rejects(session.close(), initializationError);
});

test("iterator failure is reported and remains observable through done", async () => {
	const iteratorError = new Error("reader failed");
	const fake = new FakeQueryHarness();
	const errors: unknown[] = [];
	const session = startSession(buildOptions(parseArgs([]), optionCallbacks()), {
		onMessage() {},
		onError(error) {
			errors.push(error);
		},
	}, fake.createQuery);

	await session.ready;
	fake.failOutput(iteratorError);
	await assert.rejects(session.done, iteratorError);
	assert.deepEqual(errors, [iteratorError]);
	await assert.rejects(session.close(), iteratorError);
});

test("close settles an empty input iterator and calls native close once", async () => {
	const fake = new FakeQueryHarness();
	const session = startSession(buildOptions(parseArgs([]), optionCallbacks()), {
		onMessage() {},
		onError() {},
	}, fake.createQuery);

	await session.ready;
	await session.close();
	await fake.inputDone;
	assert.deepEqual(fake.receivedMessages, []);
	assert.equal(fake.closeCalls, 1);
});

test("repeated close shares one native shutdown", async () => {
	const fake = new FakeQueryHarness();
	const session = startSession(buildOptions(parseArgs([]), optionCallbacks()), {
		onMessage() {},
		onError() {},
	}, fake.createQuery);
	await session.ready;

	await Promise.all([session.close(), session.close(), session.close()]);
	assert.equal(fake.closeCalls, 1);
});

test("reentrant close from onClosing shares the published promise", async () => {
	const initializationError = new Error("initialization failed");
	const nativeCloseError = new Error("native close failed");
	const callbackError = new Error("onClosing failed");
	const fake = new FakeQueryHarness(Promise.reject(initializationError));
	fake.closeError = nativeCloseError;
	let session: ReturnType<typeof startSession>;
	let reentrantClose: Promise<void> | undefined;
	let onClosingCalls = 0;
	session = startSession(buildOptions(parseArgs([]), optionCallbacks()), {
		onMessage() {},
		onError() {},
		onClosing() {
			onClosingCalls += 1;
			if (onClosingCalls === 1) reentrantClose = session.close();
			throw callbackError;
		},
	}, fake.createQuery);

	await assert.rejects(session.ready, initializationError);
	const closing = session.close();
	const nativeCloseCallsAtReturn = fake.closeCalls;
	const onClosingCallsAtReturn = onClosingCalls;
	const outcomes = await Promise.allSettled([closing, reentrantClose!]);

	assert.deepEqual({
		reentrantReturnedSamePromise: reentrantClose === closing,
		nativeCloseCallsAtReturn,
		nativeCloseCalls: fake.closeCalls,
		onClosingCallsAtReturn,
		onClosingCalls,
	}, {
		reentrantReturnedSamePromise: true,
		nativeCloseCallsAtReturn: 1,
		nativeCloseCalls: 1,
		onClosingCallsAtReturn: 1,
		onClosingCalls: 1,
	});
	assert.deepEqual(outcomes, [
		{ status: "rejected", reason: nativeCloseError },
		{ status: "rejected", reason: nativeCloseError },
	]);
});

test("send rejects as soon as shutdown begins", async () => {
	const fake = new FakeQueryHarness();
	const session = startSession(buildOptions(parseArgs([]), optionCallbacks()), {
		onMessage() {},
		onError() {},
	}, fake.createQuery);
	await session.ready;

	const closing = session.close();
	assert.throws(() => session.send(userMessage("too late")), /closing|closed/);
	await closing;
	assert.throws(() => session.send(userMessage("still too late")), /closed/);
});

test("stderr is captured to a bounded session view without terminal output", async () => {
	const fake = new FakeQueryHarness();
	const session = startSession(buildOptions(parseArgs([]), optionCallbacks()), {
		onMessage() {},
		onError() {},
	}, fake.createQuery);
	const stderr = fake.parameters?.options?.stderr;
	assert.equal(typeof stderr, "function");
	stderr?.("startup-error:");
	stderr?.("x".repeat(100_000));
	assert.ok(session.stderr.length <= 16_384);
	assert.ok(session.stderr.startsWith("startup-error:"));
	await session.close();
});
