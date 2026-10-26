import assert from "node:assert/strict";
import test from "node:test";
import { AppController } from "../src/ui/app.js";
import { FakeQueryHarness } from "./helpers/fake-query.js";
import { FakeTerminal } from "./helpers/terminal.js";
import { appDependencies, historyMessage, testLaunch, waitFor } from "./helpers/ui-app.js";

async function withController(
	terminal: FakeTerminal,
	action: (controller: AppController) => Promise<void>,
	dependencies: Parameters<typeof appDependencies>[2] = {},
): Promise<void> {
	const fake = new FakeQueryHarness();
	const controller = new AppController(testLaunch(), appDependencies(fake, terminal, dependencies));
	const running = controller.run();
	try {
		await waitFor(() => controller.ready !== undefined);
		await action(controller);
	} finally {
		await controller.close(0);
		await running;
	}
}

for (const [shortcut, input] of [
	["Ctrl+W", "\u0017"],
	["Alt+Backspace", "\u001b[127;3u"],
] as const) {
	test(`${shortcut} deletes the previous word in the composer`, async () => {
		const terminal = new FakeTerminal();
		await withController(terminal, async (controller) => {
			controller.setDraft("alpha beta");
			terminal.input(input);
			assert.equal(controller.views.editor.getText(), "alpha ");
		});
	});
}

test("Ctrl+Y restores the word deleted with Ctrl+W", async () => {
	const terminal = new FakeTerminal();
	await withController(terminal, async (controller) => {
		controller.setDraft("alpha beta");
		terminal.input("\u0017");
		assert.equal(controller.views.editor.getText(), "alpha ");
		terminal.input("\u0019");
		assert.equal(controller.views.editor.getText(), "alpha beta");
	});
});

test("Ctrl+F moves the editor cursor right so the next character is inserted there", async () => {
	const terminal = new FakeTerminal();
	await withController(terminal, async (controller) => {
		controller.setDraft("abcd");
		terminal.input("\u0001");
		terminal.input("\u0006");
		terminal.input("X");
		assert.equal(controller.views.editor.getText(), "aXbcd");
	});
});

test("Ctrl+Shift+W, Ctrl+Shift+F, and Ctrl+Shift+Y route Phi controls", async () => {
	const terminal = new FakeTerminal();
	const copied: string[] = [];
	const message = historyMessage("shortcut-history", "needle output");
	await withController(terminal, async (controller) => {
		controller.setDraft("needle");
		terminal.input("\u001b[119;6u");
		await waitFor(() => controller.views.active === "workspace");

		terminal.input("\u001b[102;6u");
		await waitFor(() => controller.views.active === "history" && controller.views.inspectors.model.historyMessages.length === 1);
		assert.equal(controller.views.inspectors.model.searchText, "needle");

		terminal.input("\u001b[121;6u");
		await waitFor(() => copied.length === 1);
		assert.equal(copied[0], "needle output");
	}, {
		createHistoryReader: () => ({
			list: async () => [],
			messages: async () => [message],
			agents: async () => [],
			agentMessages: async () => [],
			close: async () => undefined,
		}),
		readWorkspace: async (cwd) => ({ kind: "not-repository", cwd }),
		copyText: async (text) => { copied.push(text); },
	});
});

test("Alt+Backspace preserves attachments while deleting draft text and removes one on an empty draft", async () => {
	const terminal = new FakeTerminal();
	await withController(terminal, async (controller) => {
		controller.attachments.push({
			name: "image.png",
			sizeBytes: 1,
			mediaType: "image/png",
			block: { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } },
		});
		controller.setDraft("alpha beta");
		terminal.input("\u001b[127;3u");
		assert.equal(controller.views.editor.getText(), "alpha ");
		assert.equal(controller.attachments.length, 1);

		controller.setDraft("");
		terminal.input("\u001b[127;3u");
		assert.equal(controller.attachments.length, 0);
	});
});
