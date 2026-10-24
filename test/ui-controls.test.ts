import assert from "node:assert/strict";
import test from "node:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { AppController } from "../src/ui/app.js";
import { FakeQueryHarness, initializedResponse } from "./helpers/fake-query.js";
import { FakeTerminal } from "./helpers/terminal.js";
import { appDependencies, waitFor, testLaunch } from "./helpers/ui-app.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

async function withController(
	fake: FakeQueryHarness,
	terminal: FakeTerminal,
	action: (controller: AppController) => Promise<void>,
): Promise<void> {
	const controller = new AppController(testLaunch(), appDependencies(fake, terminal));
	const running = controller.run();
	try {
		await waitFor(() => controller.ready !== undefined);
		await action(controller);
	} finally {
		await controller.close(0);
		await running;
	}
}

function commandChanged(commands: Array<{ name: string; description: string; argumentHint: string }>): SDKMessage {
	return {
		type: "system",
		subtype: "commands_changed",
		commands,
		uuid: "00000000-0000-4000-8000-000000000101",
		session_id: "session-1",
	} as SDKMessage;
}

test("local dispatch preserves native prompts and the literal /phi send remainder", async () => {
	const terminal = new FakeTerminal();
	const fake = new FakeQueryHarness();
	await withController(fake, terminal, async (controller) => {
		controller.submitPrompt("  /model sonnet  ");
		controller.submitPrompt("@src/main.ts ");
		controller.submitPrompt("/phi send   literal remainder ");
		await fake.waitForInputCount(2);
		await new Promise<void>((resolve) => setTimeout(resolve, 20));

		assert.deepEqual(fake.receivedMessages.map((message) => message.message.content), [
			"  /model sonnet  ",
			"@src/main.ts ",
			"  literal remainder ",
		]);
		assert.equal(fake.closeCalls, 0);
	});
});

test("unknown local commands stay local and commands_changed refreshes completion", async () => {
	const terminal = new FakeTerminal();
	const fake = new FakeQueryHarness();
	await withController(fake, terminal, async (controller) => {
		const editor = controller.views.editor;
		const setProvider = editor.setAutocompleteProvider.bind(editor);
		let providerRefreshes = 0;
		editor.setAutocompleteProvider = (provider) => {
			providerRefreshes += 1;
			setProvider(provider);
		};

		controller.submitPrompt("/phi unsupported");
		await waitFor(() => terminal.output.includes("Unknown local command"));
		assert.match(terminal.output, /Unknown local command.*Use \/phi help/u);
		assert.equal(fake.receivedMessages.length, 0);
		fake.pushMessage(commandChanged([{ name: "fresh-command", description: "fresh", argumentHint: "" }]));
		await waitFor(() => controller.ready?.commands[0]?.name === "fresh-command");
		assert.equal(providerRefreshes, 1);
	});
});

test("Ctrl+Shift+P routes palette choices and preserves the composer draft", async () => {
	const terminal = new FakeTerminal();
	const initialization = initializedResponse();
	initialization.commands = [{ name: "initial-native", description: "Initial SDK command", argumentHint: "" }];
	const fake = new FakeQueryHarness(Promise.resolve(initialization));
	const controller = new AppController(testLaunch(), appDependencies(fake, terminal));
	const running = controller.run();
	try {
		await waitFor(() => controller.ready !== undefined);
		controller.setDraft("composer draft stays");
		terminal.input("\u001b[112;6u");
		await waitFor(() => terminal.output.includes("Command palette"));
		assert.match(terminal.output, /\/initial-native/u);
		assert.match(terminal.output, /\/phi tasks/u);
		assert.equal(controller.views.editor.getText(), "composer draft stays");

		terminal.input("\u001b");
		assert.equal(controller.views.editor.getText(), "composer draft stays");
		terminal.input("\u001b[112;6u");
		await waitFor(() => controller.commandPaletteVisible);
		terminal.output = "";
		fake.pushMessage(commandChanged([{ name: "updated-native", description: "Updated SDK command", argumentHint: "<value>" }]));
		await waitFor(() => controller.ready?.commands[0]?.name === "updated-native");
		await waitFor(() => terminal.output.includes("updated-native"));
		terminal.input("updated-native");
		terminal.input("\r");
		await fake.waitForInputCount(1);
		assert.equal(fake.receivedMessages[0]?.message.content, "/updated-native");
		assert.equal(controller.views.editor.getText(), "composer draft stays");

		terminal.input("\u001b[112;6u");
		terminal.input("phi tasks");
		terminal.input("\r");
		await waitFor(() => controller.views.active === "tasks");
		assert.equal(fake.receivedMessages.length, 1);
		assert.equal(controller.views.editor.getText(), "composer draft stays");
	} finally {
		await controller.close(0);
		await running;
	}
});

