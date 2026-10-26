import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { loadImage as loadImageFile } from "../src/attachments.js";
import { AppController } from "../src/ui/app.js";
import { FakeQueryHarness } from "./helpers/fake-query.js";
import { FakeTerminal } from "./helpers/terminal.js";
import { appDependencies, historyMessage, waitFor, testLaunch } from "./helpers/ui-app.js";
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
	const controller = new AppController(testLaunch(), appDependencies(fake, terminal, {
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

test("active History refreshes and clears transient state after a same-ID resume", async () => {
	const terminal = new FakeTerminal();
	const first = new FakeQueryHarness();
	const second = new FakeQueryHarness();
	let queryCount = 0;
	let sessionId: string | undefined;
	const historyReads: string[] = [];
	let resolveStaleHistory: ((messages: SessionMessage[]) => void) | undefined;
	const staleHistory = new Promise<SessionMessage[]>((resolve) => { resolveStaleHistory = resolve; });
	const reader = {
		list: async () => sessionId ? [{ sessionId, summary: "current session", lastModified: 1, cwd: testLaunch().cwd }] : [],
		messages: async (id: string) => {
			historyReads.push(id);
			if (historyReads.length === 1) return staleHistory;
			return [historyMessage(`history-${historyReads.length}`, `history revision ${historyReads.length}`)];
		},
		agents: async () => [],
		agentMessages: async () => [],
		close: async () => undefined,
	};
	const controller = new AppController(testLaunch(), appDependencies(first, terminal, {
		createQuery: (parameters) => (queryCount++ === 0 ? first : second).createQuery(parameters),
		createHistoryReader: () => reader,
	}));
	const running = controller.run();
	await waitFor(() => controller.ready !== undefined);
	sessionId = controller.currentSessionId;
	assert.ok(sessionId);
	controller.showInspector("history");
	await waitFor(() => historyReads.length === 1 && controller.views.inspectors.model.historyLoading);

	await controller.replaceSession({ kind: "resume", sessionId });
	await waitFor(() => historyReads.length === 2 && controller.views.inspectors.model.historyMessages[0]?.uuid === "history-2");

	assert.equal(controller.views.inspectors.model.panel, "history");
	assert.equal(controller.views.inspectors.model.historyLoading, false);
	assert.equal(controller.views.inspectors.model.historyError, undefined);
	assert.deepEqual(historyReads, [sessionId, sessionId]);
	assert.equal(first.closeCalls, 1);
	assert.ok(resolveStaleHistory);
	resolveStaleHistory([historyMessage("stale-history", "stale history revision")]);
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	assert.equal(controller.views.inspectors.model.historyMessages[0]?.uuid, "history-2");
	await controller.close(0);
	assert.equal(await running, 0);
});

test("active Tasks refreshes child transcripts and drops stale loading state after replacement", async () => {
	const terminal = new FakeTerminal();
	const first = new FakeQueryHarness();
	const second = new FakeQueryHarness();
	let queryCount = 0;
	let sessionId: string | undefined;
	let agentReads = 0;
	let childReads = 0;
	let resolveStaleChild: ((messages: SessionMessage[]) => void) | undefined;
	const reader = {
		list: async () => sessionId ? [{ sessionId, summary: "current session", lastModified: 1, cwd: testLaunch().cwd }] : [],
		messages: async () => [],
		agents: async () => agentReads++ === 0 ? ["old-child"] : ["resumed-child"],
		agentMessages: async () => {
			childReads += 1;
			if (childReads === 1) throw new Error("old child read failed");
			return new Promise<SessionMessage[]>((resolve) => { resolveStaleChild = resolve; });
		},
		close: async () => undefined,
	};
	const controller = new AppController(testLaunch(), appDependencies(first, terminal, {
		createQuery: (parameters) => (queryCount++ === 0 ? first : second).createQuery(parameters),
		createHistoryReader: () => reader,
	}));
	const running = controller.run();
	await waitFor(() => controller.ready !== undefined);
	sessionId = controller.currentSessionId;
	assert.ok(sessionId);
	controller.showInspector("tasks");
	await waitFor(() => controller.views.inspectors.model.childAgentIds.includes("old-child"));
	await controller.views.inspectors.selectChild("old-child");
	assert.equal(controller.views.inspectors.model.historyError, "old child read failed");
	const staleChildRead = controller.views.inspectors.selectChild("old-child");
	await waitFor(() => controller.views.inspectors.model.historyLoading);

	await controller.replaceSession({ kind: "resume", sessionId });
	await waitFor(() => controller.views.inspectors.model.childAgentIds.includes("resumed-child"));
	assert.equal(controller.views.inspectors.model.panel, "tasks");
	assert.equal(controller.views.inspectors.model.historyLoading, false);
	assert.equal(controller.views.inspectors.model.historyError, undefined);
	assert.equal(controller.views.inspectors.model.selectedChildId, undefined);

	assert.ok(resolveStaleChild);
	resolveStaleChild([historyMessage("stale-child", "stale child transcript")]);
	await staleChildRead;
	assert.deepEqual(controller.views.inspectors.model.childMessages, []);
	assert.equal(first.closeCalls, 1);
	await controller.close(0);
	assert.equal(await running, 0);
});

test("CwdChanged refreshes the displayed workspace and rejects the previous cwd result", async () => {
	const terminal = new FakeTerminal();
	const fake = new FakeQueryHarness();
	const reads: Array<{ cwd: string; resolve(value: WorkspaceInfo): void }> = [];
	const controller = new AppController(testLaunch(), appDependencies(fake, terminal, {
		readWorkspace: (cwd) => new Promise((resolve) => reads.push({ cwd, resolve })),
	}));
	const running = controller.run();
	await waitFor(() => controller.ready !== undefined && reads.length === 1);
	const hook = fake.parameters?.options?.hooks?.CwdChanged?.[0]?.hooks[0];
	assert.ok(hook);
	await hook({ hook_event_name: "CwdChanged", old_cwd: testLaunch().cwd, new_cwd: "/new/cwd" } as never, undefined, { signal: new AbortController().signal });
	assert.equal(controller.state.cwd, "/new/cwd");
	await waitFor(() => reads.length === 2);
	reads[1]?.resolve({ kind: "not-repository", cwd: "/new/cwd" });
	await waitFor(() => controller.views.inspectors.model.workspace?.cwd === "/new/cwd");
	reads[0]?.resolve({ kind: "not-repository", cwd: testLaunch().cwd });
	await new Promise<void>((resolve) => setTimeout(resolve, 15));
	assert.equal(controller.views.inspectors.model.workspace?.cwd, "/new/cwd");
	terminal.input("\u0003");
	assert.equal(await running, 0);
});

test("CwdChanged refreshes relative completion and image attachment paths", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "phi-cwd-change-"));
	const launchCwd = join(temporary, "launch");
	const effectiveCwd = join(temporary, "effective");
	await Promise.all([mkdir(launchCwd), mkdir(effectiveCwd)]);
	await Promise.all([
		writeFile(join(launchCwd, "old-only.txt"), "old"),
		writeFile(join(effectiveCwd, "new-only.txt"), "new"),
		writeFile(join(effectiveCwd, "relative.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
	]);

	const terminal = new FakeTerminal();
	const fake = new FakeQueryHarness();
	const loadedPaths: string[] = [];
	const controller = new AppController(testLaunch(["--cwd", launchCwd]), appDependencies(fake, terminal, {
		loadImage: async (path, signal) => {
			loadedPaths.push(path);
			return loadImageFile(path, signal);
		},
	}));
	let autocomplete: AutocompleteProvider | undefined;
	const setAutocompleteProvider = controller.views.editor.setAutocompleteProvider.bind(controller.views.editor);
	controller.views.editor.setAutocompleteProvider = (provider) => {
		autocomplete = provider;
		setAutocompleteProvider(provider);
	};
	const processCwd = process.cwd();
	const running = controller.run();
	try {
		await waitFor(() => controller.ready !== undefined && autocomplete !== undefined);
		const launchProvider = autocomplete;
		assert.ok(launchProvider);
		const launchSuggestions = await launchProvider.getSuggestions(["./old-only"], 0, 10, {
			signal: new AbortController().signal,
			force: true,
		});
		assert.ok(launchSuggestions?.items.some((item) => item.label === "old-only.txt"));

		const hook = fake.parameters?.options?.hooks?.CwdChanged?.[0]?.hooks[0];
		assert.ok(hook);
		await hook({ hook_event_name: "CwdChanged", old_cwd: launchCwd, new_cwd: effectiveCwd } as never, undefined, { signal: new AbortController().signal });
		await waitFor(() => autocomplete !== launchProvider);
		const effectiveProvider = autocomplete;
		assert.ok(effectiveProvider);
		const effectiveSuggestions = await effectiveProvider.getSuggestions(["./new-only"], 0, 10, {
			signal: new AbortController().signal,
			force: true,
		});
		assert.ok(effectiveSuggestions?.items.some((item) => item.label === "new-only.txt"));
		const staleSuggestions = await effectiveProvider.getSuggestions(["./old-only"], 0, 10, {
			signal: new AbortController().signal,
			force: true,
		});
		assert.equal(staleSuggestions?.items.some((item) => item.label === "old-only.txt") ?? false, false);

		controller.submitPrompt("/phi attach relative.png");
		await waitFor(() => controller.attachments.length === 1);
		assert.deepEqual(loadedPaths, [join(effectiveCwd, "relative.png")]);
		assert.equal(controller.state.cwd, effectiveCwd);
		assert.equal(process.cwd(), processCwd);
	} finally {
		await controller.close(0);
		await running;
		await rm(temporary, { recursive: true, force: true });
	}
});

test("a failed workspace read is ignored after cwd changes but before its debounce fires", async () => {
	const terminal = new FakeTerminal();
	const fake = new FakeQueryHarness();
	const reads: Array<{ cwd: string; reject(error: Error): void }> = [];
	const controller = new AppController(testLaunch(), appDependencies(fake, terminal, {
		readWorkspace: (cwd) => new Promise((_resolve, reject) => reads.push({ cwd, reject })),
	}));
	const running = controller.run();
	await waitFor(() => controller.ready !== undefined && reads.length === 1);
	const hook = fake.parameters?.options?.hooks?.CwdChanged?.[0]?.hooks[0];
	assert.ok(hook);
	await hook({ hook_event_name: "CwdChanged", old_cwd: testLaunch().cwd, new_cwd: "/new/cwd" } as never, undefined, { signal: new AbortController().signal });
	assert.equal(controller.state.cwd, "/new/cwd");
	reads[0]?.reject(new Error("old cwd read failed"));
	await new Promise<void>((resolve) => setTimeout(resolve, 15));

	assert.equal(controller.views.inspectors.model.workspace, undefined);
	await controller.close(0);
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
	let workflowRoot: string | undefined;
	const historyReader = {
		list: async () => [],
		messages: async () => [],
		agents: async () => [],
		agentMessages: async () => [],
		close: async () => { historyClosed = true; },
	};
	const launch = testLaunch();
	const controller = new AppController(launch, appDependencies(fake, terminal, {
		createHistoryReader: () => historyReader,
		readWorkflowJournal: async (reference) => {
			journalReads += 1;
			workflowRoot = reference.configRoot;
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
	assert.equal(workflowRoot, launch.home);
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
	assert.match(controller.views.inspectors.view.render(100).join("\n"), /Workflow script: unavailable/u);
});

test("selected workflow details render and sanitize the SDK script path", async () => {
	const terminal = new FakeTerminal();
	const fake = new FakeQueryHarness();
	const controller = new AppController(testLaunch(), appDependencies(fake, terminal));
	const running = controller.run();
	try {
		await waitFor(() => controller.ready !== undefined);
		controller.state.tasks.set("workflow-task", {
			taskId: "workflow-task",
			taskType: "local_workflow",
			workflowRunId: "workflow-run",
			status: "completed",
			ambient: false,
		});
		controller.views.inspectors.onSdkMessage({
			type: "user",
			message: { role: "user", content: "" },
			parent_tool_use_id: "tool-1",
			session_id: "workflow-session",
			tool_use_result: {
				status: "async_launched",
				taskId: "workflow-task",
				runId: "workflow-run",
				transcriptDir: "/reported/workflow/run",
				scriptPath: "/reported/workflow/\u001b[31mdeploy.yaml\u001b[0m",
			},
		} as never);
		controller.showInspector("tasks");
		await controller.selectTask("workflow-task");
		const output = controller.views.inspectors.view.render(100).join("\n");
		assert.match(output, /Workflow script: \/reported\/workflow\/deploy\.yaml/u);
		assert.equal(output.includes("\u001b[31m"), false);
	} finally {
		await controller.close(0);
		await running;
	}
});

test("a stale workflow failure cannot overwrite the selected task's journal state", async () => {
	const terminal = new FakeTerminal();
	const fake = new FakeQueryHarness();
	let rejectJournal!: (error: Error) => void;
	const controller = new AppController(testLaunch(), appDependencies(fake, terminal, {
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

test("child selection survives History/Tasks navigation without changing copied output or workflow polling", async () => {
	const terminal = new FakeTerminal();
	const fake = new FakeQueryHarness();
	let journalReads = 0;
	const copied: string[] = [];
	const controller = new AppController(testLaunch(), appDependencies(fake, terminal, {
		createHistoryReader: () => ({
			list: async () => [],
			messages: async () => [],
			agents: async () => ["child-agent"],
			agentMessages: async () => [historyMessage("child-message", "child transcript output")],
			close: async () => undefined,
		}),
		readWorkflowJournal: async () => {
			journalReads += 1;
			return {
				metadata: { records: [{ type: "result", taskId: "workflow-task", phase: "build" }] },
				warnings: [],
				reset: false,
			};
		},
		copyText: async (text) => { copied.push(text); },
	}));
	const running = controller.run();
	await waitFor(() => controller.ready !== undefined);
	const sessionId = controller.currentSessionId ?? "selection-session";
	controller.views.inspectors.setSession(sessionId);
	controller.state.tasks.set("workflow-task", {
		taskId: "workflow-task",
		taskType: "local_workflow",
		description: "task output",
		status: "running",
		ambient: false,
	});
	controller.views.inspectors.onSdkMessage({
		type: "user",
		message: { role: "user", content: "" },
		parent_tool_use_id: "tool-1",
		session_id: sessionId,
		tool_use_result: {
			status: "async_launched",
			taskId: "workflow-task",
			runId: "workflow-run",
			transcriptDir: "/reported/workflow/run",
		},
	} as never);
	controller.showInspector("tasks");
	await waitFor(() => journalReads === 1 && controller.views.inspectors.model.childAgentIds.includes("child-agent"));
	await controller.selectChild("child-agent");
	assert.equal(controller.views.inspectors.model.selectedTaskId, undefined);
	assert.equal(controller.views.inspectors.model.selectedChildId, "child-agent");
	controller.showInspector("history");
	controller.showInspector("tasks");
	assert.equal(controller.views.inspectors.model.selectedTaskId, undefined);
	assert.equal(controller.views.inspectors.model.selectedChildId, "child-agent");
	assert.equal(controller.views.inspectors.selectedOutput(), "child transcript output");
	controller.views.inspectors.onSdkMessage({ type: "tool_progress", tool_use_id: "unrelated-tool" } as never);
	assert.equal(controller.views.inspectors.model.selectedTaskId, undefined);
	assert.equal(controller.views.inspectors.model.selectedChildId, "child-agent");

	terminal.input("\u001b[121;6u");
	await waitFor(() => copied.length === 1);
	assert.equal(copied[0], "child transcript output");
	await new Promise<void>((resolve) => setTimeout(resolve, 1_050));
	assert.equal(journalReads, 1);

	await controller.selectTask("workflow-task");
	assert.equal(controller.views.inspectors.model.selectedChildId, undefined);
	await controller.close(0);
	assert.equal(await running, 0);
});

test("Ctrl+Shift+Y copies complete native tool-result text from the loaded history page", async () => {
	const terminal = new FakeTerminal();
	const fake = new FakeQueryHarness();
	const sentinel = "NATIVE_TOOL_RESULT_END";
	const resultText = "r".repeat(37 * 1024 - sentinel.length) + sentinel;
	const copied: string[] = [];
	const controller = new AppController(testLaunch(), appDependencies(fake, terminal, {
		createHistoryReader: () => historyReaderWithMessages([nativeToolResultMessage("native-result", resultText)]),
		copyText: async (text) => { copied.push(text); },
	}));
	const running = controller.run();
	await waitFor(() => controller.ready !== undefined);
	controller.views.inspectors.setSession("copy-session");
	controller.showInspector("history");
	await waitFor(() => controller.views.inspectors.model.historyMessages.length === 1);

	assert.equal(resultText.length, 37 * 1024);
	assert.equal(controller.views.inspectors.selectedOutput(), resultText);
	terminal.input("\u001b[121;6u");
	await waitFor(() => copied.length === 1);
	assert.equal(copied[0], resultText);

	await controller.close(0);
	assert.equal(await running, 0);
});

test("native history tool-result text is sanitized before rendering", () => {
	const terminal = new FakeTerminal();
	const fake = new FakeQueryHarness();
	const controller = new AppController(testLaunch(), appDependencies(fake, terminal));
	controller.views.inspectors.model.panel = "history";
	controller.views.inspectors.model.historyMessages = [
		nativeToolResultMessage("unsafe-native-result", "before\u001b[2Jafter"),
	];

	const rendered = controller.views.inspectors.view.render(100).join("\n");
	assert.doesNotMatch(rendered, /\u001b\[2J/);
	assert.match(rendered, /beforeafter/);
});

test("history search finds native text beyond the preview cap and copies its visible match", async () => {
	const terminal = new FakeTerminal();
	const fake = new FakeQueryHarness();
	const sentinel = "NATIVE_TOOL_RESULT_END";
	const resultText = "r".repeat(37 * 1024 - sentinel.length) + sentinel;
	const copied: string[] = [];
	const controller = new AppController(testLaunch(), appDependencies(fake, terminal, {
		createHistoryReader: () => ({
			...historyReaderWithMessages([
				nativeToolResultMessage("native-result", resultText),
				historyMessage("newer-unrelated", "newest unrelated message"),
			]),
			agents: async () => ["retained-child"],
			agentMessages: async () => [historyMessage("retained-child-message", "retained child output")],
		}),
		copyText: async (text) => { copied.push(text); },
	}));
	const running = controller.run();
	await waitFor(() => controller.ready !== undefined);
	controller.views.inspectors.setSession("search-session");
	controller.showInspector("tasks");
	await waitFor(() => controller.views.inspectors.model.childAgentIds.includes("retained-child"));
	await controller.selectChild("retained-child");
	controller.showInspector("history");
	await waitFor(() => controller.views.inspectors.model.historyMessages.length === 2);
	assert.equal(controller.views.inspectors.model.selectedChildId, "retained-child");

	assert.ok(resultText.indexOf(sentinel) > 8_192);
	controller.views.inspectors.searchLoadedHistory(sentinel);
	const rendered = controller.views.inspectors.view.render(100);
	const renderedText = rendered.join("\n");
	assert.match(renderedText, /You:/);
	assert.doesNotMatch(renderedText, /newest unrelated message/);
	const displayedResult = rendered
		.filter((line) => line.includes("r".repeat(20)))
		.map((line) => line.trim())
		.join("");
	assert.equal(displayedResult, "r".repeat(8_191) + "…");
	assert.equal(displayedResult.includes(sentinel), false);
	terminal.input("\u001b[121;6u");
	await waitFor(() => copied.length === 1);
	assert.equal(copied[0]?.length, resultText.length);
	assert.equal(copied[0], resultText);
	assert.equal(controller.views.inspectors.selectedOutput(), resultText);

	await controller.close(0);
	assert.equal(await running, 0);
});

test("task and child identifiers and types are sanitized before inspector rendering", () => {
	const terminal = new FakeTerminal();
	const fake = new FakeQueryHarness();
	const controller = new AppController(testLaunch(), appDependencies(fake, terminal));
	const taskId = "task-\u001b[2J";
	const taskType = "workflow-\u001b]0;owned-title\u0007";
	const childId = "child-\u001b[31m";
	controller.state.tasks.set(taskId, {
		taskId,
		taskType,
		status: "running",
		ambient: false,
	});
	controller.views.inspectors.model.panel = "tasks";
	controller.views.inspectors.model.selectedTaskId = taskId;
	controller.views.inspectors.model.childAgentIds = [childId];
	controller.views.inspectors.model.selectedChildId = childId;

	const rendered = controller.views.inspectors.view.render(100).join("\n");
	assert.doesNotMatch(rendered, /\u001b\[2J/);
	assert.doesNotMatch(rendered, /\u001b\]0;owned-title\u0007/);
	assert.doesNotMatch(rendered, /child-\u001b\[31m/);
});

test("history instructions name the Tasks panel for Tab child selection", () => {
	const terminal = new FakeTerminal();
	const fake = new FakeQueryHarness();
	const controller = new AppController(testLaunch(), appDependencies(fake, terminal, {
		createHistoryReader: () => ({
			list: async () => [],
			messages: async () => [],
			agents: async () => [],
			agentMessages: async () => [],
			close: async () => undefined,
		}),
	}));
	controller.views.inspectors.setSession("history-session");
	controller.showInspector("history");

	const rendered = controller.views.inspectors.view.render(100).join("\n");
	assert.match(rendered, /Children: open Tasks \(Ctrl\+T\); Tab selects the next task or child transcript\./);
	assert.match(rendered, /PgUp older · PgDn newer/);
	assert.doesNotMatch(rendered, /\[ older · \] newer/);
});

function nativeToolResultMessage(uuid: string, resultText: string): SessionMessage {
	return {
		type: "user",
		uuid,
		session_id: "test-session",
		message: {
			role: "user",
			content: [{
				type: "tool_result",
				tool_use_id: "native-tool-use",
				content: [{ type: "text", text: resultText }],
			}],
		},
		parent_tool_use_id: null,
		parent_agent_id: null,
	} as unknown as SessionMessage;
}

function historyReaderWithMessages(messages: SessionMessage[]) {
	return {
		list: async () => [],
		messages: async () => messages,
		agents: async () => [],
		agentMessages: async () => [],
		close: async () => undefined,
	};
}
