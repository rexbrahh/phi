import assert from "node:assert/strict";
import test from "node:test";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { parseArgs } from "../src/config.js";
import type { HistoryReader } from "../src/history.js";
import { AppController } from "../src/ui/app.js";
import { FakeQueryHarness } from "./helpers/fake-query.js";
import { FakeTerminal } from "./helpers/terminal.js";
import { appDependencies, waitFor } from "./helpers/ui-app.js";

const RESUME_ID = "00000000-0000-4000-8000-000000000901";

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
