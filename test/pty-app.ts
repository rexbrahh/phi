import { appendFileSync, existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { SDKControlInitializeResponse, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ProcessTerminal } from "@earendil-works/pi-tui";
import { parseArgs } from "../src/config.js";
import { AppController, runApp, type AppDependencies } from "../src/ui/app.js";
import { FakeQueryHarness, initializedResponse } from "./helpers/fake-query.js";

type Scenario = "input" | "paste" | "resize" | "escape" | "dialog" | "kitty" | "repeat-interrupt-exit" | "suspend" | "initialization-failure" | "sigterm";

const scenario = process.argv[2] as Scenario | undefined;
const markerPath = process.env.PHI_PTY_MARKERS;
const gatePath = process.env.PHI_PTY_START_GATE;
const failureGatePath = process.env.PHI_PTY_FAILURE_GATE;
const cwd = process.env.PHI_PTY_CWD;
let terminationRequested = false;

process.on("SIGTERM", () => { terminationRequested = true; });

function record(event: string, detail: Record<string, unknown> = {}): void {
	if (!markerPath) return;
	appendFileSync(markerPath, `${JSON.stringify({ event, ...detail })}\n`, "utf8");
}

async function waitFor(condition: () => boolean, description: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!condition()) {
		if (terminationRequested) throw new Error(`Cancelled while waiting for ${description}`);
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
		await delay(5);
	}
}

async function waitForParentGate(): Promise<void> {
	if (!gatePath) throw new Error("PTY start gate path is missing");
	const deadline = Date.now() + 10_000;
	while (!existsSync(gatePath)) {
		if (terminationRequested) throw new Error("Cancelled while waiting for the PTY parent start gate");
		if (Date.now() >= deadline) throw new Error("Timed out waiting for the PTY parent start gate");
		await delay(5);
	}
}

async function waitForFailureGate(): Promise<void> {
	if (!failureGatePath) throw new Error("PTY failure gate path is missing");
	const deadline = Date.now() + 10_000;
	while (!existsSync(failureGatePath)) {
		if (terminationRequested) throw new Error("Cancelled while waiting for the PTY failure gate");
		if (Date.now() >= deadline) throw new Error("Timed out waiting for the PTY failure gate");
		await delay(5);
	}
}

function sessionState(state: "running" | "idle"): SDKMessage {
	return {
		type: "system",
		subtype: "session_state_changed",
		state,
		session_id: "pty-session",
	} as SDKMessage;
}

