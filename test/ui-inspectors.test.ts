import assert from "node:assert/strict";
import test from "node:test";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { parseArgs } from "../src/config.js";
import { AppController } from "../src/ui/app.js";
import { FakeQueryHarness } from "./helpers/fake-query.js";
import { FakeTerminal } from "./helpers/terminal.js";
import { appDependencies, historyMessage, waitFor } from "./helpers/ui-app.js";
import type { WorkspaceInfo } from "../src/workspace.js";

test("history page generations reject an older response and close the reader", async () => {
	const terminal = new FakeTerminal();
	const fake = new FakeQueryHarness();
	const requests: Array<{ offset: number; resolve(messages: SessionMessage[]): void }> = [];
	let closeCalls = 0;
	const reader = {
		list: async () => [],
		messages: async (_sessionId: string, options: { offset?: number }) => new Promise<SessionMessage[]>((resolve) => {
			requests.push({ offset: options.offset ?? 0, resolve });
		}),
		agents: async () => [],
		agentMessages: async () => [],
		close: async () => { closeCalls += 1; },
	};
	const controller = new AppController(parseArgs([]), appDependencies(fake, terminal, {
		createHistoryReader: () => reader,
	}));
	const running = controller.run();
	await waitFor(() => controller.ready !== undefined);
	controller.showInspector("history");
	await waitFor(() => requests.length === 1);
	void controller.views.inspectors.loadHistoryPage(200);
	await waitFor(() => requests.length === 2);
	requests[1]?.resolve([historyMessage("new-page", "new page")]);
	await waitFor(() => controller.views.inspectors.model.historyMessages[0]?.uuid === "new-page");
	requests[0]?.resolve([historyMessage("old-page", "old page")]);
	await new Promise<void>((resolve) => setTimeout(resolve, 15));
	assert.equal(controller.views.inspectors.model.historyMessages[0]?.uuid, "new-page");
	await controller.close(0);
	assert.equal(closeCalls, 1);
	assert.equal(await running, 0);
});

test("CwdChanged refreshes the displayed workspace and rejects the previous cwd result", async () => {
	const terminal = new FakeTerminal();
	const fake = new FakeQueryHarness();
	const reads: Array<{ cwd: string; resolve(value: WorkspaceInfo): void }> = [];
	const controller = new AppController(parseArgs([]), appDependencies(fake, terminal, {
		readWorkspace: (cwd) => new Promise((resolve) => reads.push({ cwd, resolve })),
	}));
	const running = controller.run();
	await waitFor(() => controller.ready !== undefined && reads.length === 1);
	const hook = fake.parameters?.options?.hooks?.CwdChanged?.[0]?.hooks[0];
	assert.ok(hook);
	await hook({ hook_event_name: "CwdChanged", old_cwd: parseArgs([]).cwd, new_cwd: "/new/cwd" } as never, undefined, { signal: new AbortController().signal });
	assert.equal(controller.state.cwd, "/new/cwd");
	await waitFor(() => reads.length === 2);
	reads[1]?.resolve({ kind: "not-repository", cwd: "/new/cwd" });
	await waitFor(() => controller.views.inspectors.model.workspace?.cwd === "/new/cwd");
	reads[0]?.resolve({ kind: "not-repository", cwd: parseArgs([]).cwd });
	await new Promise<void>((resolve) => setTimeout(resolve, 15));
	assert.equal(controller.views.inspectors.model.workspace?.cwd, "/new/cwd");
	terminal.input("\u0003");
	assert.equal(await running, 0);
});

test("workflow journal phases remain observations and do not complete an SDK task", async () => {
	const terminal = new FakeTerminal();
	const fake = new FakeQueryHarness();
	let resolvePage!: (page: {
		metadata: { records: Array<{ type: "result"; taskId: string; phase: string }> };
		warnings: string[];
		reset: boolean;
	}) => void;
	let journalReads = 0;
	let historyClosed = false;
	const historyReader = {
		list: async () => [],
		messages: async () => [],
		agents: async () => [],
		agentMessages: async () => [],
		close: async () => { historyClosed = true; },
	};
	const controller = new AppController(parseArgs([]), appDependencies(fake, terminal, {
		createHistoryReader: () => historyReader,
		readWorkflowJournal: async () => {
			journalReads += 1;
			return new Promise((resolve) => { resolvePage = resolve; });
		},
	}));
	const running = controller.run();
	await waitFor(() => controller.ready !== undefined);
	controller.state.tasks.set("workflow-task", {
		taskId: "workflow-task",
		taskType: "local_workflow",
		workflowRunId: "workflow-run",
		status: "running",
		ambient: false,
	});
	controller.views.inspectors.onSdkMessage({
		type: "user",
		message: { role: "user", content: "" },
		parent_tool_use_id: "tool-1",
		session_id: controller.currentSessionId,
		tool_use_result: {
			status: "async_launched",
			taskId: "workflow-task",
			runId: "workflow-run",
			transcriptDir: "/reported/workflow/run",
		},
	} as never);
	controller.showInspector("tasks");
	await waitFor(() => journalReads === 1);
	resolvePage?.({
		metadata: { records: [{ type: "result", taskId: "workflow-task", phase: "build" }] },
		warnings: [],
		reset: false,
	});
	await waitFor(() => controller.views.inspectors.model.workflowRecords.length === 1);
	assert.equal(controller.state.tasks.get("workflow-task")?.status, "running");
	assert.match(controller.views.inspectors.view.render(100).join("\n"), /Observed phases: build ×1/);
	await controller.close(0);
	assert.equal(historyClosed, true);
	assert.equal(await running, 0);
});

test("a stale workflow failure cannot overwrite the selected task's journal state", async () => {
	const terminal = new FakeTerminal();
	const fake = new FakeQueryHarness();
	let rejectJournal!: (error: Error) => void;
	const controller = new AppController(parseArgs([]), appDependencies(fake, terminal, {
		createHistoryReader: () => ({
			list: async () => [],
			messages: async () => [],
			agents: async () => [],
			agentMessages: async () => [],
			close: async () => undefined,
		}),
		readWorkflowJournal: async () => new Promise((_resolve, reject) => { rejectJournal = reject; }),
	}));
	const running = controller.run();
	await waitFor(() => controller.ready !== undefined);
	controller.state.tasks.set("first-task", {
		taskId: "first-task",
		taskType: "local_workflow",
		status: "running",
		ambient: false,
	});
	controller.state.tasks.set("second-task", {
		taskId: "second-task",
		taskType: "local_workflow",
		status: "running",
		ambient: false,
	});
	controller.views.inspectors.onSdkMessage({
		type: "user",
		message: { role: "user", content: "" },
		parent_tool_use_id: "tool-1",
		session_id: controller.currentSessionId,
		tool_use_result: {
			status: "async_launched",
			taskId: "first-task",
			runId: "first-run",
			transcriptDir: "/reported/first/run",
		},
	} as never);
	controller.showInspector("tasks");
	await waitFor(() => rejectJournal !== undefined);
	await controller.selectTask("second-task");
	rejectJournal(new Error("stale read failed"));
	await new Promise<void>((resolve) => setTimeout(resolve, 15));
	assert.equal(controller.views.inspectors.model.selectedTaskId, "second-task");
	assert.deepEqual(controller.views.inspectors.model.workflowWarnings, []);
	await controller.close(0);
	assert.equal(await running, 0);
});
