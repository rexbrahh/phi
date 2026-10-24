import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readWorkflowJournal, type WorkflowReference } from "../src/workflows.js";

const SESSION_ID = "87654321-4321-4321-8321-cba987654321";
const RUN_ID = "workflow-run-19";
const BATCH_BYTES = 4 * 1024 * 1024;
const RECORD_BYTES = 2 * 1024 * 1024;

interface JournalFixture {
	root: string;
	configRoot: string;
	transcriptDir: string;
	journalPath: string;
	ref: WorkflowReference;
}

async function createFixture(): Promise<JournalFixture> {
	const root = await mkdtemp(join(tmpdir(), "phi-workflow-journal-"));
	const configRoot = join(root, "claude-config");
	const transcriptDir = join(
		configRoot,
		"projects",
		"synthetic-project",
		SESSION_ID,
		"subagents",
		"workflows",
		RUN_ID,
	);
	const journalPath = join(transcriptDir, "journal.jsonl");
	await mkdir(transcriptDir, { recursive: true });
	return {
		root,
		configRoot,
		transcriptDir,
		journalPath,
		ref: {
			sessionId: SESSION_ID,
			output: {
				status: "async_launched",
				taskId: "task-workflow-19",
				runId: RUN_ID,
				transcriptDir,
			},
			configRoot,
		},
	};
}

function event(type: string, fields: Record<string, unknown> = {}): string {
	return JSON.stringify({ type, ...fields });
}

async function disposeFixture(fixture: JournalFixture): Promise<void> {
	await rm(fixture.root, { recursive: true, force: true });
}

test("journal cursor preserves an incomplete UTF-8 sequence across the 4 MiB boundary", async () => {
	const fixture = await createFixture();
	try {
		const line = `${event("started", { agentId: "agent-boundary", phase: "café" })}\n`;
		const bytes = Buffer.from(line, "utf8");
		const accentOffset = bytes.indexOf(Buffer.from("é", "utf8"));
		assert.ok(accentOffset > 0);
		const prefixLength = BATCH_BYTES - 1 - accentOffset;
		const oversizedPrefix = `${"x".repeat(prefixLength - 1)}\n`;
		await writeFile(fixture.journalPath, `${oversizedPrefix}${line}`);

		const first = await readWorkflowJournal(fixture.ref);
		assert.equal(first.cursor?.byteOffset, BATCH_BYTES);
		assert.ok(first.cursor?.incompleteBytes.length);
		assert.ok(first.warnings.some((warning) => /oversized/i.test(warning)));
		assert.deepEqual(first.metadata.records, []);

		const second = await readWorkflowJournal(fixture.ref, first.cursor);
		assert.deepEqual(second.metadata.records, [
			{ type: "started", agentId: "agent-boundary", phase: "café" },
		]);
	} finally {
		await disposeFixture(fixture);
	}
});

test("an incomplete final line is emitted only after a later append completes it", async () => {
	const fixture = await createFixture();
	try {
		const partial = event("started", { agentId: "agent-a", phase: "review" });
		const unfinished = partial.slice(0, -3);
		const remainder = partial.slice(-3);
		await writeFile(fixture.journalPath, `${event("launched", { agentId: "agent-a" })}\n${unfinished}`);
		const first = await readWorkflowJournal(fixture.ref);
		assert.equal(first.metadata.records.length, 1);
		assert.equal(first.cursor?.incompleteBytes.length, Buffer.byteLength(unfinished));

		await writeFile(fixture.journalPath, `${await readFile(fixture.journalPath, "utf8")}${remainder}\n`);
		const second = await readWorkflowJournal(fixture.ref, first.cursor);
		assert.deepEqual(second.metadata.records, [
			{ type: "started", agentId: "agent-a", phase: "review" },
		]);
	} finally {
		await disposeFixture(fixture);
	}
});

test("observed lifecycle records preserve keys and deduplicate identical rows after cursor continuation", async () => {
	const fixture = await createFixture();
	try {
		const key = "opaque-correlation-key-1";
		const observedRecords = [
			event("launched"),
			event("started", { key, agentId: "agent-a", label: "Review", phase: "review" }),
			event("result", { key, agentId: "agent-a", result: "synthetic result text" }),
			event("failed", { key: "opaque-correlation-key-2", agentId: "agent-b" }),
		];
		const prefix = `${"x".repeat(BATCH_BYTES - 1)}\n`;
		await writeFile(
			fixture.journalPath,
			`${prefix}${observedRecords.flatMap((record) => [record, record]).join("\n")}\n`,
		);

		const first = await readWorkflowJournal(fixture.ref);
		assert.deepEqual(first.metadata.records, []);
		assert.equal(first.cursor?.byteOffset, BATCH_BYTES);
		assert.ok(first.cursor);

		const continued = await readWorkflowJournal(fixture.ref, first.cursor);
		assert.deepEqual(continued.metadata.records, [
			{ type: "launched" },
			{ type: "started", key, agentId: "agent-a", phase: "review", label: "Review" },
			{ type: "result", key, agentId: "agent-a" },
			{ type: "failed", key: "opaque-correlation-key-2", agentId: "agent-b" },
		]);
		assert.equal(continued.warnings.filter((warning) => /duplicate/i.test(warning)).length, 4);
		assert.deepEqual(
			continued.metadata.records
				.filter((record) => record.type === "started" || record.type === "result")
				.map((record) => ({ type: record.type, key: "key" in record ? record.key : undefined })),
			[
				{ type: "started", key },
				{ type: "result", key },
			],
		);
		assert.equal("result" in continued.metadata.records[2]!, false);
	} finally {
		await disposeFixture(fixture);
	}
});

