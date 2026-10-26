import assert from "node:assert/strict";
import test from "node:test";
import type { SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import type { HistoryReader } from "../src/history.js";
import { AppController } from "../src/ui/app.js";
import { FakeQueryHarness } from "./helpers/fake-query.js";
import { FakeTerminal } from "./helpers/terminal.js";
import { appDependencies, testLaunch, waitFor } from "./helpers/ui-app.js";

const targetId = "00000000-0000-4000-8000-000000000125";
function fixture(list: HistoryReader["list"]) {
	const terminal = new FakeTerminal();
	const first = new FakeQueryHarness();
	const second = new FakeQueryHarness();
	let queries = 0;
	const controller = new AppController(testLaunch(), appDependencies(first, terminal, {
		createQuery: (parameters) => (++queries === 1 ? first : second).createQuery(parameters),
		createHistoryReader: () => ({ list, messages: async () => [], agents: async () => [], agentMessages: async () => [], close: async () => undefined }),
	}));
	return { terminal, first, second, controller };
}

test("the session picker loads every project page and resumes the searched session", async () => {
	const sessions = Array.from({ length: 125 }, (_, index) => ({
		sessionId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
		summary: index === 124 ? "Search target" : `Session ${index}`,
		lastModified: index,
		cwd: process.cwd(),
	}));
	const projectOffsets: number[] = [];
	const { controller, terminal, second } = fixture(async (options) => {
		if (options.dir) projectOffsets.push(options.offset ?? 0);
		return sessions.slice(options.offset ?? 0, (options.offset ?? 0) + (options.limit ?? sessions.length));
	});
	const running = controller.run();
	try {
		await waitFor(() => controller.ready !== undefined);
		controller.setDraft("keep this draft");
		controller.openSessionPicker();
		await waitFor(() => terminal.output.includes("125 sessions"));
		assert.deepEqual(projectOffsets, [0, 100]);
		terminal.input("Search target");
		terminal.input("\r");
		await waitFor(() => second.parameters !== undefined && controller.ready !== undefined);
		assert.equal(second.parameters?.options?.resume, targetId);
		assert.equal(controller.sessionPickerVisible, false);
		assert.equal(controller.views.editor.getText(), "keep this draft");
	} finally { await controller.close(0); await running; }
});

test("closing the session picker during metadata lookup cancels resume before native work", async () => {
	let resolveLookup!: (sessions: SDKSessionInfo[]) => void;
	const lookup = new Promise<SDKSessionInfo[]>((resolve) => { resolveLookup = resolve; });
	let lookingUp = false;
	const target = { sessionId: targetId, summary: "Target", lastModified: 1, cwd: process.cwd() };
	const { controller, terminal, first, second } = fixture(async (options) => {
		if (options.dir) return [target];
		lookingUp = true;
		return lookup;
	});
	const running = controller.run();
	try {
		await waitFor(() => controller.ready !== undefined);
		controller.openSessionPicker();
		await waitFor(() => terminal.output.includes("1 session"));
		terminal.input("\r");
		await waitFor(() => lookingUp);
		terminal.input("\u001b");
		resolveLookup([target]);
		await new Promise<void>((resolve) => setImmediate(resolve));
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(controller.sessionPickerVisible, false);
		assert.equal(second.parameters, undefined);
		assert.equal(first.closeCalls, 0);
	} finally { await controller.close(0); await running; }
});

test("active work requires a second session selection before stop and switch", async () => {
	const target = { sessionId: targetId, summary: "Target", lastModified: 1, cwd: process.cwd() };
	const { controller, terminal, first, second } = fixture(async () => [target]);
	const running = controller.run();
	try {
		await waitFor(() => controller.ready !== undefined);
		controller.state.effectiveStatus.foreground = "running";
		controller.openSessionPicker();
		await waitFor(() => terminal.output.includes("1 session"));
		terminal.input("\r");
		await waitFor(() => terminal.output.includes("Work is active"));
		assert.equal(first.interruptCalls, 0);
		assert.equal(second.parameters, undefined);
		terminal.input("\r");
		await waitFor(() => second.parameters !== undefined);
		assert.equal(first.interruptCalls, 1);
	} finally { await controller.close(0); await running; }
});


test("Escape cancels active-work confirmation before a later resume command", async () => {
	const target = { sessionId: targetId, summary: "Target", lastModified: 1, cwd: process.cwd() };
	const { controller, terminal, first, second } = fixture(async () => [target]);
	const running = controller.run();
	try {
		await waitFor(() => controller.ready !== undefined);
		controller.state.effectiveStatus.foreground = "running";
		controller.openSessionPicker();
		await waitFor(() => terminal.output.includes("1 session"));
		terminal.input("\r");
		await waitFor(() => terminal.output.includes("Work is active"));
		terminal.input("\u001b");
		await controller.replaceSession({ kind: "resume", sessionId: targetId });
		assert.equal(first.interruptCalls, 0);
		assert.equal(second.parameters, undefined);
		await controller.replaceSession({ kind: "resume", sessionId: targetId });
		assert.equal(first.interruptCalls, 1);
		assert.ok(second.parameters);
	} finally { await controller.close(0); await running; }
});
