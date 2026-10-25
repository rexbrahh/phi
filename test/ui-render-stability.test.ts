import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Editor, TuiMainScreen, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { parseArgs } from "../src/config.js";
import { applySdkMessage, createState, type TaskRecord } from "../src/state.js";
import type { PendingInteraction } from "../src/interaction-types.js";
import { AppController } from "../src/ui/app.js";
import { DialogView } from "../src/ui/dialogs.js";
import { editorTheme } from "../src/ui/theme.js";
import { createInspectorModel, InspectorView } from "../src/ui/inspectors.js";
import { MainScreen } from "../src/ui/app-screen.js";
import { TranscriptView } from "../src/ui/transcript.js";
import { assistantMessage, textBlock } from "./helpers/sdk-event-core.js";
import { FakeQueryHarness } from "./helpers/fake-query.js";
import { FakeSignals, FakeTerminal } from "./helpers/terminal.js";

const LONG_TEXT = "界🙂 é ANSI \u001b[31mred\u001b[0m ".repeat(80);
const PASTE_LINE = "界🙂 é pasted " + "x".repeat(48);

test("screen, inspector, and dialog renderers fit narrow widths with long Unicode content", () => {
	const terminal = new FakeTerminal();
	const tui = new TuiMainScreen(terminal);
	tui.stop();
	const state = createState("/private/tmp/phi-render-project");
	applySdkMessage(state, assistantMessage({
		envelopeId: "render-stability",
		modelMessageId: "render-stability",
		content: [textBlock(LONG_TEXT)],
	}));
	state.conversationId = "session-" + "s".repeat(96);

	const task: TaskRecord = {
		taskId: "task-" + "t".repeat(96),
		status: "running",
		ambient: false,
		taskType: "local_workflow",
		workflowRunId: "run-" + "r".repeat(96),
		description: LONG_TEXT,
		progressSummary: LONG_TEXT,
		outputFile: "/private/tmp/" + "o".repeat(96),
	};
	state.tasks.set(task.taskId, task);

	const model = createInspectorModel();
	model.panel = "tasks";
	model.selectedTaskId = task.taskId;
	model.childAgentIds = ["child-" + "c".repeat(96)];
	model.selectedChildId = model.childAgentIds[0];
	model.workflowScriptPath = "/private/tmp/" + "p".repeat(96);
	model.workflowWarnings = [LONG_TEXT];
	model.historyError = LONG_TEXT;
	model.searchText = LONG_TEXT;
	model.workspace = {
		kind: "repository",
		cwd: "/private/tmp/" + "d".repeat(96),
		root: "/private/tmp/" + "w".repeat(96),
		branch: "branch-" + "b".repeat(96),
		detached: false,
		dirty: true,
		worktrees: [{
			path: "/private/tmp/" + "q".repeat(96),
			head: "0123456789abcdef",
			branch: "branch-" + "z".repeat(96),
			detached: false,
			bare: false,
			locked: false,
			prunable: false,
		}],
	};
	const inspector = new InspectorView(state, model);
	const transcript = new TranscriptView(state);
	const editor = new Editor(tui, editorTheme);
	const pastedText = Array.from({ length: 80 }, (_, index) => `${index}: ${PASTE_LINE}`).join("\n");
	editor.handleInput(`\u001b[200~${pastedText}\u001b[201~`);
	assert.equal(editor.getExpandedText(), pastedText, "the editor must preserve the full pasted text");
	const screen = new MainScreen(tui, state, transcript, inspector, editor);
	screen.update({
		workspace: model.workspace,
		notice: LONG_TEXT,
		shellMode: true,
		shellCwd: "/private/tmp/" + "c".repeat(96),
		attachments: [],
	});
	tui.addChild(screen.root);

	for (let width = 1; width <= 40; width += 1) {
		assertFits(transcript.render(width), width, `transcript at width ${width}`);
		for (let rows = 2; rows <= 12; rows += 1) {
			terminal.columns = width;
			terminal.rows = rows;
			assertFits(screen.root.render(width), width, `screen at ${width}x${rows}`);
			const editorRowCap = Math.max(5, Math.floor(rows * 0.3));
			assert.ok(editor.render(Math.max(width, 3)).length <= editorRowCap + 2, `editor exceeds its pi-tui row cap at ${width}x${rows}`);
		}
	}

	for (const panel of ["tasks", "history", "workspace"] as const) {
		model.panel = panel;
		for (let width = 1; width <= 40; width += 1) {
			assertFits(inspector.render(width), width, `${panel} inspector at width ${width}`);
		}
	}

	for (const request of dialogRequests()) {
		const dialog = new DialogView({ answer() {}, openUrl() {}, error() {} });
		dialog.setRequest(request);
		for (let width = 1; width <= 40; width += 1) {
			assertFits(dialog.render(width), width, `${request.kind} dialog at width ${width}`);
		}
	}
});

