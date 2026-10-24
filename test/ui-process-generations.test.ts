import assert from "node:assert/strict";
import test from "node:test";
import type { Options, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ImageAttachment } from "../src/attachments.js";
import { parseArgs } from "../src/config.js";
import type { HistoryReader } from "../src/history.js";
import type { ShellReceipt } from "../src/shell.js";
import type { WorkspaceInfo } from "../src/workspace.js";
import { AppController } from "../src/ui/app.js";
import { FakeQueryHarness } from "./helpers/fake-query.js";
import { FakeTerminal } from "./helpers/terminal.js";
import { appDependencies, historyMessage, waitFor } from "./helpers/ui-app.js";

async function waitForOutput(terminal: FakeTerminal, text: string): Promise<void> {
	try {
		await waitFor(() => plainTerminalOutput(terminal).includes(text));
	} catch {
		throw new Error(`Timed out waiting for terminal output ${JSON.stringify(text)}; got ${terminal.output.slice(-1_000)}`);
	}
}

function plainTerminalOutput(terminal: FakeTerminal): string {
	return terminal.output
		.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, "")
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
		.replace(/\s+/gu, " ");
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((complete) => { resolve = complete; });
	return { promise, resolve };
}

test("process generations discard late query callbacks, history, image, cwd, and shell results", async () => {
	const terminal = new FakeTerminal();
	const first = new FakeQueryHarness();
	const second = new FakeQueryHarness();
	const launch = parseArgs([]);
	let sessionId: string | undefined;
	let historyReads = 0;
	const oldHistory = deferred<SessionMessage[]>();
	const oldWorkspace = deferred<WorkspaceInfo>();
	let workspaceReads = 0;
	let resolveImage!: (image: ImageAttachment) => void;
	let imageStarted = false;
	const lateImage = new Promise<ImageAttachment>((resolve) => { resolveImage = resolve; });
	let shellStarted = false;
	let shellAborted = false;
	const history: HistoryReader = {
		list: async () => sessionId ? [{ sessionId, summary: "same session", lastModified: 1, cwd: launch.cwd }] : [],
		messages: async () => {
			historyReads += 1;
			return historyReads === 1 ? oldHistory.promise : [historyMessage("new-history", "new history")];
		},
		agents: async () => [],
		agentMessages: async () => [],
		close: async () => undefined,
	};
	const image: ImageAttachment = {
		name: "late.png",
		sizeBytes: 1,
		mediaType: "image/png",
		block: { type: "image", source: { type: "base64", media_type: "image/png", data: "YQ==" } },
	};
	let queryCount = 0;
	const controller = new AppController(launch, appDependencies(first, terminal, {
		createQuery: (parameters) => {
			queryCount += 1;
			return queryCount === 1 ? first.createQuery(parameters) : second.createQuery(parameters);
		},
		createHistoryReader: () => history,
		loadImage: () => {
			imageStarted = true;
			return lateImage;
		},
		readWorkspace: async (cwd) => {
			workspaceReads += 1;
			return workspaceReads === 1 ? oldWorkspace.promise : { kind: "not-repository", cwd };
		},
		runUserShell: (_command, cwd, jobSessionId, signal) => ({
			jobId: "late-shell",
			done: new Promise<ShellReceipt>((resolve) => {
				shellStarted = true;
				signal.addEventListener("abort", () => {
					shellAborted = true;
					resolve({ jobId: "late-shell", sessionId: jobSessionId, command: "sleep", cwd, exitCode: null, signal: "SIGTERM", aborted: true, outputFiles: {} });
				}, { once: true });
			}),
		}),
	}));
	const running = controller.run();
	try {
		await waitFor(() => controller.ready !== undefined);
		sessionId = controller.currentSessionId;
		assert.ok(sessionId);
		controller.showInspector("history");
		await waitFor(() => historyReads === 1);
		controller.openShellMode();
		controller.submitPrompt("sleep");
		await waitFor(() => shellStarted);
		controller.setDraft("unrelated draft");
		controller.loadImage("late.png", "unrelated draft");
		await waitFor(() => imageStarted);

		await controller.replaceSession({ kind: "resume", sessionId });
		assert.equal(first.closeCalls, 0, "active shell work requires explicit stop-and-switch confirmation");
		await controller.replaceSession({ kind: "resume", sessionId });
		await waitFor(() => queryCount === 2 && controller.ready !== undefined);
		assert.equal(controller.currentSessionId, sessionId);
		assert.equal(controller.state.cwd, launch.cwd);
		assert.equal(controller.views.editor.getText(), "unrelated draft");
		assert.equal(first.closeCalls, 1);
		assert.equal(shellAborted, true);

		const oldPermission = first.parameters?.options?.canUseTool;
		assert.ok(oldPermission);
		const permissionResult = await oldPermission("Read", {}, {
			requestId: "stale-permission",
			toolUseID: "stale-tool",
			signal: new AbortController().signal,
		} as Parameters<NonNullable<Options["canUseTool"]>>[2]);
		assert.equal(permissionResult?.behavior, "deny");
		assert.equal(controller.interactions.pending.length, 0);

		const oldCwdHook = first.parameters?.options?.hooks?.CwdChanged?.[0]?.hooks[0];
		assert.ok(oldCwdHook);
		await oldCwdHook({
			hook_event_name: "CwdChanged",
			session_id: sessionId,
			transcript_path: "",
			cwd: "/old",
			old_cwd: "/old",
			new_cwd: "/stale",
		}, undefined, { signal: new AbortController().signal });
		assert.equal(controller.state.cwd, launch.cwd);

		await waitFor(() => historyReads >= 2 && controller.views.inspectors.model.historyMessages.some((message) => JSON.stringify(message.message).includes("new history")));
		oldHistory.resolve([historyMessage("old-history", "stale history")]);
		oldWorkspace.resolve({ kind: "error", cwd: launch.cwd, error: "stale workspace read" });
		resolveImage(image);
		await waitForOutput(terminal, "discarded because the session");
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
		assert.equal(controller.views.inspectors.model.historyMessages.some((message) => JSON.stringify(message.message).includes("stale history")), false);
		assert.equal(controller.views.inspectors.model.workspace?.cwd, launch.cwd);
		assert.equal(controller.attachments.length, 0);
		assert.equal(second.receivedMessages.length, 0, "the aborted old shell receipt must not enter the resumed query");
	} finally {
		oldHistory.resolve([]);
		oldWorkspace.resolve({ kind: "not-repository", cwd: launch.cwd });
		resolveImage(image);
		await controller.close(0);
		await running;
	}
});