async function run(): Promise<void> {
	if (!scenario || !markerPath || !cwd) throw new Error("PTY scenario, marker path, and isolated cwd are required");
	record("harness-loaded");
	await waitForParentGate();

	const terminal = new ProcessTerminal();
	let rejectInitialization: ((error: Error) => void) | undefined;
	const initialization: Promise<SDKControlInitializeResponse> = scenario === "initialization-failure"
		? new Promise((_resolve, reject) => { rejectInitialization = reject; })
		: Promise.resolve(initializedResponse());
	const fake = new FakeQueryHarness(initialization);
	const dependencies: Partial<AppDependencies> = {
		createQuery: fake.createQuery,
		terminal,
		readClipboardImage: async () => null,
		copyText: async () => undefined,
	};
	const launch = parseArgs(["--cwd", cwd]);
	const controller = scenario === "escape" || scenario === "dialog" || scenario === "repeat-interrupt-exit"
		? new AppController(launch, dependencies)
		: undefined;
	const running = controller ? controller.run() : runApp(launch, dependencies);
	await waitFor(() => Boolean(process.stdin.isRaw), "ProcessTerminal raw mode");
	record("terminal-raw", { isRaw: process.stdin.isRaw, columns: terminal.columns, rows: terminal.rows });
	if (scenario === "initialization-failure") {
		await waitForFailureGate();
		rejectInitialization?.(new Error("PTY initialization failure"));
	}

	let observedInputs = 0;
	let observedInterrupts = 0;
	let observedActive = controller?.views.active;
	let observedKittyProtocol = false;
	let observedDraft = controller?.views.editor.getExpandedText();
	let observedDialogId: string | undefined;
	let observedSize = `${terminal.columns}x${terminal.rows}`;
	let madeIdleAfterInterrupt = false;
	const watcher = setInterval(() => {
		while (observedInputs < fake.receivedMessages.length) {
			const message = fake.receivedMessages[observedInputs++];
			if (message) {
				record("user-input", {
					content: message.message.content,
					inlinePastes: message.inline_pastes ?? [],
					origin: message.origin?.kind,
				});
			}
		}
		if (observedInterrupts !== fake.interruptCalls) {
			observedInterrupts = fake.interruptCalls;
			record("interrupt", { count: observedInterrupts });
			const shouldMakeIdle = scenario === "escape"
				|| (scenario === "repeat-interrupt-exit" && observedInterrupts >= 2);
			if (shouldMakeIdle && !madeIdleAfterInterrupt) {
				madeIdleAfterInterrupt = true;
				fake.pushMessage(sessionState("idle"));
			}
		}
		if (terminal.kittyProtocolActive && !observedKittyProtocol) {
			observedKittyProtocol = true;
			record("kitty-protocol-active", { active: true });
		}
		if (scenario === "repeat-interrupt-exit" && controller) {
			const draft = controller.views.editor.getExpandedText();
			if (draft !== observedDraft) {
				observedDraft = draft;
				record("draft", { content: draft });
			}
		}
		const active = controller?.views.active;
		if (active && active !== observedActive) {
			observedActive = active;
			record("active-view", { panel: active });
		}
		const size = `${terminal.columns}x${terminal.rows}`;
		if (size !== observedSize) {
			observedSize = size;
			record("terminal-size", { columns: terminal.columns, rows: terminal.rows });
		}
		if (controller) {
			const pending = controller.interactions.pending[0];
			if (pending && controller.views.dialogs.requestId === pending.requestId && observedDialogId !== pending.requestId) {
				observedDialogId = pending.requestId;
				record("dialog-open", { requestId: pending.requestId, kind: pending.kind });
			}
		}
	}, 5);

	try {
		if (scenario === "initialization-failure") {
			const code = await running;
			record("exit", { code, queryCloseCalls: fake.closeCalls });
			process.exitCode = code;
			return;
		}

		await waitFor(() => fake.mcpStatusCalls > 0, "SDK initialization and terminal startup");
		record("app-ready");

		if (scenario === "escape" || scenario === "repeat-interrupt-exit") {
			if (!controller) throw new Error("Escape scenario requires AppController");
			fake.pushMessage(sessionState("running"));
			await waitFor(() => controller.state.effectiveStatus.foreground === "running", "running session state");
			record("foreground-running");
			const requiredInterrupts = scenario === "repeat-interrupt-exit" ? 2 : 1;
			await waitFor(() => fake.interruptCalls >= requiredInterrupts, "foreground interruption");
			await waitFor(() => controller.state.effectiveStatus.foreground === "idle", "idle state after interrupt");
			record("foreground-idle");
		}

		if (scenario === "dialog") {
			if (!controller) throw new Error("Dialog scenario requires AppController");
			const onElicitation = fake.parameters?.options?.onElicitation;
			if (!onElicitation) throw new Error("Fake SDK query did not receive onElicitation");
			for (const [requestId, expectedAction] of [["pty-cancel", "cancel"], ["pty-decline", "decline"]] as const) {
				const response = onElicitation({
					serverName: "pty-test-server",
					message: "PTY interaction acceptance",
					mode: "url",
					url: `https://example.invalid/${requestId}`,
				}, { requestId, signal: new AbortController().signal });
				await waitFor(() => controller.views.dialogs.requestId === requestId, `${requestId} native dialog`);
				record("dialog-requested", { requestId });
				const result = await response;
				if (result?.action !== expectedAction) throw new Error(`${requestId} returned ${result?.action ?? "no result"}`);
				record("dialog-result", { requestId, action: result.action });
			}
			const visibleCancellation = onElicitation({
				serverName: "pty-test-server",
				message: "Cancel this visible request only",
				mode: "url",
				url: "https://example.invalid/pty-visible-cancel",
			}, { requestId: "pty-visible-cancel", signal: new AbortController().signal });
			await waitFor(() => controller.views.dialogs.requestId === "pty-visible-cancel", "visible cancellation dialog");
			const cancelled = await visibleCancellation;
			if (cancelled?.action !== "cancel") throw new Error(`visible request returned ${cancelled?.action ?? "no result"}`);
			record("dialog-result", { requestId: "pty-visible-cancel", action: cancelled.action });
			await fake.waitForInputCount(1);
			if (fake.receivedMessages[0]?.message.content !== "continued after cancellation") {
				throw new Error("continued input was not submitted after the visible request was cancelled");
			}
			record("dialogs-complete");
		}

		const code = await running;
		record("exit", { code, queryCloseCalls: fake.closeCalls, interruptCalls: fake.interruptCalls });
		process.exitCode = code;
	} finally {
		clearInterval(watcher);
	}
}

run().catch((error: unknown) => {
	record("harness-error", { message: error instanceof Error ? error.message : String(error) });
	if (!terminationRequested) process.kill(process.pid, "SIGTERM");
});
