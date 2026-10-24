import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { ImageAttachment } from "../src/attachments.js";
import { parseArgs } from "../src/config.js";
import { applySdkMessage, createState } from "../src/state.js";
import { AppController, runApp, type AppDependencies } from "../src/ui/app.js";
import { sanitizeTerminalText } from "../src/ui/safe-text.js";
import { TranscriptView } from "../src/ui/transcript.js";
import { FakeQueryHarness, initializedResponse } from "./helpers/fake-query.js";
import { assistantMessage, textBlock } from "./helpers/sdk-events.js";
import { FakeSignals, FakeTerminal } from "./helpers/terminal.js";
import { appDependencies, waitFor } from "./helpers/ui-app.js";
import type { ShellReceipt } from "../src/shell.js";

test("terminal sanitization removes ANSI, OSC, and disallowed controls", () => {
	assert.equal(
		sanitizeTerminalText("A\u001b[31mR\u001b[0m\u001b]0;owned title\u0007Z\u0001\n\t"),
		"ARZ\n\t",
	);
});

test("transcript rendering keeps Unicode safe at narrow widths", () => {
	const state = createState("/repo");
	applySdkMessage(state, assistantMessage({
		envelopeId: "unicode-output",
		modelMessageId: "unicode-message",
		content: [textBlock("e\u0301 🙂 漢\u001b[2J\u001b]0;owned\u0007 tail")],
	}));
	const view = new TranscriptView(state);

	const lines = view.render(5);
	const rendered = sanitizeTerminalText(lines.join("\n"));
	assert.match(rendered, /e\u0301/);
	assert.match(rendered, /🙂/);
	assert.doesNotMatch(rendered, /owned|\u001b|\u0007/);
	assert.ok(lines.every((line) => visibleWidth(line) <= 5));
});

test("runApp submits multiline text and restores the terminal on Ctrl+C", async () => {
	const terminal = new FakeTerminal();
	const fake = new FakeQueryHarness();
	const running = runApp(parseArgs([]), appDependencies(fake, terminal));
	await waitFor(() => terminal.startCalls === 1);
	await waitFor(() => fake.mcpStatusCalls === 1);

	terminal.input("first line");
	terminal.input("\n");
	terminal.input("second line");
	terminal.input("\r");
	await fake.waitForInputCount(1);

	const message = fake.receivedMessages[0];
	assert.equal(message?.message.content, "first line\nsecond line");
	assert.equal(message?.origin?.kind, "human");
	terminal.input("\u0003");

	assert.equal(await running, 0);
	assert.equal(terminal.stopCalls, 1);
});

test("runApp resolves launch options before it creates the SDK query", async () => {
	const terminal = new FakeTerminal();
	const fake = new FakeQueryHarness();
	const launch = parseArgs([]);
	const order: string[] = [];
	const resolved = { ...launch, cwd: "/resolved/launch", model: "resolved-model" };
	const running = runApp(launch, appDependencies(fake, terminal, {
		resolveLaunchOptions: async (value) => {
			assert.equal(value, launch);
			order.push("resolve");
			return resolved;
		},
		createQuery: (parameters) => {
			order.push("query");
			return fake.createQuery(parameters);
		},
	}));
	await waitFor(() => fake.parameters !== undefined);
	assert.deepEqual(order, ["resolve", "query"]);
	assert.equal(fake.parameters?.options?.cwd, "/resolved/launch");
	assert.equal(fake.parameters?.options?.model, "resolved-model");
	terminal.input("\u0003");
	assert.equal(await running, 0);
});

