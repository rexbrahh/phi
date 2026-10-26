import assert from "node:assert/strict";
import test from "node:test";
import { AppController } from "../src/ui/app.js";
import { FakeQueryHarness } from "./helpers/fake-query.js";
import { FakeTerminal } from "./helpers/terminal.js";
import { appDependencies, testLaunch, waitFor } from "./helpers/ui-app.js";

async function withApp(action: (app: AppController, terminal: FakeTerminal, fake: FakeQueryHarness) => Promise<void>) {
	const fake = new FakeQueryHarness();
	const terminal = new FakeTerminal();
	const app = new AppController(testLaunch(), appDependencies(fake, terminal));
	const running = app.run();
	try {
		await waitFor(() => app.ready !== undefined);
		await action(app, terminal, fake);
	} finally {
		await app.close(0);
		await running;
	}
}

function overlayText(app: AppController, terminal: FakeTerminal): string {
	const tui = app.views.tui as unknown as { compositeOverlays(lines: string[], columns: number, rows: number): string[] };
	return tui.compositeOverlays([], terminal.columns, terminal.rows).join("\n");
}

test("palette finds a command by name and preserves its filter through resize", async () => {
	await withApp(async (app, terminal, fake) => {
		app.setDraft("keep this draft");
		app.openCommandPalette();
		terminal.input("tasks");
		for (const [width, height] of [[80, 24], [60, 18], [120, 35]] as const) {
			terminal.resize(width, height);
			const rendered = overlayText(app, terminal);
			assert.match(rendered, /→ \/phi tasks/);
			assert.doesNotMatch(rendered, /No matching commands|\/phi quit/);
			assert.match(rendered, /Esc close/);
		}
		terminal.input("\r");
		await waitFor(() => app.views.active === "tasks");
		assert.equal(app.views.editor.getExpandedText(), "keep this draft");
		assert.equal(fake.receivedMessages.length, 0);
	});
});

test("Escape dismisses a notice without discarding the draft or exiting", async () => {
	await withApp(async (app, terminal, fake) => {
		app.setDraft("keep this draft");
		app.showNotice("Synthetic status details\nThe complete details remain readable.");
		assert.match(app.views.screen.root.render(80).join("\n"), /Esc dismisses this notice/);
		terminal.input("\u001b");
		assert.doesNotMatch(app.views.screen.root.render(80).join("\n"), /Synthetic status details/);
		assert.equal(app.views.editor.getExpandedText(), "keep this draft");
		assert.equal(fake.closeCalls, 0);
	});
});

test("a hidden permission advertises how to reopen it and retains its decision", async () => {
	await withApp(async (app, terminal, fake) => {
		const canUseTool = fake.parameters?.options?.canUseTool;
		assert.ok(canUseTool);
		const response = canUseTool("Read", { file_path: "/synthetic/file.ts" }, {
			requestId: "hidden-permission", toolUseID: "hidden-tool", signal: new AbortController().signal,
		});
		await waitFor(() => app.views.dialogs.requestId === "hidden-permission");
		terminal.input("\u001b");
		const rendered = app.views.screen.root.render(80).join("\n");
		assert.match(rendered, /Response waiting/);
		assert.match(rendered, /\/phi questions reopens it/);
		assert.equal(app.interactions.pending.length, 1);
		app.submitPrompt("/phi questions");
		await waitFor(() => overlayText(app, terminal).includes("Allow once"));
		terminal.input("d");
		assert.equal((await response)?.behavior, "deny");
		assert.equal(app.interactions.pending.length, 0);
	});
});

test("closing history restores the pending permission without answering it", async () => {
	await withApp(async (app, terminal, fake) => {
		const canUseTool = fake.parameters?.options?.canUseTool;
		assert.ok(canUseTool);
		const response = canUseTool("Read", { file_path: "/synthetic/file.ts" }, {
			requestId: "return-permission", toolUseID: "return-tool", signal: new AbortController().signal,
		});
		await waitFor(() => overlayText(app, terminal).includes("Allow once"));
		terminal.input("\u000f");
		assert.equal(app.views.active, "history");
		assert.doesNotMatch(overlayText(app, terminal), /Allow once/);
		terminal.input("\u001b");
		assert.equal(app.views.active, "transcript");
		assert.match(overlayText(app, terminal), /Allow once/);
		assert.equal(app.interactions.pending.length, 1);
		terminal.input("d");
		assert.equal((await response)?.behavior, "deny");
	});
});

test("closing a picker during validation prevents a later model change", async () => {
	await withApp(async (app, terminal, fake) => {
		fake.supportedModelsResult = [{ value: "model-a", displayName: "Model A" }];
		app.openModelPicker();
		await waitFor(() => terminal.output.includes("Model A"));
		let resolveModels!: (models: Awaited<ReturnType<typeof fake.query.supportedModels>>) => void;
		fake.query.supportedModels = () => new Promise((resolve) => { resolveModels = resolve; });
		terminal.input("\r");
		await waitFor(() => resolveModels !== undefined);
		terminal.input("\u001b");
		assert.equal(app.controlPickerVisible, false);
		resolveModels([{ value: "model-a", displayName: "Model A", description: "Synthetic model" }]);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(fake.setModelCalls, []);
		assert.equal(app.sessionControls.model, undefined);
	});
});

for (const kind of ["model", "effort"] as const) {
	test(`closing the ${kind} menu after a native change was issued still reports its result`, async () => {
		await withApp(async (app, terminal, fake) => {
			fake.supportedModelsResult = [{ value: "model-a", displayName: "Model A", supportedEffortLevels: ["high"] }];
			app.setSessionControl("model", "model-a");
			let finish!: () => void;
			const pending = () => new Promise<void>((resolve) => { finish = resolve; });
			if (kind === "model") fake.query.setModel = pending;
			else fake.query.applyFlagSettings = pending;
			if (kind === "model") app.openModelPicker();
			else app.openEffortPicker();
			await waitFor(() => terminal.output.includes(kind === "model" ? "Model A" : "Current effort"));
			terminal.input("\r");
			await waitFor(() => finish !== undefined);
			assert.match(overlayText(app, terminal), /Esc\/Ctrl\+C close/);
			terminal.input(kind === "model" ? "\u001b" : "\u0003");
			assert.equal(app.controlPickerVisible, false);
			finish();
			await waitFor(() => terminal.output.includes(kind === "model" ? "Model changed" : "Effort changed"));
			assert.equal(app.sessionControls[kind], kind === "model" ? "model-a" : "high");
		});
	});
}
