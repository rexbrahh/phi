import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import { test } from "node:test";
import { createHistoryReader, type HistoryReader } from "../src/history.js";

const SESSION_ID = "12345678-1234-4234-8234-123456789abc";
const AGENT_ID = "nested-42";
const WORKFLOW_RUN_ID = "workflow-run-7";

interface HistoryFixture {
	root: string;
	configRoot: string;
	projectDir: string;
	reader: HistoryReader;
}

async function createFixture(): Promise<HistoryFixture> {
	const root = await mkdtemp(join(tmpdir(), "phi-history-reader-"));
	const configRoot = join(root, "claude-config");
	const projectDir = join(root, "working-copy");
	const projectStore = join(configRoot, "projects", "synthetic-project");
	const sessionDirectory = join(projectStore, SESSION_ID);
	const nestedAgentDirectory = join(
		sessionDirectory,
		"subagents",
		"workflows",
		WORKFLOW_RUN_ID,
	);
	await mkdir(nestedAgentDirectory, { recursive: true });
	await mkdir(projectDir, { recursive: true });

	const parentUser = sdkRow({
		type: "user",
		uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		parentUuid: null,
		sessionId: SESSION_ID,
		cwd: projectDir,
		message: { role: "user", content: "synthetic parent prompt" },
	});
	const parentAssistant = sdkRow({
		type: "assistant",
		uuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
		parentUuid: parentUser.uuid,
		sessionId: SESSION_ID,
		cwd: projectDir,
		message: { role: "assistant", content: [{ type: "text", text: "synthetic parent reply" }] },
	});
	await writeFile(
		join(projectStore, `${SESSION_ID}.jsonl`),
		`${JSON.stringify(parentUser)}\n${JSON.stringify(parentAssistant)}\n`,
	);

	const agentUser = sdkRow({
		type: "user",
		uuid: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
		parentUuid: null,
		sessionId: SESSION_ID,
		cwd: projectDir,
		message: { role: "user", content: "synthetic child prompt" },
	});
	const agentAssistant = sdkRow({
		type: "assistant",
		uuid: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
		parentUuid: agentUser.uuid,
		sessionId: SESSION_ID,
		cwd: projectDir,
		message: { role: "assistant", content: [{ type: "text", text: "synthetic child reply" }] },
	});
	await writeFile(
		join(nestedAgentDirectory, `agent-${AGENT_ID}.jsonl`),
		`${JSON.stringify(agentUser)}\n${JSON.stringify(agentAssistant)}\n`,
	);

	return {
		root,
		configRoot,
		projectDir,
		reader: createHistoryReader({ configRoot }),
	};
}

function sdkRow(row: Record<string, unknown>): Record<string, unknown> {
	return {
		timestamp: "2026-10-24T12:00:00.000Z",
		version: "2.0.0",
		...row,
	};
}

async function disposeFixture(fixture: HistoryFixture): Promise<void> {
	await fixture.reader.close();
	await rm(fixture.root, { recursive: true, force: true });
}

test("native SDK history APIs read a workflow-nested child transcript", async () => {
	const fixture = await createFixture();
	try {
		const sessions = await fixture.reader.list({});
		assert.ok(sessions.some((session) => session.sessionId === SESSION_ID));

		const parentMessages = await fixture.reader.messages(SESSION_ID, { limit: 200, offset: 0 });
		assert.equal(parentMessages.length, 2);
		assert.equal((parentMessages[0]?.message as { content?: unknown }).content, "synthetic parent prompt");
		assert.deepEqual((parentMessages[1]?.message as { content?: unknown }).content, [
			{ type: "text", text: "synthetic parent reply" },
		]);

		const agents = await fixture.reader.agents(SESSION_ID, {});
		assert.deepEqual(agents, [AGENT_ID]);
		const childMessages = await fixture.reader.agentMessages(SESSION_ID, AGENT_ID, {
			limit: 200,
			offset: 0,
		});
		assert.equal(childMessages.length, 2);
		assert.deepEqual((childMessages[1]?.message as { content?: unknown }).content, [
			{ type: "text", text: "synthetic child reply" },
		]);
	} finally {
		await disposeFixture(fixture);
	}
});