test("append reads only records after the prior byte cursor", async () => {
	const fixture = await createFixture();
	try {
		await writeFile(fixture.journalPath, `${event("launched", { agentId: "agent-a" })}\n`);
		const first = await readWorkflowJournal(fixture.ref);
		assert.equal(first.metadata.records.length, 1);

		await writeFile(
			fixture.journalPath,
			`${await readFile(fixture.journalPath, "utf8")}${event("result", { agentId: "agent-a" })}\n`,
		);
		const second = await readWorkflowJournal(fixture.ref, first.cursor);
		assert.deepEqual(second.metadata.records, [{ type: "result", agentId: "agent-a" }]);
		assert.equal(second.reset, false);
	} finally {
		await disposeFixture(fixture);
	}
});

test("truncating a journal resets the byte cursor and rereads new records", async () => {
	const fixture = await createFixture();
	try {
		await writeFile(fixture.journalPath, `${event("launched", { agentId: "agent-a" })}\n`);
		const first = await readWorkflowJournal(fixture.ref);
		await writeFile(fixture.journalPath, `${event("failed", { agentId: "agent-b" })}\n`);

		const afterTruncate = await readWorkflowJournal(fixture.ref, first.cursor);
		assert.equal(afterTruncate.reset, true);
		assert.deepEqual(afterTruncate.metadata.records, [{ type: "failed", agentId: "agent-b" }]);
	} finally {
		await disposeFixture(fixture);
	}
});

test("replacing a journal file resets its identity-bound cursor", async () => {
	const fixture = await createFixture();
	try {
		await writeFile(fixture.journalPath, `${event("launched", { agentId: "agent-a" })}\n`);
		const first = await readWorkflowJournal(fixture.ref);
		const replacement = join(fixture.transcriptDir, "replacement.jsonl");
		await writeFile(replacement, `${event("started", { agentId: "agent-b", phase: "build" })}\n`);
		await rename(replacement, fixture.journalPath);

		const afterReplace = await readWorkflowJournal(fixture.ref, first.cursor);
		assert.equal(afterReplace.reset, true);
		assert.deepEqual(afterReplace.metadata.records, [
			{ type: "started", agentId: "agent-b", phase: "build" },
		]);
	} finally {
		await disposeFixture(fixture);
	}
});

test("unknown journal record types are skipped with a warning", async () => {
	const fixture = await createFixture();
	try {
		await writeFile(
			fixture.journalPath,
			`${event("future-record", { agentId: "agent-a" })}\n${event("started", { agentId: "agent-b" })}\n`,
		);
		const page = await readWorkflowJournal(fixture.ref);
		assert.deepEqual(page.metadata.records, [{ type: "started", agentId: "agent-b" }]);
		assert.ok(page.warnings.some((warning) => /unknown.*future-record/i.test(warning)));
	} finally {
		await disposeFixture(fixture);
	}
});

test("oversized records are scanned without blocking following metadata", async () => {
	const fixture = await createFixture();
	try {
		const oversized = `${"x".repeat(RECORD_BYTES + 1)}\n`;
		await writeFile(
			fixture.journalPath,
			`${oversized}${event("result", { agentId: "agent-after-large-record" })}\n`,
		);
		const page = await readWorkflowJournal(fixture.ref);
		assert.deepEqual(page.metadata.records, [
			{ type: "result", agentId: "agent-after-large-record" },
		]);
		assert.ok(page.warnings.some((warning) => /oversized/i.test(warning)));
		assert.ok((page.cursor?.incompleteBytes.length ?? 0) <= RECORD_BYTES);
	} finally {
		await disposeFixture(fixture);
	}
});

test("a workflow path outside the selected session is unavailable", async () => {
	const fixture = await createFixture();
	try {
		await writeFile(fixture.journalPath, `${event("result", { agentId: "agent-a" })}\n`);
		const wrongSessionRef: WorkflowReference = {
			...fixture.ref,
			sessionId: "another-session-id",
		};
		const page = await readWorkflowJournal(wrongSessionRef);
		assert.deepEqual(page.metadata.records, []);
		assert.ok(page.warnings.some((warning) => /session/i.test(warning)));
	} finally {
		await disposeFixture(fixture);
	}
});

test("missing SDK workflow journal metadata stays unavailable", async () => {
	const fixture = await createFixture();
	try {
		const page = await readWorkflowJournal({
			sessionId: SESSION_ID,
			output: { status: "remote_launched", taskId: "remote-task" },
			configRoot: fixture.configRoot,
		});
		assert.deepEqual(page.metadata.records, []);
		assert.equal(page.cursor, undefined);
		assert.ok(page.warnings.some((warning) => /metadata.*unavailable/i.test(warning)));
	} finally {
		await disposeFixture(fixture);
	}
});

test("a symlinked workflow directory cannot escape the effective config root", async () => {
	const fixture = await createFixture();
	try {
		const outsideDir = join(fixture.root, "outside-run");
		await mkdir(outsideDir, { recursive: true });
		await writeFile(join(outsideDir, "journal.jsonl"), `${event("result", { agentId: "secret" })}\n`);
		await rm(fixture.transcriptDir, { recursive: true });
		await symlink(outsideDir, fixture.transcriptDir, "dir");

		const page = await readWorkflowJournal(fixture.ref);
		assert.deepEqual(page.metadata.records, []);
		assert.ok(page.warnings.some((warning) => /path|config root|escape/i.test(warning)));
	} finally {
		await disposeFixture(fixture);
	}
});