test("bracketed paste expands through the editor and never selects shell mode", async () => {
	const terminal = new FakeTerminal();
	const fake = new FakeQueryHarness();
	let shellRuns = 0;
	const dependencies = appDependencies(fake, terminal, {
		runUserShell: (() => {
			shellRuns += 1;
			throw new Error("shell mode must not start for a paste");
		}) as unknown as NonNullable<AppDependencies["runUserShell"]>,
	});
	const running = runApp(parseArgs([]), dependencies);
	await waitFor(() => terminal.startCalls === 1);
	await waitFor(() => fake.mcpStatusCalls === 1);

	terminal.input("\u001b[200~! echo stays in chat\u001b[201~");
	terminal.input("\r");
	await fake.waitForInputCount(1);

	assert.equal(fake.receivedMessages[0]?.message.content, "! echo stays in chat");
	assert.deepEqual(fake.receivedMessages[0]?.inline_pastes, ["! echo stays in chat"]);
	assert.equal(shellRuns, 0);
	terminal.input("\u0003");
	assert.equal(await running, 0);
});

test("a paste received by a native dialog is not attached to the next prompt", async () => {
	const terminal = new FakeTerminal();
	const fake = new FakeQueryHarness();
	const controller = new AppController(parseArgs([]), appDependencies(fake, terminal));
	const running = controller.run();
	await waitFor(() => controller.ready !== undefined);
	const canUseTool = fake.parameters?.options?.canUseTool;
	assert.ok(canUseTool);
	const response = canUseTool("Read", {}, {
		requestId: "paste-dialog",
		toolUseID: "paste-dialog-tool",
		signal: new AbortController().signal,
	} as Parameters<NonNullable<Options["canUseTool"]>>[2]);
	await waitFor(() => controller.interactions.pending.length === 1);

	terminal.input("\u001b[200~dialog-only paste\u001b[201~");
	terminal.input("\u001b");
	terminal.input("prompt after dialog");
	terminal.input("\r");
	await fake.waitForInputCount(1);

	assert.equal(fake.receivedMessages[0]?.message.content, "prompt after dialog");
	assert.equal(fake.receivedMessages[0]?.inline_pastes, undefined);
	await controller.close(0);
	assert.equal((await response)?.behavior, "deny");
	assert.equal(await running, 0);
});

test("paste metadata is discarded by local commands and shell jobs", async () => {
	const terminal = new FakeTerminal();
	const fake = new FakeQueryHarness();
	const controller = new AppController(parseArgs([]), appDependencies(fake, terminal, {
		runUserShell: (command, cwd, sessionId) => {
			const receipt: ShellReceipt = {
				jobId: "shell-paste-job",
				sessionId,
				command,
				cwd,
				exitCode: 0,
				signal: null,
				aborted: false,
				outputFiles: {},
			};
			return { jobId: receipt.jobId, done: Promise.resolve(receipt) };
		},
	}));
	const running = controller.run();
	await waitFor(() => controller.ready !== undefined);

	terminal.input("\u001b[200~/phi help\u001b[201~");
	terminal.input("\r");
	assert.equal(fake.receivedMessages.length, 0);
	terminal.input("!");
	terminal.input("\u001b[200~pwd\u001b[201~");
	terminal.input("\r");
	await fake.waitForInputCount(1);
	assert.equal(fake.receivedMessages[0]?.origin?.kind, "unclassified");
	assert.equal(fake.receivedMessages[0]?.inline_pastes, undefined);

	terminal.input("prompt after local work");
	terminal.input("\r");
	await fake.waitForInputCount(2);
	assert.equal(fake.receivedMessages[1]?.message.content, "prompt after local work");
	assert.equal(fake.receivedMessages[1]?.inline_pastes, undefined);
	terminal.input("\u0003");
	assert.equal(await running, 0);
});

test("replacing the editor prompt discards its prior paste metadata", async () => {
	const terminal = new FakeTerminal();
	const fake = new FakeQueryHarness();
	const controller = new AppController(parseArgs([]), appDependencies(fake, terminal));
	const running = controller.run();
	await waitFor(() => controller.ready !== undefined);

	terminal.input("\u001b[200~old pasted text\u001b[201~");
	controller.setDraft("replacement prompt");
	terminal.input("\r");
	await fake.waitForInputCount(1);

	assert.equal(fake.receivedMessages[0]?.message.content, "replacement prompt");
	assert.equal(fake.receivedMessages[0]?.inline_pastes, undefined);
	terminal.input("\u0003");
	assert.equal(await running, 0);
});

