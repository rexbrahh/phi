import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { SDKControlInitializeResponse } from "@anthropic-ai/claude-agent-sdk";
import { parseArgs, type LaunchOptions } from "../src/config.js";
import { runCli, type CliDependencies } from "../src/cli-main.js";
import { AppController } from "../src/ui/app.js";
import { FakeQueryHarness, initializedResponse } from "./helpers/fake-query.js";
import { assistantMessage, nativeUuid, textBlock } from "./helpers/sdk-event-core.js";
import { sdkStatus, taskStarted } from "./helpers/sdk-task-events.js";
import { FakeSignals, FakeTerminal } from "./helpers/terminal.js";

async function withLaunch(run: (launch: LaunchOptions) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "phi-startup-cleanup-"));
	try {
		const environment = { PHI_HOME: join(root, "phi-home") };
		await run(parseArgs(["--cwd", root], environment));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

function makeController(launch: LaunchOptions, fake: FakeQueryHarness, terminal: FakeTerminal): AppController {
	return new AppController(launch, {
		environment: { PHI_HOME: launch.home },
		createQuery: fake.createQuery,
		terminal,
		readClipboardImage: async () => null,
		copyText: async () => undefined,
		readWorkspace: async (cwd) => ({ kind: "not-repository", cwd }),
		isInteractive: () => true,
		signals: new FakeSignals(),
		suspendProcess: () => undefined,
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
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function sessionDiagnostic(controller: AppController): string {
	return (controller as unknown as { sessionError?: string }).sessionError ?? "";
}

test("delayed SDK readiness preserves an early pasted draft through streamed events", async () => {
	await withLaunch(async (launch) => {
		const terminal = new FakeTerminal();
		const initialization = deferred<SDKControlInitializeResponse>();
		const fake = new FakeQueryHarness(initialization.promise);
		const controller = makeController(launch, fake, terminal);
		const running = controller.run();
		void running.catch(() => undefined);

		try {
			await waitFor(() => fake.parameters !== undefined);
			terminal.input("\u001b[200~draft pasted before readiness\u001b[201~");
			terminal.input(" typed while starting");
			const draft = "draft pasted before readiness typed while starting";
			assert.equal(controller.views.editor.getExpandedText(), draft);

			terminal.input("\r");
			assert.equal(fake.receivedMessages.length, 0);
			assert.equal(controller.views.editor.getExpandedText(), draft);

			fake.pushMessage(sdkStatus("requesting", "startup-status"));
			fake.pushMessage(taskStarted({ envelopeId: "startup-task", taskId: "startup-task", runId: "startup-run" }));
			fake.pushMessage(assistantMessage({
				envelopeId: "startup-assistant",
				modelMessageId: "startup-message",
				content: [textBlock("output while the composer is active")],
			}));
			await waitFor(() => controller.state.conversationBlocks.length === 1);
			assert.equal(controller.state.effectiveStatus.phase, "requesting");
			assert.equal(controller.views.editor.getExpandedText(), draft);

			initialization.resolve(initializedResponse());
			await waitFor(() => controller.ready !== undefined);
			terminal.input("\r");
			await fake.waitForInputCount(1);
			assert.equal(fake.receivedMessages[0]?.message.content, draft);
			assert.deepEqual(fake.receivedMessages[0]?.inline_pastes, ["draft pasted before readiness"]);

			controller.setDraft("draft edited during later output");
			fake.pushMessage(assistantMessage({
				envelopeId: "later-assistant",
				modelMessageId: "later-message",
				content: [textBlock("later SDK output")],
			}));
			await waitFor(() => controller.state.conversationBlocks.length === 2);
			assert.equal(controller.views.editor.getExpandedText(), "draft edited during later output");

			await controller.close(0);
			assert.equal(await running, 0);
			assert.deepEqual([fake.closeCalls, terminal.stopCalls], [1, 1]);
		} finally {
			initialization.resolve(initializedResponse());
			await controller.close(1).catch(() => undefined);
			await running.catch(() => undefined);
		}
	});
});

test("initialization failure after input keeps the draft and restores the terminal", async () => {
	await withLaunch(async (launch) => {
		const terminal = new FakeTerminal();
		const initialization = deferred<SDKControlInitializeResponse>();
		const fake = new FakeQueryHarness(initialization.promise);
		const controller = makeController(launch, fake, terminal);
		const running = controller.run();
		void running.catch(() => undefined);

		try {
			await waitFor(() => fake.parameters !== undefined);
			terminal.input("draft before initialization fails");
			fake.pushMessage(sdkStatus("requesting", "before-init-failure"));
			await waitFor(() => controller.state.effectiveStatus.phase === "requesting");
			initialization.reject(new Error("synthetic initialization failure after input"));

			assert.equal(await running, 1);
			assert.equal(controller.views.editor.getExpandedText(), "draft before initialization fails");
			assert.match(sessionDiagnostic(controller), /synthetic initialization failure after input/u);
			assert.match(terminal.output, /Could not start Phi: synthetic initialization failure after input/u);
			assert.deepEqual([fake.closeCalls, terminal.stopCalls], [1, 1]);
			assert.equal(terminal.programStatus?.state, "clear");
			assert.equal(terminal.progress, false);
		} finally {
			initialization.resolve(initializedResponse());
			await controller.close(1).catch(() => undefined);
			await running.catch(() => undefined);
		}
	});
});

test("SDK stream failure renders its diagnostic and returns a nonzero CLI code", async () => {
	await withLaunch(async (launch) => {
		const terminal = new FakeTerminal();
		const fake = new FakeQueryHarness();
		const controller = makeController(launch, fake, terminal);
		const stdout: string[] = [];
		const stderr: string[] = [];
		const dependencies: CliDependencies = {
			environment: { PHI_HOME: launch.home },
			userHome: launch.home,
			isInteractive: () => true,
			stdout: { write: (text) => { stdout.push(text); } },
			stderr: { write: (text) => { stderr.push(text); } },
			resolvePhiHome: () => launch.home,
			ensurePhiHome: async () => undefined,
			preparePhiAuth: async (_home, environment) => environment,
			loginPhiAuth: async () => false,
			phiAuthSource: async () => "missing",
			readPhiApiKey: async () => undefined,
			deletePhiApiKey: async () => undefined,
			promptForApiKey: async () => undefined,
			importCustomizations: async () => ({ imported: [], skipped: [] }),
			runApp: (resolvedLaunch) => {
				assert.equal(resolvedLaunch.cwd, launch.cwd);
				return controller.run();
			},
			readVersion: async () => "test",
		};
		const running = runCli(["--cwd", launch.cwd], dependencies);

		try {
			await waitFor(() => controller.ready !== undefined);
			fake.failOutput(new Error("synthetic SDK stream failure"));
			assert.equal(await running, 1);
			assert.match(terminal.output, /Session ended with an error: synthetic SDK stream failure/u);
			assert.match(sessionDiagnostic(controller), /synthetic SDK stream failure/u);
			assert.deepEqual([stdout, stderr], [[], []]);
			assert.deepEqual([fake.closeCalls, terminal.stopCalls], [1, 1]);
		} finally {
			await controller.close(1).catch(() => undefined);
			await running.catch(() => undefined);
		}
	});
});

test("an asynchronous render callback failure cannot strand shutdown", async () => {
	class ErrorStatusFailureTerminal extends FakeTerminal {
		errorStatusCalls = 0;

		override setProgramStatus(status: Parameters<FakeTerminal["setProgramStatus"]>[0]): void {
			if (status.state === "error") {
				this.errorStatusCalls += 1;
				throw new Error("synthetic asynchronous render callback failure");
			}
			super.setProgramStatus(status);
		}
	}

	await withLaunch(async (launch) => {
		const terminal = new ErrorStatusFailureTerminal();
		const fake = new FakeQueryHarness();
		const controller = makeController(launch, fake, terminal);
		const running = controller.run();
		let settled = false;
		void running.then(() => { settled = true; }, () => { settled = true; });
		void running.catch(() => undefined);

		try {
			await waitFor(() => controller.ready !== undefined);
			fake.failOutput(new Error("synthetic SDK failure during render"));
			await waitFor(() => terminal.errorStatusCalls >= 2 || settled);
			await waitFor(() => settled);
			assert.equal(await running, 1);
			assert.match(sessionDiagnostic(controller), /synthetic asynchronous render callback failure/u);
			assert.ok(terminal.errorStatusCalls >= 2);
			assert.deepEqual([fake.closeCalls, terminal.stopCalls], [1, 1]);
			assert.equal(terminal.programStatus?.state, "clear");
		} finally {
			await controller.close(1).catch(() => undefined);
			await running.catch(() => undefined);
		}
	});
});

test("SDK output arriving after close is ignored before terminal cleanup completes", async () => {
	await withLaunch(async (launch) => {
		const terminal = new FakeTerminal();
		const fake = new FakeQueryHarness();
		fake.query.close = () => { fake.closeCalls += 1; };
		const controller = makeController(launch, fake, terminal);
		const running = controller.run();

		try {
			await waitFor(() => controller.ready !== undefined);
			const closing = controller.close(0);
			await waitFor(() => fake.closeCalls === 1);
			fake.pushMessage(sdkStatus("requesting", "message-after-close"));
			fake.finishOutput();
			await closing;

			assert.equal(await running, 0);
			assert.equal(controller.state.effectiveStatus.phase, null);
			assert.equal(controller.state.seenEnvelopeIds.has(nativeUuid("message-after-close")), false);
			assert.equal(terminal.stopCalls, 1);
		} finally {
			fake.finishOutput();
			await controller.close(1).catch(() => undefined);
			await running.catch(() => undefined);
		}
	});
});