test("interrupt, background, and selected-task stop use distinct native controls", async () => {
	const terminal = new FakeTerminal();
	const fake = new FakeQueryHarness();
	await withController(fake, terminal, async (controller) => {
		controller.state.effectiveStatus.foreground = "running";
		controller.state.liveBackgroundTaskIds.add("background-1");
		controller.state.tasks.set("background-1", {
			taskId: "background-1",
			status: "running",
			ambient: false,
			isBackgrounded: true,
		});
		terminal.input("\u0003");
		await waitFor(() => fake.interruptCalls === 1);
		assert.deepEqual([...controller.state.liveBackgroundTaskIds], ["background-1"]);
		assert.deepEqual(fake.stopTaskCalls, []);
		assert.equal(fake.closeCalls, 0);

		terminal.input("\u0002");
		await waitFor(() => fake.backgroundTasksCalls === 1);
		assert.equal(fake.interruptCalls, 1);
		assert.deepEqual([...controller.state.liveBackgroundTaskIds], ["background-1"]);

		controller.showInspector("tasks");
		controller.state.tasks.set("selected-1", {
			taskId: "selected-1",
			status: "running",
			ambient: false,
			isBackgrounded: true,
		});
		await controller.selectTask("selected-1");
		terminal.input("x");
		await waitFor(() => fake.stopTaskCalls.length === 1);
		assert.deepEqual(fake.stopTaskCalls, ["selected-1"]);
		assert.equal(fake.interruptCalls, 1);
		assert.equal(fake.backgroundTasksCalls, 1);
		assert.equal(fake.parameters?.options?.perTaskStopAffordance, true);
	});
});

test("runtime model capabilities and accepted choices stay session-scoped", async () => {
	const terminal = new FakeTerminal();
	const fake = new FakeQueryHarness();
	fake.supportedModelsResult = [{
		value: "model-current",
		displayName: "Model Current",
		description: "test capability",
		supportsEffort: true,
		supportedEffortLevels: ["low", "high"],
	}];
	await withController(fake, terminal, async (controller) => {
		controller.submitPrompt("/phi model");
		await waitFor(() => fake.supportedModelsCalls === 1);
		await waitFor(() => terminal.output.includes("Model Current"));
		assert.match(terminal.output, /Model Current/u);
		controller.submitPrompt("/phi model model-current");
		controller.submitPrompt("/phi effort high");
		controller.submitPrompt("/phi workflow-size large");
		controller.submitPrompt("/phi ultracode on");
		await waitFor(() => fake.applyFlagSettingsCalls.length === 3);
		assert.deepEqual(fake.setModelCalls, ["model-current"]);
		assert.deepEqual(fake.applyFlagSettingsCalls, [
			{ effortLevel: "high" },
			{ workflowSizeGuideline: "large" },
			{ ultracode: true },
		]);
		await waitFor(() => terminal.output.includes("accepted by the SDK"));
		assert.match(terminal.output, /accepted by the SDK/u);
	});
});

test("failed native settings keep prior selections and report the SDK error", async () => {
	const terminal = new FakeTerminal();
	const fake = new FakeQueryHarness();
	fake.supportedModelsResult = [
		{ value: "model-current", displayName: "Model Current", supportedEffortLevels: ["low", "high"] },
		{ value: "model-next", displayName: "Model Next", supportedEffortLevels: ["high"] },
	];
	fake.setModelError = new Error("model rejected");
	fake.applyFlagSettingsError = new Error("effort rejected");
	await withController(fake, terminal, async (controller) => {
		controller.setSessionControl("model", "model-current");
		controller.setSessionControl("effort", "low");
		controller.submitPrompt("/phi model model-next");
		await waitFor(() => terminal.output.includes("model rejected"));
		assert.equal(controller.sessionControls.model, "model-current");

		controller.submitPrompt("/phi effort high");
		await waitFor(() => terminal.output.includes("effort rejected"));
		assert.equal(controller.sessionControls.effort, "low");
		assert.deepEqual(fake.applyFlagSettingsCalls, [{ effortLevel: "high" }]);
	});
});

test("/phi quit closes the SDK session and restores the terminal", async () => {
	const terminal = new FakeTerminal();
	const fake = new FakeQueryHarness();
	const controller = new AppController(testLaunch(), appDependencies(fake, terminal));
	const running = controller.run();
	await waitFor(() => controller.ready !== undefined);
	controller.submitPrompt("/phi quit");
	assert.equal(await running, 0);
	assert.equal(fake.closeCalls, 1);
	assert.equal(terminal.stopCalls, 1);
});

