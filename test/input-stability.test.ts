import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	StdinBuffer,
	isKittyProtocolActive,
	setKittyProtocolActive,
} from "@earendil-works/pi-tui";
import { parseArgs } from "../src/config.js";
import { AppController, type AppDependencies } from "../src/ui/app.js";
import { FakeQueryHarness } from "./helpers/fake-query.js";
import { FakeSignals, FakeTerminal } from "./helpers/terminal.js";
import { streamEvent, textDelta, textStreamStart } from "./helpers/sdk-events.js";

class DecodedFakeTerminal extends FakeTerminal {
	private readonly inputDecoder = new StdinBuffer();

	constructor() {
		super();
		this.inputDecoder.on("data", (sequence) => this.input(sequence));
		this.inputDecoder.on("paste", (content) => this.input(`\x1b[200~${content}\x1b[201~`));
	}

	feed(data: string): void {
		this.inputDecoder.process(data);
	}

	destroy(): void {
		this.inputDecoder.destroy();
	}
}

async function waitFor(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!condition()) {
		if (Date.now() >= deadline) throw new Error("Timed out while waiting for the app condition.");
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
}

async function withApp(run: (context: {
	controller: AppController;
	fake: FakeQueryHarness;
	terminal: DecodedFakeTerminal;
}) => Promise<void>): Promise<void> {
	const priorKittyState = isKittyProtocolActive();
	const home = mkdtempSync(join(tmpdir(), "phi-input-home-"));
	const project = mkdtempSync(join(tmpdir(), "phi-input-project-"));
	const environment: NodeJS.ProcessEnv = {
		PHI_HOME: home,
		CLAUDE_CONFIG_DIR: join(home, "legacy-config"),
		CLAUDE_CODE_PLUGIN_CACHE_DIR: join(home, "legacy-plugin-cache"),
	};
	setKittyProtocolActive(true);
	const terminal = new DecodedFakeTerminal();
	const fake = new FakeQueryHarness();
	const controller = new AppController(parseArgs(["--cwd", project], environment), {
		environment,
		createQuery: fake.createQuery,
		terminal,
		readClipboardImage: async () => null,
		copyText: async () => undefined,
		isInteractive: () => true,
		signals: new FakeSignals(),
		suspendProcess: () => undefined,
	});
	const running = controller.run();
	try {
		await waitFor(() => terminal.startCalls === 1 && controller.ready !== undefined);
		await run({ controller, fake, terminal });
	} finally {
		try {
			await controller.close(0);
			await running;
		} finally {
			terminal.destroy();
			setKittyProtocolActive(priorKittyState);
			rmSync(project, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	}
}

test("Kitty release events do not repeat app-level hotkeys", async () => {
	await withApp(async ({ controller, terminal }) => {
		terminal.feed("\x1b[112;6:1u");
		assert.equal(controller.commandPaletteVisible, true);

		terminal.feed("\x1b[112;6:3u");
		assert.equal(controller.commandPaletteVisible, true);
	});
});

test("Kitty Shift+Enter inserts a line and Enter submits", async () => {
	await withApp(async ({ controller, fake, terminal }) => {
		terminal.feed("first");
		terminal.feed("\x1b[13;2:1u");
		assert.equal(controller.views.editor.getText(), "first\n");
		assert.equal(fake.receivedMessages.length, 0);

		terminal.feed("second");
		terminal.feed("\r");
		await fake.waitForInputCount(1);
		assert.equal(fake.receivedMessages[0]?.message.content, "first\nsecond");
	});
});

test("streaming output does not replace text typed in the composer", async () => {
	await withApp(async ({ controller, fake, terminal }) => {
		const startEvents = textStreamStart("input-stability-stream");
		for (const [index, event] of startEvents.entries()) {
			fake.pushMessage(streamEvent({ envelopeId: `input-stream-start-${index}`, event }));
		}
		await waitFor(() => controller.state.provisionalBlocks.has("input-stability-stream:0"));

		terminal.feed("draft ");
		fake.pushMessage(streamEvent({ envelopeId: "input-stream-delta-1", event: textDelta(0, "first chunk") }));
		await waitFor(() => controller.state.provisionalBlocks.get("input-stability-stream:0")?.text === "first chunk");

		terminal.feed("typed during output");
		fake.pushMessage(streamEvent({ envelopeId: "input-stream-delta-2", event: textDelta(0, " and second chunk") }));
		await waitFor(() => controller.state.provisionalBlocks.get("input-stability-stream:0")?.text === "first chunk and second chunk");
		assert.equal(controller.views.editor.getText(), "draft typed during output");
	});
});

test("split bracketed paste keeps long Unicode text in one prompt", async () => {
	await withApp(async ({ controller, fake, terminal }) => {
		const pasted = `${"漢🙂e\u0301".repeat(10_000)}\nsecond line`;
		terminal.feed("\x1b[20");
		terminal.feed(`0~${pasted.slice(0, 300)}`);
		terminal.feed(pasted.slice(300, 12_345));
		terminal.feed(`${pasted.slice(12_345)}\x1b[20`);
		terminal.feed("1~\r");
		await fake.waitForInputCount(1);
		assert.equal(fake.receivedMessages[0]?.message.content, pasted);
		assert.deepEqual(fake.receivedMessages[0]?.inline_pastes, [pasted]);
		assert.equal(controller.views.editor.getText(), "");
	});
});

test("Escape dismisses an interaction dialog without changing the draft", async () => {
	await withApp(async ({ controller, terminal }) => {
		controller.setDraft("draft remains in the composer");
		const abort = new AbortController();
		void controller.interactions.canUseTool("Bash", { command: "echo safe" }, {
			signal: abort.signal,
			toolUseID: "input-stability-tool",
			requestId: "input-stability-dialog",
		});
		controller.reopenQuestions();
		assert.equal(controller.interactions.pending.length, 1);

		terminal.feed("\x1b[27;1:1u");
		terminal.feed("\x1b[27;1:3u");
		assert.equal(controller.views.editor.getText(), "draft remains in the composer");
		assert.equal(controller.interactions.pending.length, 1);
	});
});

test("Ctrl+C opens the exit confirmation and Escape keeps the draft", async () => {
	await withApp(async ({ controller, terminal }) => {
		controller.setDraft("unsent work");
		terminal.feed("\x1b[99;5:1u");
		await waitFor(() => terminal.output.includes("Exit Phi?"));

		terminal.feed("\x1b[99;5:3u");
		terminal.feed("\x1b[27;1:1u");
		terminal.feed("\x1b[27;1:3u");
		assert.equal(controller.views.editor.getText(), "unsent work");
	});
});