test("fake SDK rendering survives async dialog and resize updates without stale lines", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "phi-render-stability-"));
	const home = join(temporary, "home");
	const project = join(temporary, "project");
	await Promise.all([mkdir(home), mkdir(project)]);
	const environment: NodeJS.ProcessEnv = {
		PHI_HOME: home,
		CLAUDE_CONFIG_DIR: join(home, "legacy-config"),
		CLAUDE_CODE_PLUGIN_CACHE_DIR: join(home, "legacy-plugin-cache"),
	};
	const launch = parseArgs(["--cwd", project], environment);
	const terminal = new FakeTerminal();
	const fake = new FakeQueryHarness();
	const controller = new AppController(launch, {
		environment,
		createQuery: fake.createQuery,
		terminal,
		readClipboardImage: async () => null,
		copyText: async () => undefined,
		isInteractive: () => true,
		signals: new FakeSignals(),
		suspendProcess: () => undefined,
		readWorkspace: async (cwd) => ({ kind: "not-repository", cwd }),
		createHistoryReader: () => ({
			list: async () => [],
			messages: async () => [],
			agents: async () => [],
			agentMessages: async () => [],
			close: async () => undefined,
		}),
	});
	Object.defineProperty(controller.views.tui, "logDirectory", { value: project });
	const renderTracker = trackAsyncRenders(controller.views.tui);
	let running: Promise<number> | undefined;
	let pendingQuestion: Promise<unknown> | undefined;

	try {
		running = controller.run();
		await waitFor(() => controller.ready !== undefined && renderTracker.count() > 0);
		assert.deepEqual(renderTracker.errors, []);

		const taskId = "task-stale-" + "t".repeat(96);
		controller.state.tasks.set(taskId, {
			taskId,
			status: "running",
			ambient: false,
			taskType: "local_workflow",
			workflowRunId: "run-" + "r".repeat(96),
			description: LONG_TEXT,
		});
		let before = renderTracker.count();
		controller.views.inspectors.show("tasks");
		await waitFor(() => renderTracker.count() > before && controller.views.inspectors.model.selectedTaskId === taskId);
		assert.deepEqual(renderTracker.errors, []);

		const paste = Array.from({ length: 80 }, (_, index) => `${index}: ${PASTE_LINE}`).join("\n");
		before = renderTracker.count();
		terminal.input(`\u001b[200~${paste}\u001b[201~`);
		await waitFor(() => renderTracker.count() > before);
		assert.equal(controller.views.editor.getExpandedText(), paste);
		assert.deepEqual(renderTracker.errors, []);

		before = renderTracker.count();
		controller.views.inspectors.show("workspace");
		await waitFor(() => renderTracker.count() > before && controller.views.inspectors.model.workspace?.kind === "not-repository");
		const currentText = stripTerminalSequences(controller.views.tui.captureRenderState().previousLines.join("")).replace(/\s/gu, "");
		assert.ok(!currentText.includes(taskId), "the old task view must not remain in the rendered buffer");

		const canUseTool = fake.parameters?.options?.canUseTool;
		assert.ok(canUseTool);
		before = renderTracker.count();
		pendingQuestion = canUseTool("AskUserQuestion", {
			questions: [{ question: "Choose " + "界🙂".repeat(30), options: [{ label: "Option " + "x".repeat(80) }] }],
		}, {
			requestId: "render-stability-question",
			toolUseID: "render-stability-tool",
			signal: new AbortController().signal,
			title: "Question " + "q".repeat(80),
		} as Parameters<NonNullable<Options["canUseTool"]>>[2]);
		await waitFor(() => renderTracker.count() > before && controller.views.dialogs.requestId === "render-stability-question");
		assert.deepEqual(renderTracker.errors, []);

		const widths = [1, 2, 3, 4, 8, 12, 20, 40, 80, 2, 1];
		for (let rows = 2; rows <= 12; rows += 1) {
			before = renderTracker.count();
			terminal.resize(widths[rows - 2] ?? 80, rows);
			await waitFor(() => renderTracker.count() > before);
			assert.deepEqual(renderTracker.errors, [], `async render failed at ${terminal.columns}x${rows}`);
			const state = controller.views.tui.captureRenderState();
			assertFits(state.previousLines, terminal.columns, `TUI frame at ${terminal.columns}x${rows}`);
			assert.equal(state.previousViewportTop, Math.max(0, state.previousLines.length - rows), `viewport anchor at ${terminal.columns}x${rows}`);
		}

		before = renderTracker.count();
		terminal.resize(40, 7);
		terminal.resize(12, 5);
		terminal.resize(2, 2);
		await waitFor(() => renderTracker.count() > before);
		assert.deepEqual(renderTracker.errors, []);
		const finalState = controller.views.tui.captureRenderState();
		assert.equal(finalState.previousWidth, 2);
		assert.equal(finalState.previousHeight, 2);
		assert.equal(finalState.previousViewportTop, Math.max(0, finalState.previousLines.length - 2));
	} finally {
		await controller.close(0);
		await running;
		if (pendingQuestion) await pendingQuestion;
		await rm(temporary, { recursive: true, force: true });
	}
});