test("SDK history APIs return empty results for a missing session", async () => {
	const fixture = await createFixture();
	try {
		assert.deepEqual(await fixture.reader.messages("missing-session-id", {}), []);
		assert.deepEqual(await fixture.reader.agents("missing-session-id", {}), []);
		assert.deepEqual(
			await fixture.reader.agentMessages("missing-session-id", "missing-agent", {}),
			[],
		);
	} finally {
		await disposeFixture(fixture);
	}
});

test("a corrupt SDK JSONL row does not hide adjacent valid history", async () => {
	const fixture = await createFixture();
	try {
		const transcript = join(fixture.configRoot, "projects", "synthetic-project", `${SESSION_ID}.jsonl`);
		const original = await readFile(transcript, "utf8");
		await writeFile(transcript, `${original}not-json\n`);
		const messages = await fixture.reader.messages(SESSION_ID, {});
		assert.equal(messages.length, 2);
		assert.deepEqual((messages[1]?.message as { content?: unknown }).content, [
			{ type: "text", text: "synthetic parent reply" },
		]);
	} finally {
		await disposeFixture(fixture);
	}
});

class ControlledWorker extends EventEmitter {
	readonly requests: Array<{
		id: number;
		operation: { kind: string; [key: string]: unknown };
		[key: string]: unknown;
	}> = [];
	terminateCalls = 0;

	postMessage(request: {
		id: number;
		operation: { kind: string; [key: string]: unknown };
		[key: string]: unknown;
	}): void {
		this.requests.push(structuredClone(request));
	}

	async terminate(): Promise<number> {
		this.terminateCalls += 1;
		this.emit("exit", 1);
		return 1;
	}

	respond(id: number, result: unknown): void {
		this.emit("message", { id, ok: true, value: result });
	}
}

function controlledReader(worker: ControlledWorker): HistoryReader {
	return createHistoryReader({ workerFactory: () => worker as unknown as Worker });
}

test("worker errors reject pending history reads", async () => {
	const worker = new ControlledWorker();
	const reader = controlledReader(worker);
	const pending = reader.list({});
	worker.emit("error", new Error("synthetic worker crash"));
	await assert.rejects(pending, /synthetic worker crash/);
	await reader.close();
});

test("function-backed SDK session stores are rejected before worker dispatch", async () => {
	const worker = new ControlledWorker();
	const reader = controlledReader(worker);
	await assert.rejects(
		reader.list({ sessionStore: { listSessions: async () => [] } as never }),
		/sessionStore.*worker/i,
	);
	assert.equal(worker.requests.length, 0);
	await reader.close();
});

test("out-of-order responses after a session switch stay with their original reads", async () => {
	const worker = new ControlledWorker();
	const reader = controlledReader(worker);
	const oldSessionRead = reader.messages("old-session", {});
	const newSessionRead = reader.messages("new-session", {});
	const [oldRequest, newRequest] = worker.requests;
	assert.ok(oldRequest && newRequest);
	assert.equal(oldRequest.operation.kind, "messages");
	assert.equal(newRequest.operation.kind, "messages");

	worker.respond(newRequest.id, [{ uuid: "new-result" }]);
	worker.respond(oldRequest.id, [{ uuid: "old-result" }]);
	assert.deepEqual(await newSessionRead, [{ uuid: "new-result" }]);
	assert.deepEqual(await oldSessionRead, [{ uuid: "old-result" }]);
	await reader.close();
});

test("closing the history reader rejects reads that are still pending", async () => {
	const worker = new ControlledWorker();
	const reader = controlledReader(worker);
	const pending = reader.list({});

	await reader.close();
	await assert.rejects(pending, /closed/i);
	assert.equal(worker.terminateCalls, 1);
	await reader.close();
	assert.equal(worker.terminateCalls, 1);
});
