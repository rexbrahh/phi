import assert from "node:assert/strict";
import test from "node:test";
import type { SDKControlInitializeResponse } from "@anthropic-ai/claude-agent-sdk";
import { parseArgs } from "../src/config.js";
import { AppController, type AppDependencies } from "../src/ui/app.js";
import { FakeQueryHarness } from "./helpers/fake-query.js";
import { FakeSignals, FakeTerminal } from "./helpers/terminal.js";
import { resultMessage } from "./helpers/sdk-event-core.js";

const API_KEY = "phi_test_sdk_diagnostic_key";

test("transcript diagnostics redact the selected key in both previews and expanded details", async () => {
	const terminal = new FakeTerminal();
	const fake = new FakeQueryHarness();
	const controller = makeController(fake, terminal);
	const running = controller.run();
	try {
		await waitFor(() => controller.ready !== undefined);
		fake.pushMessage({ type: "system", subtype: "informational", level: "warning",
			content: `Synthetic warning ${API_KEY}\n${"detail\n".repeat(30)}complete diagnostic tail`,
			uuid: "1ce7a57b-caaa-4c6a-a2dc-35d260b8871a", session_id: "synthetic-session" });
		await waitFor(() => controller.state.notices.length === 1);
		assert.doesNotMatch(controller.views.transcript.render(80).join("\n"), new RegExp(API_KEY));
		terminal.input("/phi diagnostics");
		terminal.input("\r");
		await waitFor(() => diagnostics(controller).includes("complete diagnostic tail"));
		assertRedacted(controller, terminal, "Synthetic warning");
		assert.equal(fake.receivedMessages.length, 0);
	} finally {
		await controller.close(0);
		await running;
	}
});

function diagnostics(controller: AppController): string {
	const state = controller as unknown as { notice?: string; sessionError?: string };
	return [state.notice, state.sessionError].filter((value): value is string => value !== undefined).join("\n");
}

function assertRedacted(controller: AppController, terminal: FakeTerminal, usefulText: string): void {
	assert.equal(terminal.output.includes(API_KEY), false);
	assert.equal(diagnostics(controller).includes(API_KEY), false);
	assert.match(diagnostics(controller), new RegExp(usefulText));
}

function makeController(
	fake: FakeQueryHarness,
	terminal: FakeTerminal,
	additional: Partial<AppDependencies> = {},
): AppController {
	const launch = parseArgs([], { PHI_HOME: "/tmp/phi-ui-diagnostics-test-home" });
	return new AppController(launch, {
		environment: { ANTHROPIC_API_KEY: API_KEY },
		createQuery: fake.createQuery,
		terminal,
		readClipboardImage: async () => null,
		copyText: async () => undefined,
		readWorkspace: async (cwd) => ({ kind: "not-repository", cwd }),
		isInteractive: () => true,
		signals: new FakeSignals(),
		suspendProcess: () => undefined,
		...additional,
	});
}

async function waitFor(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!condition()) {
		if (Date.now() >= deadline) throw new Error("Timed out while waiting for the app condition.");
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

test("initialization errors redact the selected API key from terminal and app diagnostics", async () => {
	const terminal = new FakeTerminal();
	const fake = new FakeQueryHarness(Promise.reject(new Error(`Initialization rejected: ${API_KEY}`)));
	const controller = makeController(fake, terminal);

	assert.equal(await controller.run(), 1);
	assertRedacted(controller, terminal, "Initialization rejected");
});

test("SDK callback errors redact the selected API key from terminal and app diagnostics", async () => {
	const terminal = new FakeTerminal();
	const fake = new FakeQueryHarness();
	const controller = makeController(fake, terminal);
	const running = controller.run();

	try {
		await waitFor(() => controller.ready !== undefined);
		fake.failOutput(new Error(`SDK stream failed: ${API_KEY}`));
		assert.equal(await running, 1);
		assertRedacted(controller, terminal, "SDK stream failed");
	} finally {
		await controller.close(1);
	}
});

for (const subtype of ["error_max_budget_usd", "success"] as const) {
	test(`failed ${subtype} result displays the cause and sets error status`, async () => {
		const terminal = new FakeTerminal();
		const fake = new FakeQueryHarness();
		const controller = makeController(fake, terminal);
		const running = controller.run();
		try {
			await waitFor(() => controller.ready !== undefined);
			const detail = `Synthetic request failure: ${API_KEY}`;
			const result = resultMessage({ envelopeId: `failed-${subtype}` });
			fake.pushMessage(subtype === "success"
				? { ...result, subtype, is_error: true, result: detail }
				: { ...result, subtype, is_error: true, errors: [detail] });
			await waitFor(() => terminal.output.includes("Synthetic request failure"));
			assertRedacted(controller, terminal, "Synthetic request failure");
			assert.equal(terminal.programStatus?.state, "error");
			assert.equal(fake.closeCalls, 0);

			fake.pushMessage(resultMessage({ envelopeId: `recovered-${subtype}` }));
			await waitFor(() => terminal.programStatus?.state !== "error");
		} finally {
			await controller.close(0);
			await running;
		}
	});
}

test("picker failures redact the selected API key from the overlay", async () => {
	const terminal = new FakeTerminal();
	const fake = new FakeQueryHarness();
	fake.supportedModelsResult = [{ value: "synthetic", displayName: "Synthetic model" }];
	fake.query.setModel = async () => { throw new Error(`Model rejected: ${API_KEY}`); };
	const controller = makeController(fake, terminal);
	const running = controller.run();
	try {
		await waitFor(() => controller.ready !== undefined);
		controller.openModelPicker();
		await waitFor(() => terminal.output.includes("Synthetic model"));
		terminal.input("\r");
		await waitFor(() => terminal.output.includes("Model rejected"));
		assertRedacted(controller, terminal, "Model rejected");
		assert.equal(controller.controlPickerVisible, true);
	} finally {
		await controller.close(0);
		await running;
	}
});

test("replacement-session and query-cleanup errors redact the selected API key", async () => {
	const terminal = new FakeTerminal();
	const first = new FakeQueryHarness();
	const replacementReady = deferred<SDKControlInitializeResponse>();
	const replacement = new FakeQueryHarness(replacementReady.promise);
	replacement.closeError = new Error(`Replacement cleanup failed: ${API_KEY}`);
	let queryCount = 0;
	const controller = makeController(first, terminal, {
		createQuery: (parameters) => {
			queryCount += 1;
			return queryCount === 1 ? first.createQuery(parameters) : replacement.createQuery(parameters);
		},
	});
	const running = controller.run();

	try {
		await waitFor(() => controller.ready !== undefined);
		const transition = controller.replaceSession({ kind: "new" });
		await waitFor(() => replacement.parameters !== undefined);
		replacementReady.reject(new Error(`Replacement initialization failed: ${API_KEY}`));
		await transition;
		assertRedacted(controller, terminal, "Replacement initialization failed");
		assert.match(diagnostics(controller), /Replacement cleanup failed/u);
	} finally {
		await controller.close(1);
		await running;
	}
});