test("a rejected submit restores the editor draft", async () => {
	const terminal = new FakeTerminal();
	const fake = new FakeQueryHarness(Promise.resolve(initializedResponse({
		apiProvider: "firstParty",
		apiKeySource: "oauth",
	})));
	const controller = new AppController(parseArgs([]), appDependencies(fake, terminal));
	const running = controller.run();
	await waitFor(() => terminal.startCalls === 1);
	await waitFor(() => controller.ready !== undefined);

	terminal.input("keep this draft");
	terminal.input("\r");
	await waitFor(() => controller.views.editor.getText() === "keep this draft");

	assert.equal(controller.views.editor.getText(), "keep this draft");
	await controller.close(0);
	assert.equal(await running, 0);
});

test("hiding a pending permission dialog preserves its request and editor draft", async () => {
	const terminal = new FakeTerminal();
	const fake = new FakeQueryHarness();
	const controller = new AppController(parseArgs([]), appDependencies(fake, terminal));
	const running = controller.run();
	await waitFor(() => terminal.startCalls === 1 && controller.ready !== undefined);

	terminal.input("draft stays here");
	const callbacks = fake.parameters?.options?.canUseTool;
	assert.ok(callbacks);
	const request = callbacks("Read", {}, {
		requestId: "permission-1",
		toolUseID: "tool-1",
		signal: new AbortController().signal,
		suppressAlwaysAllowRule: true,
	} as Parameters<NonNullable<Options["canUseTool"]>>[2]);
	await waitFor(() => controller.interactions.pending.length === 1);

	terminal.input("\u001b");
	assert.equal(controller.interactions.pending.length, 1);
	assert.equal(controller.views.editor.getText(), "draft stays here");
	terminal.input("\u000f");
	terminal.input("d");
	assert.equal((await request)?.behavior, "deny");
	await controller.close(0);
	assert.equal(await running, 0);
});

test("session closing cancels pending native interaction requests", async () => {
	const terminal = new FakeTerminal();
	const fake = new FakeQueryHarness();
	const controller = new AppController(parseArgs([]), appDependencies(fake, terminal));
	const running = controller.run();
	await waitFor(() => controller.ready !== undefined);
	const callback = fake.parameters?.options?.canUseTool;
	assert.ok(callback);
	const response = callback("Read", {}, {
		requestId: "permission-close",
		toolUseID: "tool-close",
		signal: new AbortController().signal,
	} as Parameters<NonNullable<Options["canUseTool"]>>[2]);
	await waitFor(() => controller.interactions.pending.length === 1);
	await controller.close(0);
	assert.equal((await response)?.behavior, "deny");
	assert.equal(controller.interactions.pending.length, 0);
	assert.equal(await running, 0);
});

test("Ctrl+C closes an open dialog through session cancellation without answering it", async () => {
	const terminal = new FakeTerminal();
	const fake = new FakeQueryHarness();
	const controller = new AppController(parseArgs([]), appDependencies(fake, terminal));
	const running = controller.run();
	await waitFor(() => controller.ready !== undefined);
	const callback = fake.parameters?.options?.canUseTool;
	assert.ok(callback);
	const response = callback("Read", {}, {
		requestId: "permission-interrupt",
		toolUseID: "tool-interrupt",
		signal: new AbortController().signal,
	} as Parameters<NonNullable<Options["canUseTool"]>>[2]);
	await waitFor(() => controller.interactions.pending.length === 1);
	terminal.input("\u0003");
	assert.equal((await response)?.behavior, "deny");
	assert.equal(controller.interactions.pending.length, 0);
	assert.equal(await running, 0);
});

