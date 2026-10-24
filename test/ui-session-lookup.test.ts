import assert from "node:assert/strict";
import test from "node:test";
import type { SDKSessionInfo, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { parseArgs } from "../src/config.js";
import type { HistoryReader } from "../src/history.js";
import { AppController } from "../src/ui/app.js";
import { FakeQueryHarness } from "./helpers/fake-query.js";
import { FakeTerminal } from "./helpers/terminal.js";
import { appDependencies, waitFor } from "./helpers/ui-app.js";

const RESUME_ID = "00000000-0000-4000-8000-000000000901";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

test("resume reports local session metadata failure and keeps the SDK target visible", async () => {
	const terminal = new FakeTerminal();
	const first = new FakeQueryHarness();
	const second = new FakeQueryHarness();
	let queryCount = 0;
	const history: HistoryReader = {
		list: async () => { throw new Error("metadata unavailable"); },
		messages: async (): Promise<SessionMessage[]> => [],
		agents: async (): Promise<string[]> => [],
		agentMessages: async (): Promise<SessionMessage[]> => [],
		close: async () => undefined,
	};
	const controller = new AppController(parseArgs([]), appDependencies(first, terminal, {
		createQuery: (parameters) => {
			queryCount += 1;
			return queryCount === 1 ? first.createQuery(parameters) : second.createQuery(parameters);
		},
		createHistoryReader: () => history,
	}));
	const running = controller.run();
	try {
		await waitFor(() => controller.ready !== undefined);
		const currentCwd = controller.state.cwd;
		controller.submitPrompt(`/phi resume ${RESUME_ID}`);
		await waitFor(() => second.parameters !== undefined && controller.ready !== undefined);
		const output = () => terminal.output
			.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, "")
			.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
			.replace(/\s+/gu, " ");
		await waitFor(() => output().includes("metadata unavailable"));
		assert.equal(second.parameters?.options?.resume, RESUME_ID);
		assert.equal(second.parameters?.options?.cwd, currentCwd);
		assert.equal(controller.currentSessionId, RESUME_ID);
		assert.match(output(), /uses the current directory/u);
	} finally {
		await controller.close(0);
		await running;
	}
});

test("resume lookup resolving or rejecting after close cannot create a query after terminal restoration", async () => {
	for (const outcome of ["resolve", "reject"] as const) {
		const terminal = new FakeTerminal();
		const first = new FakeQueryHarness();
		const second = new FakeQueryHarness();
		const lookup = deferred<SDKSessionInfo[]>();
		let lookupStarted = false;
		let queryCount = 0;
		const history: HistoryReader = {
			list: async () => {
				lookupStarted = true;
				return lookup.promise;
			},
			messages: async (): Promise<SessionMessage[]> => [],
			agents: async () => [],
			agentMessages: async (): Promise<SessionMessage[]> => [],
			close: async () => undefined,
		};
		const controller = new AppController(parseArgs([]), appDependencies(first, terminal, {
			createQuery: (parameters) => {
				queryCount += 1;
				return queryCount === 1 ? first.createQuery(parameters) : second.createQuery(parameters);
			},
			createHistoryReader: () => history,
		}));
		const running = controller.run();
		await waitFor(() => controller.ready !== undefined);
		const originalSessionId = controller.currentSessionId;
		const transition = controller.replaceSession({ kind: "resume", sessionId: RESUME_ID });
		await waitFor(() => lookupStarted);
		await controller.close(0);
		assert.equal(await running, 0);
		assert.equal(first.closeCalls, 1);
		assert.equal(terminal.stopCalls, 1);

		if (outcome === "resolve") lookup.resolve([{ sessionId: RESUME_ID, summary: "resume", lastModified: 1, cwd: "/late" }]);
		else lookup.reject(new Error("history closed"));
		await transition;

		assert.equal(queryCount, 1);
		assert.equal(second.parameters, undefined);
		assert.equal(controller.currentSessionId, originalSessionId);
	}
});

test("resume finds the target session after the first all-project history page", async () => {
	const terminal = new FakeTerminal();
	const first = new FakeQueryHarness();
	const second = new FakeQueryHarness();
	const offsets: number[] = [];
	const history: HistoryReader = {
		list: async (options) => {
			const offset = options.offset ?? 0;
			offsets.push(offset);
			if (offset === 0) {
				return Array.from({ length: 1_000 }, (_, index) => ({
					sessionId: `session-${index}`,
					summary: "older session",
					lastModified: index,
				}));
			}
			if (offset === 1_000) {
				return [{ sessionId: RESUME_ID, summary: "target", lastModified: 1_001, cwd: "/target/cwd" }];
			}
			return [];
		},
		messages: async (): Promise<SessionMessage[]> => [],
		agents: async () => [],
		agentMessages: async (): Promise<SessionMessage[]> => [],
		close: async () => undefined,
	};
	let queryCount = 0;
	const controller = new AppController(parseArgs([]), appDependencies(first, terminal, {
		createQuery: (parameters) => {
			queryCount += 1;
			return queryCount === 1 ? first.createQuery(parameters) : second.createQuery(parameters);
		},
		createHistoryReader: () => history,
	}));
	const running = controller.run();
	try {
		await waitFor(() => controller.ready !== undefined);
		controller.submitPrompt(`/phi resume ${RESUME_ID}`);
		await waitFor(() => second.parameters !== undefined && controller.ready !== undefined);
		assert.deepEqual(offsets, [0, 1_000]);
		assert.equal(second.parameters?.options?.resume, RESUME_ID);
		assert.equal(second.parameters?.options?.cwd, "/target/cwd");
	} finally {
		await controller.close(0);
		await running;
	}
});

test("resume history lookup stops before the next page after shutdown", async () => {
	const terminal = new FakeTerminal();
	const first = new FakeQueryHarness();
	const second = new FakeQueryHarness();
	const offsets: number[] = [];
	let controller: AppController;
	let closing: Promise<void> | undefined;
	const history: HistoryReader = {
		list: async (options) => {
			const offset = options.offset ?? 0;
			offsets.push(offset);
			if (offset === 0) {
				return new Promise((resolve) => {
					queueMicrotask(() => {
						queueMicrotask(() => { closing = controller.close(0); });
						resolve(Array.from({ length: 1_000 }, (_, index) => ({
							sessionId: `session-${index}`,
							summary: "older session",
							lastModified: index,
						})));
					});
				});
			}
			return [];
		},
		messages: async (): Promise<SessionMessage[]> => [],
		agents: async () => [],
		agentMessages: async (): Promise<SessionMessage[]> => [],
		close: async () => undefined,
	};
	let queryCount = 0;
	controller = new AppController(parseArgs([]), appDependencies(first, terminal, {
		createQuery: (parameters) => {
			queryCount += 1;
			return queryCount === 1 ? first.createQuery(parameters) : second.createQuery(parameters);
		},
		createHistoryReader: () => history,
	}));
	const running = controller.run();
	const transition = async () => controller.replaceSession({ kind: "resume", sessionId: RESUME_ID });
	try {
		await waitFor(() => controller.ready !== undefined);
		const switching = transition();
		await waitFor(() => closing !== undefined);
		await closing;
		await running;
		await switching;
		assert.deepEqual(offsets, [0]);
		assert.equal(queryCount, 1);
		assert.equal(second.parameters, undefined);
		assert.equal(terminal.stopCalls, 1);
	} finally {
		await controller.close(0);
		await running;
	}
});
