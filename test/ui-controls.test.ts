import assert from "node:assert/strict";
import test from "node:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { parseArgs } from "../src/config.js";
import { AppController } from "../src/ui/app.js";
import { FakeQueryHarness, initializedResponse } from "./helpers/fake-query.js";
import { FakeTerminal } from "./helpers/terminal.js";
import { appDependencies, waitFor } from "./helpers/ui-app.js";

async function withController(
	fake: FakeQueryHarness,
	terminal: FakeTerminal,
	action: (controller: AppController) => Promise<void>,
): Promise<void> {
	const controller = new AppController(parseArgs([]), appDependencies(fake, terminal));
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
	const controller = new AppController(parseArgs([]), appDependencies(fake, terminal));
	const running = controller.run();
	await waitFor(() => controller.ready !== undefined);
	controller.submitPrompt("/phi quit");
	assert.equal(await running, 0);
	assert.equal(fake.closeCalls, 1);
	assert.equal(terminal.stopCalls, 1);
});