test("/phi quit shows a stop-and-exit confirmation while work remains", async () => {
	const terminal = new FakeTerminal();
	const fake = new FakeQueryHarness();
	const controller = new AppController(testLaunch(), appDependencies(fake, terminal));
	const running = controller.run();
	await waitFor(() => controller.ready !== undefined);
	controller.state.liveBackgroundTaskIds.add("background-before-exit");

	terminal.input("/phi quit");
	terminal.input("\r");
	await waitFor(() => terminal.output.includes("Exit Phi?"));
	assert.equal(fake.closeCalls, 0);
	assert.equal(terminal.stopCalls, 0);
	assert.match(terminal.output, /Stop work and exit Phi/u);

	terminal.input("\r");
	assert.equal(await running, 0);
	assert.equal(fake.closeCalls, 1);
	assert.equal(terminal.stopCalls, 1);
});

test("session switch blocks prompts and literal sends across target replacement", async () => {
	const terminal = new FakeTerminal();
	const first = new FakeQueryHarness();
	const second = new FakeQueryHarness();
	const interrupt = deferred<Awaited<ReturnType<typeof first.query.interrupt>>>();
	first.query.interrupt = () => {
		first.interruptCalls += 1;
		return interrupt.promise;
	};
	let queryCount = 0;
	const controller = new AppController(testLaunch(), appDependencies(first, terminal, {
		createQuery: (parameters) => {
			queryCount += 1;
			return queryCount === 1 ? first.createQuery(parameters) : second.createQuery(parameters);
		},
	}));
	const running = controller.run();
	try {
		await waitFor(() => controller.ready !== undefined);
		controller.state.effectiveStatus.foreground = "running";
		controller.submitPrompt("/phi new");
		controller.submitPrompt("/phi new");
		await waitFor(() => first.interruptCalls === 1);

		controller.submitPrompt("keep ordinary draft");
		const draftPreserved = controller.views.editor.getText() === "keep ordinary draft";
		controller.submitPrompt("/phi send   literal draft");
		const literalDraftPreserved = controller.views.editor.getText() === "  literal draft";
		await new Promise<void>((resolve) => setImmediate(resolve));
		const messagesWhileInterruptPending = first.receivedMessages.length;

		interrupt.resolve(undefined);
		await waitFor(() => second.parameters !== undefined && controller.ready !== undefined);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(draftPreserved, true);
		assert.equal(literalDraftPreserved, true);
		assert.equal(messagesWhileInterruptPending, 0);
		assert.equal(first.receivedMessages.length, 0);
		assert.equal(second.receivedMessages.length, 0);
		assert.equal(controller.views.editor.getText(), "  literal draft");
	} finally {
		interrupt.resolve(undefined);
		await controller.close(0);
		await running;
	}
});

test("failed session stop blocks queued literal sends and preserves both drafts", async () => {
	const terminal = new FakeTerminal();
	const first = new FakeQueryHarness();
	const second = new FakeQueryHarness();
	const stop = deferred<void>();
	first.query.stopTask = (taskId) => {
		first.stopTaskCalls.push(taskId);
		return stop.promise;
	};
	let queryCount = 0;
	const controller = new AppController(testLaunch(), appDependencies(first, terminal, {
		createQuery: (parameters) => {
			queryCount += 1;
			return queryCount === 1 ? first.createQuery(parameters) : second.createQuery(parameters);
		},
	}));
	const running = controller.run();
	try {
		await waitFor(() => controller.ready !== undefined);
		const originalSessionId = controller.currentSessionId;
		controller.state.liveBackgroundTaskIds.add("background-1");
		controller.submitPrompt("/phi new");
		controller.submitPrompt("/phi new");
		await waitFor(() => first.stopTaskCalls.length === 1);

		controller.submitPrompt("ordinary draft");
		const ordinaryDraftPreserved = controller.views.editor.getText() === "ordinary draft";
		controller.submitPrompt("/phi send   literal draft");
		await new Promise<void>((resolve) => setImmediate(resolve));
		const messagesWhileStopPending = first.receivedMessages.length;
		const literalDraftPreserved = controller.views.editor.getText() === "  literal draft";
		assert.equal(second.receivedMessages.length, 0);

		stop.reject(new Error("stop denied"));
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(messagesWhileStopPending, 0);
		assert.equal(ordinaryDraftPreserved, true);
		assert.equal(literalDraftPreserved, true);
		assert.equal(first.receivedMessages.length, 0);
		assert.equal(first.closeCalls, 0);
		assert.equal(second.parameters, undefined);
		assert.equal(controller.currentSessionId, originalSessionId);
		assert.equal(controller.views.editor.getText(), "  literal draft");
	} finally {
		stop.resolve();
		await controller.close(0);
		await running;
	}
});