test("native question and MCP URL callbacks use the pending dialog", async () => {
	const terminal = new FakeTerminal();
	const fake = new FakeQueryHarness();
	const openedUrls: string[] = [];
	const controller = new AppController(parseArgs([]), appDependencies(fake, terminal, {
		openUrl: (url) => openedUrls.push(url),
	}));
	const running = controller.run();
	await waitFor(() => controller.ready !== undefined);
	const canUseTool = fake.parameters?.options?.canUseTool;
	const onElicitation = fake.parameters?.options?.onElicitation;
	assert.ok(canUseTool);
	assert.ok(onElicitation);
	const question = canUseTool("AskUserQuestion", {
		questions: [{ question: "Choose one", options: [{ label: "First" }, { label: "Second" }] }],
	}, {
		requestId: "question-1",
		toolUseID: "question-tool-1",
		signal: new AbortController().signal,
	} as Parameters<NonNullable<Options["canUseTool"]>>[2]);
	await waitFor(() => controller.interactions.pending.some((request) => request.requestId === "question-1"));
	terminal.input("2");
	const questionResult = await question;
	assert.equal(questionResult?.behavior, "allow");
	assert.deepEqual(questionResult?.updatedInput?.answers, { "Choose one": "Second" });

	const elicitation = onElicitation({
		serverName: "test-server",
		message: "Open this sign-in link",
		mode: "url",
		url: "https://example.test/sign-in",
	}, { requestId: "elicitation-1", signal: new AbortController().signal });
	await waitFor(() => controller.interactions.pending.some((request) => request.requestId === "elicitation-1"));
	assert.deepEqual(openedUrls, []);
	terminal.input("o");
	assert.deepEqual(openedUrls, ["https://example.test/sign-in"]);
	terminal.input("a");
	assert.deepEqual(await elicitation, { action: "accept" });
	terminal.input("\u0003");
	assert.equal(await running, 0);
});

test("Escape closes an inspector before it interrupts foreground work", async () => {
	const terminal = new FakeTerminal();
	const fake = new FakeQueryHarness();
	const controller = new AppController(parseArgs([]), appDependencies(fake, terminal));
	const running = controller.run();
	await waitFor(() => terminal.startCalls === 1 && controller.ready !== undefined);
	controller.state.effectiveStatus.foreground = "running";

	terminal.input("\u0014");
	terminal.input("\u001b");
	assert.equal(controller.views.active, "transcript");
	assert.equal(fake.interruptCalls, 0);

	terminal.input("\u001b");
	await waitFor(() => fake.interruptCalls === 1);
	await controller.close(0);
	assert.equal(await running, 0);
});

test("typed bang snapshots the shell cwd and sends one bounded no-turn receipt after cancellation", async () => {
	const terminal = new FakeTerminal();
	const fake = new FakeQueryHarness();
	const signals = new FakeSignals();
	let resolveShell!: (receipt: ShellReceipt) => void;
	let shellCall: { command: string; cwd: string; signal: AbortSignal } | undefined;
	const shellDone = new Promise<ShellReceipt>((resolve) => {
		resolveShell = resolve;
	});
	const controller = new AppController(parseArgs([]), appDependencies(fake, terminal, {
		signals,
		runUserShell: (command, cwd, _sessionId, signal, onUpdate) => {
			shellCall = { command, cwd, signal };
			onUpdate({
				stdout: "x".repeat(20_000),
				stderr: "y".repeat(20_000),
				stdoutTruncated: true,
				stderrTruncated: true,
			});
			return { jobId: "local-shell-1", done: shellDone };
		},
	}));
	const running = controller.run();
	await waitFor(() => controller.ready !== undefined);

	terminal.input("!");
	assert.equal(controller.shellMode, true);
	controller.state.cwd = "/later/cwd";
	terminal.input("pwd");
	terminal.input("\r");
	await waitFor(() => shellCall !== undefined);
	assert.equal(shellCall?.command, "pwd");
	assert.equal(shellCall?.cwd, parseArgs([]).cwd);
	terminal.input("\u0003");
	assert.equal(shellCall?.signal.aborted, true);
	resolveShell({
		jobId: "local-shell-1",
		sessionId: controller.currentSessionId ?? "",
		command: "pwd",
		cwd: parseArgs([]).cwd,
		exitCode: null,
		signal: "SIGTERM",
		aborted: true,
		infrastructureError: "e".repeat(20_000),
		outputFiles: { stdout: "p".repeat(20_000) },
	});
	await fake.waitForInputCount(1);
	const receipt = fake.receivedMessages[0];
	assert.equal(receipt?.origin?.kind, "unclassified");
	assert.equal(receipt?.shouldQuery, false);
	assert.equal(receipt?.client_composed, true);
	assert.equal(receipt?.message.content && typeof receipt.message.content === "string", true);
	const payload = JSON.parse(String(receipt?.message.content)) as {
		infrastructureError: string;
		outputFiles: { stdout: string };
		preview: { stdout: string; stderr: string };
	};
	assert.equal(payload.infrastructureError.length, 2_048);
	assert.equal(payload.outputFiles.stdout.length, 2_048);
	assert.equal(payload.preview.stdout.length, 8_192);
	assert.equal(payload.preview.stderr.length, 8_192);
	assert.ok(String(receipt?.message.content).length < 22_000);
	assert.match(String(receipt?.message.content), /local-shell-1/);
	terminal.input("\u0003");
	assert.equal(await running, 0);
});