function assertFits(lines: readonly string[], width: number, label: string): void {
	for (const [index, line] of lines.entries()) {
		assert.ok(visibleWidth(line) <= width, `${label}: line ${index} is ${visibleWidth(line)} columns`);
	}
}

async function waitFor(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!condition()) {
		if (Date.now() >= deadline) throw new Error("Timed out while waiting for a render update.");
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
}

function dialogRequests(): PendingInteraction[] {
	return [
		{
			kind: "permission",
			requestId: "render-permission",
			nativePayload: {},
			abort: { aborted: false },
			toolName: "Read",
			toolUseID: "render-permission-tool",
			input: { path: "/private/tmp/" + "p".repeat(96) },
			title: "Permission " + "p".repeat(80),
			description: LONG_TEXT,
			suggestions: [],
			canAlwaysAllow: true,
			defaultToNo: true,
			suppressAlwaysAllowRule: false,
		},
		{
			kind: "question",
			requestId: "render-question",
			nativePayload: {},
			abort: { aborted: false },
			toolName: "AskUserQuestion",
			toolUseID: "render-question-tool",
			input: {},
			title: "Question " + "q".repeat(80),
			questions: [{ question: "Choose " + "界🙂".repeat(30), options: [{ label: "Option " + "x".repeat(80), description: LONG_TEXT }] }],
		},
		{
			kind: "elicitation",
			mode: "url",
			requestId: "render-url",
			nativePayload: {},
			abort: { aborted: false },
			request: {},
			url: "https://example.test/" + "u".repeat(80),
			canOpenUrl: true,
		},
		{
			kind: "elicitation",
			mode: "form",
			requestId: "render-form",
			nativePayload: {},
			abort: { aborted: false },
			request: {},
			form: {
				supported: true,
				title: "Form " + "f".repeat(80),
				fields: [{ name: "field-" + "n".repeat(80), title: "Title " + "t".repeat(80), type: "string", required: true, description: LONG_TEXT }],
			},
		},
	] as unknown as PendingInteraction[];
}

function trackAsyncRenders(tui: TuiMainScreen): { errors: unknown[]; count(): number } {
	const renderer = tui as unknown as { doRender(): void };
	const render = renderer.doRender.bind(tui);
	const errors: unknown[] = [];
	let count = 0;
	renderer.doRender = () => {
		try {
			render();
		} catch (error) {
			errors.push(error);
		} finally {
			count += 1;
		}
	};
	return { errors, count: () => count };
}
