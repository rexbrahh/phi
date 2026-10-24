import assert from "node:assert/strict";
import test from "node:test";
import type { SDKMessage, SDKSessionInfo, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { parseArgs } from "../src/config.js";
import type { HistoryReader } from "../src/history.js";
import type { ShellReceipt } from "../src/shell.js";
import { AppController } from "../src/ui/app.js";
import { backgroundTasksChanged, conversationReset, userTextMessage } from "./helpers/sdk-events.js";
import { FakeQueryHarness } from "./helpers/fake-query.js";
import { FakeTerminal } from "./helpers/terminal.js";
import { appDependencies, historyMessage, waitFor } from "./helpers/ui-app.js";

const RESUME_ID = "00000000-0000-4000-8000-000000000901";

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

function makeHistoryReader(sessions: SDKSessionInfo[], events?: string[]): HistoryReader {
	return {
		list: async () => sessions,
		messages: async (): Promise<SessionMessage[]> => [],
		agents: async (): Promise<string[]> => [],
		agentMessages: async (): Promise<SessionMessage[]> => [],
		close: async () => { events?.push("history-close"); },
	};
}

test("context, permissions, MCP reconnect, reload, sessions, and local views use native APIs", async () => {
	const terminal = new FakeTerminal();
	const fake = new FakeQueryHarness();
	fake.mcpStatusResult = [{ name: "local", status: "failed", error: "offline" }];
	fake.supportedCommandsResult = [{ name: "fresh-native", description: "fresh", argumentHint: "" }];
	const copied: string[] = [];
	const sessions: SDKSessionInfo[] = [{ sessionId: RESUME_ID, summary: "project session", lastModified: 1, cwd: "/repo" }];
	const controller = new AppController(parseArgs([]), appDependencies(fake, terminal, {
		copyText: async (text) => { copied.push(text); },
		createHistoryReader: () => makeHistoryReader(sessions),
	}));
	const running = controller.run();
	try {
		await waitFor(() => controller.ready !== undefined && fake.mcpStatusCalls >= 1);
		controller.submitPrompt("/phi help");
		await waitForOutput(terminal, "Local Phi:");
		controller.submitPrompt("/phi status");
		await waitForOutput(terminal, "Session:");
		controller.submitPrompt("/phi context");
		await waitFor(() => fake.contextUsageCalls.length === 1);
		assert.deepEqual(fake.contextUsageCalls[0], { detail: "summary" });
		assert.equal(controller.reportedModel, "claude-sonnet-4-5");

		controller.submitPrompt("/phi permissions acceptEdits");
		await waitFor(() => fake.setPermissionModeCalls.length === 1);
		assert.deepEqual(fake.setPermissionModeCalls, ["acceptEdits"]);
		assert.equal(controller.sessionControls.permissionMode, "acceptEdits");
		controller.submitPrompt("/phi permissions bypassPermissions");
		await waitFor(() => terminal.output.includes("requires the explicit"));
		assert.deepEqual(fake.setPermissionModeCalls, ["acceptEdits"]);

		controller.submitPrompt("/phi mcp local");
		await waitFor(() => fake.reconnectMcpServerCalls.length === 1);
		assert.deepEqual(fake.reconnectMcpServerCalls, ["local"]);
		controller.submitPrompt("/phi mcp");
		await waitForOutput(terminal, "MCP servers:");

		controller.submitPrompt("/phi reload");
		await waitFor(() => fake.reloadOutputStylesCalls === 1);
		assert.equal(fake.reloadPluginsCalls, 1);
		assert.equal(fake.reloadSkillsCalls, 1);
		assert.equal(controller.ready?.commands[0]?.name, "fresh-native");

		controller.submitPrompt("/phi sessions");
		await waitFor(() => terminal.output.includes(RESUME_ID));
		assert.match(terminal.output, /project session/u);

		controller.views.inspectors.model.historyMessages = [{
			type: "assistant",
			uuid: "00000000-0000-4000-8000-000000000902",
			session_id: RESUME_ID,
			message: { role: "assistant", content: [{ type: "text", text: "selected output" }] },
			parent_tool_use_id: null,
			parent_agent_id: null,
		} as SessionMessage];
		controller.submitPrompt("/phi copy");
		await waitFor(() => copied.length === 1);
		assert.deepEqual(copied, ["selected output"]);

		controller.submitPrompt("/phi transcript find phrase");
		await waitFor(() => controller.views.active === "history");
		assert.equal(controller.views.inspectors.model.searchText, "find phrase");
		controller.submitPrompt("/phi workflows");
		await waitFor(() => controller.views.active === "tasks");
		assert.equal(controller.views.active, "tasks");
		controller.submitPrompt("/phi worktrees");
		await waitFor(() => controller.views.active === "workspace");
		assert.equal(controller.views.active, "workspace");
		controller.submitPrompt("/phi shell");
		await waitFor(() => controller.shellMode);
		assert.equal(controller.shellMode, true);
		controller.setDraft("keep this draft");
		controller.state.effectiveStatus.foreground = "running";
		await controller.interruptForeground();
		assert.equal(controller.views.editor.getText(), "keep this draft");
	} finally {
		await controller.close(0);
		await running;
	}
});

test("new, fork, and resume stop old work and open SDK sessions in order", async () => {
	const terminal = new FakeTerminal();
	const first = new FakeQueryHarness();
	const second = new FakeQueryHarness();
	const third = new FakeQueryHarness();
	const fourth = new FakeQueryHarness();
	const queries = [first, second, third, fourth];
	let queryIndex = 0;
	const history = makeHistoryReader([
		{ sessionId: RESUME_ID, summary: "prior session", lastModified: 20, cwd: "/target/project" },
	]);
	const dependencies = appDependencies(first, terminal, {
		createQuery: (parameters) => {
			const fake = queries[queryIndex++];
			assert.ok(fake, "query factory should have a prepared fake for each session");
			return fake.createQuery(parameters);
		},
		createHistoryReader: () => history,
	});
	const controller = new AppController(parseArgs([]), dependencies);
	const running = controller.run();
	try {
		await waitFor(() => controller.ready !== undefined);
		first.pushMessage(backgroundTasksChanged({
			envelopeId: "background-before-clear",
			tasks: [
				{ task_id: "worker-1", task_type: "local_agent", description: "background work", ambient: false },
				{ task_id: "ambient-1", task_type: "monitor", description: "ambient work", ambient: true },
			],
		}));
		await waitFor(() => controller.state.liveBackgroundTaskIds.has("worker-1"));
		first.pushMessage(conversationReset("conversation-clear"));
		await waitFor(() => controller.state.conversationId !== undefined);
		assert.deepEqual([...controller.state.liveBackgroundTaskIds], ["worker-1", "ambient-1"]);
		const originalId = controller.currentSessionId;

		controller.submitPrompt("/phi new");
		await waitForOutput(terminal, "confirm stop-and-switch");
		assert.equal(controller.currentSessionId, originalId);
		controller.submitPrompt("/phi new");
		await waitFor(() => second.parameters !== undefined && controller.currentSessionId === second.parameters.options?.sessionId);
		assert.equal(first.stopTaskCalls.includes("worker-1"), true);
		assert.equal(first.stopTaskCalls.includes("ambient-1"), true);
		assert.equal(first.closeCalls, 1);
		assert.equal(second.parameters?.options?.resume, undefined);
		assert.equal(second.parameters?.options?.forkSession, undefined);
		assert.ok(second.parameters?.options?.sessionId);
		assert.equal(controller.state.liveBackgroundTaskIds.size, 0);

		const newSessionId = controller.currentSessionId;
		controller.submitPrompt("/phi fork");
		await waitFor(() => third.parameters !== undefined);
		assert.equal(third.parameters?.options?.resume, newSessionId);
		assert.equal(third.parameters?.options?.forkSession, true);
		assert.notEqual(third.parameters?.options?.sessionId, newSessionId);

		controller.submitPrompt(`/phi resume ${RESUME_ID}`);
		await waitFor(() => fourth.parameters !== undefined && controller.currentSessionId === RESUME_ID);
		assert.equal(fourth.parameters?.options?.resume, RESUME_ID);
		assert.equal(fourth.parameters?.options?.cwd, "/target/project");
		assert.equal(fourth.parameters?.options?.forkSession, undefined);
		assert.equal((await history.list({})).some((session) => session.sessionId === RESUME_ID), true);
	} finally {
		await controller.close(0);
		await running;
	}
});

test("failed stop or target resume keeps the current target and reports the failure", async () => {
	const terminal = new FakeTerminal();
	const first = new FakeQueryHarness();
	const unused = new FakeQueryHarness();
	const dependencies = appDependencies(first, terminal, {
		createQuery: first.createQuery,
		createHistoryReader: () => makeHistoryReader([{ sessionId: RESUME_ID, summary: "target", lastModified: 1, cwd: "/target" }]),
	});
	const controller = new AppController(parseArgs([]), dependencies);
	const running = controller.run();
	try {
		await waitFor(() => controller.ready !== undefined);
		const originalId = controller.currentSessionId;
		controller.state.liveBackgroundTaskIds.add("cannot-stop");
		first.stopTaskError = new Error("stop rejected");
		controller.submitPrompt("/phi new");
		await waitForOutput(terminal, "confirm stop-and-switch");
		controller.submitPrompt("/phi new");
		await waitForOutput(terminal, "stop rejected");
		assert.equal(controller.currentSessionId, originalId);
		assert.equal(unused.parameters, undefined);
		assert.equal(first.closeCalls, 0);
	} finally {
		await controller.close(0);
		await running;
	}

	const failedTerminal = new FakeTerminal();
	const oldQuery = new FakeQueryHarness();
	let rejectInitialization!: (error: Error) => void;
	const failedInitialization = new Promise<never>((_resolve, reject) => { rejectInitialization = reject; });
	const failedQuery = new FakeQueryHarness(failedInitialization);
	const queries = [oldQuery, failedQuery];
	let index = 0;
	const failedController = new AppController(parseArgs([]), appDependencies(oldQuery, failedTerminal, {
		createQuery: (parameters) => {
			const query = queries[index++];
			assert.ok(query);
			return query.createQuery(parameters);
		},
		createHistoryReader: () => makeHistoryReader([{ sessionId: RESUME_ID, summary: "target", lastModified: 1, cwd: "/target" }]),
	}));
	const failedRun = failedController.run();
	try {
		await waitFor(() => failedController.ready !== undefined);
		failedController.submitPrompt(`/phi resume ${RESUME_ID}`);
		await waitFor(() => failedQuery.parameters !== undefined);
		rejectInitialization(new Error("resume unavailable"));
		await waitFor(() => failedController.currentSessionId === RESUME_ID && failedTerminal.output.includes("resume unavailable"));
		assert.equal(failedQuery.closeCalls, 1);
		assert.equal(oldQuery.closeCalls, 1);
		assert.equal(failedController.currentSessionId, RESUME_ID);
	} finally {
		await failedController.close(0);
		await failedRun;
	}
});

test("failed query cleanup leaves the old target visible as an error and does not open the new target", async () => {
	const terminal = new FakeTerminal();
	const first = new FakeQueryHarness();
	const second = new FakeQueryHarness();
	first.closeError = new Error("close refused");
	let queryCount = 0;
	const controller = new AppController(parseArgs([]), appDependencies(first, terminal, {
		createQuery: (parameters) => {
			queryCount += 1;
			return queryCount === 1 ? first.createQuery(parameters) : second.createQuery(parameters);
		},
	}));
	const running = controller.run();
	try {
		await waitFor(() => controller.ready !== undefined);
		const oldSessionId = controller.currentSessionId;
		controller.submitPrompt("/phi new");
		await waitForOutput(terminal, "close refused");
		assert.equal(controller.currentSessionId, oldSessionId);
		assert.equal(controller.ready, undefined);
		assert.equal(controller.session, undefined);
		assert.equal(second.parameters, undefined);
		assert.equal(terminal.programStatus?.state, "error");
	} finally {
		await controller.close(0);
		assert.equal(await running, 0);
	}
});

test("rewind takes a fresh dry run and needs a second explicit command", async () => {
	const terminal = new FakeTerminal();
	const fake = new FakeQueryHarness();
	fake.rewindDryRunResult = { canRewind: true, filesChanged: ["src/file.ts"], insertions: 2, deletions: 1 };
	fake.rewindApplyResult = { canRewind: true, filesChanged: ["src/file.ts"], skippedLinks: 1 };
	const controller = new AppController(parseArgs([]), appDependencies(fake, terminal));
	const running = controller.run();
	try {
		await waitFor(() => controller.ready !== undefined);
		fake.pushMessage(userTextMessage({ inputUuid: "rewind-checkpoint", text: "checkpoint" }) as SDKMessage);
		await waitFor(() => controller.state.conversationBlocks.some((block) => block.role === "user"));
		controller.state.effectiveStatus.foreground = "running";
		controller.submitPrompt("/phi rewind");
		await waitForOutput(terminal, "requires an idle session");
		assert.equal(fake.rewindCalls.length, 0);
		controller.state.effectiveStatus.foreground = "idle";
		controller.submitPrompt("/phi rewind");
		await waitFor(() => fake.rewindCalls.length === 1);
		assert.equal(fake.rewindCalls[0]?.dryRun, true);
		await waitFor(() => terminal.output.includes("This changes files only"));
		controller.submitPrompt("/phi rewind");
		try {
			await waitFor(() => fake.rewindCalls.length === 3);
		} catch {
			throw new Error(`Rewind calls did not reach dry-run, dry-run, apply: ${JSON.stringify(fake.rewindCalls)}; ${terminal.output.slice(-1_000)}`);
		}
		assert.deepEqual(fake.rewindCalls.map((call) => call.dryRun), [true, true, false]);
		assert.equal(fake.rewindCalls.every((call) => call.userMessageId === userTextMessage({ inputUuid: "rewind-checkpoint", text: "checkpoint" }).uuid), true);
		await waitFor(() => terminal.output.includes("skipped"));
		assert.match(terminal.output, /skipped[\s\S]{0,100}links[\s\S]{0,100}1/u);
		assert.match(terminal.output, /Git and shell effects were not changed/u);
	} finally {
		await controller.close(0);
		await running;
	}

	const unavailableTerminal = new FakeTerminal();
	const unavailable = new FakeQueryHarness();
	unavailable.rewindDryRunResult = { canRewind: false, error: "checkpoint expired" };
	const unavailableController = new AppController(parseArgs([]), appDependencies(unavailable, unavailableTerminal));
	const unavailableRun = unavailableController.run();
	try {
		await waitFor(() => unavailableController.ready !== undefined);
		unavailable.pushMessage(userTextMessage({ inputUuid: "old-checkpoint", text: "old" }) as SDKMessage);
		await waitFor(() => unavailableController.state.conversationBlocks.length > 0);
		unavailableController.submitPrompt("/phi rewind");
		await waitFor(() => unavailable.rewindCalls.length === 1);
		await waitForOutput(unavailableTerminal, "checkpoint expired");
		assert.equal(unavailable.rewindCalls.length, 1);
		assert.equal(unavailable.rewindCalls[0]?.dryRun, true);
	} finally {
		await unavailableController.close(0);
		await unavailableRun;
	}
});

test("conversation reset retains tasks; shutdown drains SDK, shell, history, and polling before terminal restore", async () => {
	const events: string[] = [];
	const terminal = new FakeTerminal();
	terminal.events = events;
	const fake = new FakeQueryHarness();
	fake.events = events;
	let shellStarted = false;
	const history = makeHistoryReader([], events);
	const controller = new AppController(parseArgs([]), appDependencies(fake, terminal, {
		createHistoryReader: () => history,
		runUserShell: (_command, cwd, sessionId, signal) => ({
			jobId: "shell-1",
			done: new Promise<ShellReceipt>((resolve) => {
				shellStarted = true;
				signal.addEventListener("abort", () => {
					events.push("shell-stop");
					resolve({
						jobId: "shell-1",
						sessionId,
						command: "sleep",
						cwd,
						exitCode: null,
						signal: "SIGTERM",
						aborted: true,
						outputFiles: {},
					});
				}, { once: true });
			}),
		}),
	}));
	const running = controller.run();
	try {
		await waitFor(() => controller.ready !== undefined);
		controller.state.liveBackgroundTaskIds.add("still-live");
		controller.state.tasks.set("still-live", { taskId: "still-live", status: "running", ambient: false, isBackgrounded: true });
		fake.pushMessage(conversationReset("shutdown-reset"));
		await waitFor(() => controller.state.conversationId !== undefined);
		assert.deepEqual([...controller.state.liveBackgroundTaskIds], ["still-live"]);

		controller.showInspector("history");
		controller.openShellMode();
		controller.submitPrompt("sleep");
		await waitFor(() => shellStarted);
		await waitFor(() => terminal.output.includes("Session history"));
		await controller.close(0);
		assert.equal(await running, 0);
		const queryClose = events.indexOf("query-close");
		const shellStop = events.indexOf("shell-stop");
		const historyClose = events.indexOf("history-close");
		const terminalStop = events.indexOf("terminal-stop");
		assert.ok(queryClose >= 0 && shellStop > queryClose && historyClose > shellStop && terminalStop > historyClose, events.join(", "));
	} finally {
		await controller.close(0);
		await running;
	}
});