test("a delayed image result is discarded when the composer draft changes", async () => {
	const terminal = new FakeTerminal();
	const fake = new FakeQueryHarness();
	let resolveImage!: (image: ImageAttachment) => void;
	const imagePromise = new Promise<ImageAttachment>((resolve) => {
		resolveImage = resolve;
	});
	const image: ImageAttachment = {
		name: "tiny.png",
		sizeBytes: 1,
		mediaType: "image/png",
		block: { type: "image", source: { type: "base64", media_type: "image/png", data: "YQ==" } },
	};
	const controller = new AppController(parseArgs([]), appDependencies(fake, terminal, {
		loadImage: async () => imagePromise,
	}));
	const running = controller.run();
	await waitFor(() => controller.ready !== undefined);
	terminal.input("/phi attach image.png");
	terminal.input("\r");
	terminal.input("new composer draft");
	resolveImage(image);
	await waitFor(() => terminal.output
		.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, "")
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
		.replace(/\s+/gu, " ")
		.includes("composer draft changed"));
	assert.equal(controller.attachments.length, 0);
	assert.equal(controller.views.editor.getText(), "new composer draft");
	terminal.input("\u0003");
	assert.equal(await running, 0);
});

test("a late image failure cannot restore its command over a newer composer draft", async () => {
	const terminal = new FakeTerminal();
	const fake = new FakeQueryHarness();
	let rejectImage!: (error: Error) => void;
	const controller = new AppController(parseArgs([]), appDependencies(fake, terminal, {
		loadImage: async () => new Promise((_resolve, reject) => { rejectImage = reject; }),
	}));
	const running = controller.run();
	await waitFor(() => controller.ready !== undefined);

	terminal.input("/phi attach image.png");
	terminal.input("\r");
	await waitFor(() => rejectImage !== undefined);
	terminal.input("new composer draft");
	rejectImage(new Error("late image failure"));
	await waitFor(() => terminal.output.includes("Could not attach image: late image failure"));

	assert.equal(controller.views.editor.getText(), "new composer draft");
	terminal.input("\u0003");
	assert.equal(await running, 0);
});

test("a late image failure cannot restore a command after the session changes", async () => {
	const terminal = new FakeTerminal();
	const fake = new FakeQueryHarness();
	let rejectImage!: (error: Error) => void;
	const controller = new AppController(parseArgs([]), appDependencies(fake, terminal, {
		loadImage: async () => new Promise((_resolve, reject) => { rejectImage = reject; }),
	}));
	const running = controller.run();
	await waitFor(() => controller.ready !== undefined);

	terminal.input("/phi attach image.png");
	terminal.input("\r");
	await waitFor(() => rejectImage !== undefined);
	fake.pushMessage({
		type: "user",
		message: { role: "user", content: "next session" },
		parent_tool_use_id: null,
		uuid: "next-session-message",
		session_id: "next-session",
	} as never);
	await waitFor(() => controller.currentSessionId === "next-session");
	rejectImage(new Error("late image failure"));
	await waitFor(() => terminal.output.includes("Could not attach image: late image failure"));

	assert.equal(controller.views.editor.getText(), "");
	terminal.input("\u0003");
	assert.equal(await running, 0);
});

