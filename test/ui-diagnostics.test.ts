import assert from "node:assert/strict";
import test from "node:test";
import type { SDKControlInitializeResponse } from "@anthropic-ai/claude-agent-sdk";
import { parseArgs } from "../src/config.js";
import { AppController, type AppDependencies } from "../src/ui/app.js";
import { FakeQueryHarness } from "./helpers/fake-query.js";
import { FakeSignals, FakeTerminal } from "./helpers/terminal.js";

const API_KEY = "phi_test_sdk_diagnostic_key";

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
