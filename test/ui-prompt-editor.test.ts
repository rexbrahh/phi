import assert from "node:assert/strict";
import test from "node:test";
import { AppController } from "../src/ui/app.js";
import { FakeQueryHarness } from "./helpers/fake-query.js";
import { FakeSignals, FakeTerminal } from "./helpers/terminal.js";
import { appDependencies, testLaunch, waitFor } from "./helpers/ui-app.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((accept) => { resolve = accept; });
	return { promise, resolve };
}

test("Ctrl+G hands the draft to the editor and restores Phi without submitting", async () => {
	const terminal = new FakeTerminal();
	const fake = new FakeQueryHarness();
	const signals = new FakeSignals();
	const edited = deferred<string>();
	let received = "";
	const controller = new AppController(testLaunch(), appDependencies(fake, terminal, {
		signals,
		editPrompt: async (draft) => { received = draft; return edited.promise; },
	}));
	const running = controller.run();
	try {
		await waitFor(() => controller.ready !== undefined);
		controller.setDraft("first\n界🙂");
		terminal.input("\u0007");
		await waitFor(() => received.length > 0);
		assert.equal(received, "first\n界🙂");
		assert.equal(terminal.stopCalls, 1);
		signals.emit("SIGINT");
		assert.equal(fake.closeCalls, 0);
		edited.resolve("edited\n界🙂\n");
		await waitFor(() => terminal.startCalls === 2);
		assert.equal(controller.views.editor.getExpandedText(), "edited\n界🙂\n");
		assert.equal(controller.views.editor.focused, true);
		assert.equal(fake.receivedMessages.length, 0);
	} finally { await controller.close(0); await running; }
});

test("editor failure keeps the draft and restores terminal input", async () => {
	const terminal = new FakeTerminal();
	const fake = new FakeQueryHarness();
	const controller = new AppController(testLaunch(), appDependencies(fake, terminal, {
		editPrompt: async () => { throw new Error("editor exited with status 1"); },
	}));
	const running = controller.run();
	try {
		await waitFor(() => controller.ready !== undefined);
		controller.setDraft("keep original");
		await controller.openPromptEditor();
		assert.equal(controller.views.editor.getExpandedText(), "keep original");
		assert.equal(terminal.startCalls, 2);
		terminal.input("!");
		assert.equal(controller.views.editor.getExpandedText(), "keep original!");
		assert.equal(fake.receivedMessages.length, 0);
	} finally { await controller.close(0); await running; }
});

test("shutdown aborts an active editor and does not restart the terminal", async () => {
	const terminal = new FakeTerminal();
	const fake = new FakeQueryHarness();
	let activeSignal: AbortSignal | undefined;
	const controller = new AppController(testLaunch(), appDependencies(fake, terminal, {
		editPrompt: async (_text, _cwd, _environment, signal) => {
			activeSignal = signal;
			return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
		},
	}));
	const running = controller.run();
	await waitFor(() => controller.ready !== undefined);
	const editing = controller.openPromptEditor();
	await waitFor(() => activeSignal !== undefined);
	await controller.close(0);
	await editing;
	await running;
	assert.equal(activeSignal?.aborted, true);
	assert.equal(terminal.startCalls, 1);
	assert.equal(terminal.stopCalls, 1);
});


test("terminal restart failure closes the SDK and restores the terminal", async () => {
	const terminal = new FakeTerminal();
	const start = terminal.start.bind(terminal);
	terminal.start = (...args) => {
		if (terminal.startCalls > 0) throw new Error("terminal restart failed");
		start(...args);
	};
	const fake = new FakeQueryHarness();
	const controller = new AppController(testLaunch(), appDependencies(fake, terminal, {
		editPrompt: async () => "edited draft",
	}));
	const running = controller.run();
	try {
		await waitFor(() => controller.ready !== undefined);
		await assert.doesNotReject(controller.openPromptEditor());
		assert.equal(await running, 1);
		assert.equal(fake.closeCalls, 1);
		assert.equal(terminal.stopCalls, 2);
	} finally { await controller.close(0); await running; }
});