test("exit aborts and drains a pending image load without attaching its late result", async () => {
	const terminal = new FakeTerminal();
	const fake = new FakeQueryHarness();
	const image: ImageAttachment = {
		name: "late.png",
		sizeBytes: 1,
		mediaType: "image/png",
		block: { type: "image", source: { type: "base64", media_type: "image/png", data: "YQ==" } },
	};
	let loadSignal: AbortSignal | undefined;
	let cancelled = false;
	const controller = new AppController(parseArgs([]), appDependencies(fake, terminal, {
		loadImage: (_path, signal) => new Promise((resolve) => {
			loadSignal = signal;
			signal?.addEventListener("abort", () => {
				cancelled = true;
				resolve(image);
			}, { once: true });
		}),
	}));
	const running = controller.run();
	await waitFor(() => controller.ready !== undefined);
	terminal.input("/phi attach late.png");
	terminal.input("\r");
	await waitFor(() => loadSignal !== undefined);
	await controller.close(0);
	assert.equal(loadSignal?.aborted, true);
	assert.equal(cancelled, true);
	assert.equal(controller.attachments.length, 0);
	assert.equal(await running, 0);
});

test("SIGTERM and Ctrl+Z restore the terminal and SIGCONT restarts it", async () => {
	const terminal = new FakeTerminal();
	const fake = new FakeQueryHarness();
	const signals = new FakeSignals();
	let suspendCalls = 0;
	const controller = new AppController(parseArgs([]), appDependencies(fake, terminal, {
		signals,
		suspendProcess: () => { suspendCalls += 1; },
	}));
	const running = controller.run();
	await waitFor(() => controller.ready !== undefined);
	terminal.input("\u001a");
	assert.equal(suspendCalls, 1);
	assert.equal(terminal.startCalls, 2);
	assert.equal(terminal.stopCalls, 1);
	signals.emit("SIGTERM");
	assert.equal(await running, 143);
	assert.equal(terminal.stopCalls, 2);
});

test("SIGINT closes the session and returns the interrupt exit code", async () => {
	const terminal = new FakeTerminal();
	const fake = new FakeQueryHarness();
	const signals = new FakeSignals();
	const controller = new AppController(parseArgs([]), appDependencies(fake, terminal, { signals }));
	const running = controller.run();
	await waitFor(() => controller.ready !== undefined);
	signals.emit("SIGINT");
	assert.equal(await running, 130);
	assert.equal(fake.closeCalls, 1);
	assert.equal(terminal.stopCalls, 1);
});

test("runApp refuses non-TTY startup and closes the terminal after SDK initialization failure", async () => {
	const nonInteractiveTerminal = new FakeTerminal();
	const nonInteractiveQuery = new FakeQueryHarness();
	const code = await runApp(parseArgs([]), appDependencies(nonInteractiveQuery, nonInteractiveTerminal, {
		isInteractive: () => false,
	}));
	assert.equal(code, 2);
	assert.equal(nonInteractiveTerminal.startCalls, 0);
	assert.equal(nonInteractiveQuery.parameters, undefined);

	const terminal = new FakeTerminal();
	const fake = new FakeQueryHarness(Promise.reject(new Error("initialization failed")));
	const failedRun = runApp(parseArgs([]), appDependencies(fake, terminal));
	assert.equal(await failedRun, 1);
	assert.equal(fake.closeCalls, 1);
	assert.equal(terminal.stopCalls, 1);
});
