import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { WorkflowOutput as SDKWorkflowOutput } from "@anthropic-ai/claude-agent-sdk/sdk-tools.js";

export type WorkflowOutput = SDKWorkflowOutput;

export interface WorkflowReference {
	sessionId: string;
	output: WorkflowOutput;
	configRoot: string;
}

export type WorkflowJournalRecordType = "launched" | "started" | "result" | "failed";

export interface WorkflowJournalRecord {
	type: WorkflowJournalRecordType;
	id?: string;
	agentId?: string;
	taskId?: string;
	phase?: string;
	label?: string;
	name?: string;
	timestamp?: string | number;
}

export interface WorkflowJournalMetadata {
	records: WorkflowJournalRecord[];
}

export interface JournalCursor {
	fileIdentity: string;
	byteOffset: number;
	incompleteBytes: Uint8Array;
	discardingOversizedRecord: boolean;
}

export interface JournalPage {
	metadata: WorkflowJournalMetadata;
	warnings: string[];
	reset: boolean;
	cursor?: JournalCursor;
}

const JOURNAL_FILE = "journal.jsonl";
const MAX_RECORD_BYTES = 2 * 1024 * 1024;
const MAX_BATCH_BYTES = 4 * 1024 * 1024;
const RECORD_TYPES: ReadonlySet<string> = new Set(["launched", "started", "result", "failed"]);
const UTF8 = new TextDecoder("utf-8", { fatal: true });

function emptyPage(warnings: string[], reset: boolean): JournalPage {
	return { metadata: { records: [] }, warnings, reset };
}

function isSafeComponent(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value !== "." &&
		value !== ".." &&
		!value.includes("/") &&
		!value.includes("\\") &&
		!value.includes("\0")
	);
}

function pathIsWithin(parent: string, child: string): boolean {
	const childRelative = relative(parent, child);
	return childRelative === "" || (!isAbsolute(childRelative) && childRelative !== ".." && !childRelative.startsWith(`..${sep}`));
}

function hasExpectedWorkflowComponents(
	configRoot: string,
	transcriptDir: string,
	sessionId: string,
	runId: string,
): boolean {
	const components = relative(configRoot, transcriptDir).split(sep).filter(Boolean);
	for (let index = 0; index + 5 < components.length; index += 1) {
		if (
			components[index] === "projects" &&
			components[index + 1] !== "" &&
			components[index + 2] === sessionId &&
			components[index + 3] === "subagents" &&
			components[index + 4] === "workflows" &&
			components[index + 5] === runId
		) {
			return true;
		}
	}
	return false;
}

function cursorIsUsable(cursor: JournalCursor | undefined): cursor is JournalCursor {
	return (
		cursor !== undefined &&
		typeof cursor.fileIdentity === "string" &&
		Number.isSafeInteger(cursor.byteOffset) &&
		cursor.byteOffset >= 0 &&
		cursor.incompleteBytes instanceof Uint8Array &&
		cursor.byteOffset >= cursor.incompleteBytes.byteLength &&
		cursor.incompleteBytes.byteLength <= MAX_RECORD_BYTES &&
		typeof cursor.discardingOversizedRecord === "boolean" &&
		(!cursor.discardingOversizedRecord || cursor.incompleteBytes.byteLength === 0)
	);
}

function scalarString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function firstString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = scalarString(record[key]);
		if (value !== undefined) return value;
	}
	return undefined;
}

function metadataRecord(value: unknown): WorkflowJournalRecord | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const source = value as Record<string, unknown>;
	if (typeof source.type !== "string" || !RECORD_TYPES.has(source.type)) return undefined;
	const record: WorkflowJournalRecord = { type: source.type as WorkflowJournalRecordType };
	const id = firstString(source, "id", "eventId", "uuid");
	const agentId = firstString(source, "agentId", "agent_id");
	const taskId = firstString(source, "taskId", "task_id");
	const phase = firstString(source, "phase", "phaseLabel", "phase_label");
	const label = firstString(source, "label");
	const name = firstString(source, "name");
	const timestamp = source.timestamp;
	if (id !== undefined) record.id = id;
	if (agentId !== undefined) record.agentId = agentId;
	if (taskId !== undefined) record.taskId = taskId;
	if (phase !== undefined) record.phase = phase;
	if (label !== undefined) record.label = label;
	if (name !== undefined) record.name = name;
	if (typeof timestamp === "string" || (typeof timestamp === "number" && Number.isFinite(timestamp))) {
		record.timestamp = timestamp;
	}
	return record;
}

function parseLine(
	lineBytes: Uint8Array,
	seenRecords: Set<string>,
	metadata: WorkflowJournalMetadata,
	warnings: string[],
	byteOffset: number,
): void {
	const normalized = lineBytes.at(-1) === 0x0d ? lineBytes.subarray(0, lineBytes.length - 1) : lineBytes;
	if (normalized.length === 0) return;

	let text: string;
	try {
		text = UTF8.decode(normalized);
	} catch {
		warnings.push(`Skipped a journal record with invalid UTF-8 near byte ${byteOffset}.`);
		return;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		warnings.push(`Skipped a corrupt journal record near byte ${byteOffset}.`);
		return;
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		warnings.push(`Skipped a journal record with no object shape near byte ${byteOffset}.`);
		return;
	}
	const source = parsed as Record<string, unknown>;
	if (typeof source.type !== "string" || !RECORD_TYPES.has(source.type)) {
		warnings.push(`Skipped an unknown journal record type: ${typeof source.type === "string" ? source.type : "missing"}.`);
		return;
	}

	const record = metadataRecord(source);
	if (!record) return;
	const key = record.id ? `${record.type}:${record.id}` : `${record.type}:${text}`;
	if (seenRecords.has(key)) {
		warnings.push(`Skipped a duplicate ${record.type} journal record.`);
		return;
	}
	seenRecords.add(key);
	metadata.records.push(record);
}

function identityOf(path: string, device: bigint, inode: bigint): string {
	return `${path}\0${device.toString()}:${inode.toString()}`;
}

function processBytes(
	priorBytes: Uint8Array,
	newBytes: Uint8Array,
	wasDiscarding: boolean,
	startOffset: number,
): {
	metadata: WorkflowJournalMetadata;
	warnings: string[];
	incompleteBytes: Uint8Array;
	discardingOversizedRecord: boolean;
} {
	const metadata: WorkflowJournalMetadata = { records: [] };
	const warnings: string[] = [];
	const seenRecords = new Set<string>();
	const combined = Buffer.concat([Buffer.from(priorBytes), Buffer.from(newBytes)]);
	let lineStart = 0;
	let discarding = wasDiscarding;
	let warnedOversized = wasDiscarding;

	for (let index = 0; index < combined.length; index += 1) {
		if (combined[index] === 0x0a) {
			if (discarding) {
				discarding = false;
				warnedOversized = false;
			} else {
				const line = combined.subarray(lineStart, index);
				if (line.length > MAX_RECORD_BYTES) {
					if (!warnedOversized) warnings.push("Skipped an oversized workflow journal record (over 2 MiB).");
					warnedOversized = false;
				} else {
					parseLine(line, seenRecords, metadata, warnings, startOffset + lineStart);
				}
			}
			lineStart = index + 1;
			continue;
		}

		if (!discarding && index - lineStart + 1 > MAX_RECORD_BYTES) {
			discarding = true;
			if (!warnedOversized) warnings.push("Skipped an oversized workflow journal record (over 2 MiB).");
			warnedOversized = true;
		}
	}

	let incompleteBytes = new Uint8Array();
	if (!discarding && lineStart < combined.length) {
		const incomplete = combined.subarray(lineStart);
		if (incomplete.length > MAX_RECORD_BYTES) {
			discarding = true;
			warnings.push("Skipped an oversized workflow journal record (over 2 MiB).");
		} else {
			incompleteBytes = Uint8Array.from(incomplete);
		}
	}
	return { metadata, warnings, incompleteBytes, discardingOversizedRecord: discarding };
}

export async function readWorkflowJournal(
	ref: WorkflowReference,
	cursor?: JournalCursor,
): Promise<JournalPage> {
	const sessionId = ref?.sessionId;
	const runId = ref?.output?.runId;
	const transcriptDir = ref?.output?.transcriptDir;
	if (
		!isSafeComponent(sessionId) ||
		!isSafeComponent(runId) ||
		typeof transcriptDir !== "string" ||
		!isAbsolute(transcriptDir) ||
		typeof ref?.configRoot !== "string" ||
		ref.configRoot.length === 0
	) {
		return emptyPage(["Workflow journal metadata is unavailable or invalid."], cursor !== undefined);
	}

	let rootPath: string;
	let transcriptPath: string;
	try {
		rootPath = await realpath(resolve(ref.configRoot));
		transcriptPath = await realpath(resolve(transcriptDir));
	} catch {
		return emptyPage(["Workflow journal directory is unavailable."], cursor !== undefined);
	}
	if (
		!pathIsWithin(rootPath, transcriptPath) ||
		!hasExpectedWorkflowComponents(rootPath, transcriptPath, sessionId, runId)
	) {
		return emptyPage(["Workflow journal path does not match the selected session and run under the config root."], cursor !== undefined);
	}

	let journalPath: string;
	try {
		journalPath = await realpath(join(transcriptPath, JOURNAL_FILE));
		const resolvedParent = await realpath(dirname(journalPath));
		if (!pathIsWithin(rootPath, journalPath) || resolvedParent !== transcriptPath) {
			return emptyPage(["Workflow journal file escapes its selected run directory."], cursor !== undefined);
		}
	} catch {
		return emptyPage(["Workflow journal file is unavailable."], cursor !== undefined);
	}

	let handle;
	try {
		handle = await open(journalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch {
		return emptyPage(["Workflow journal file could not be opened safely."], cursor !== undefined);
	}

	try {
		const fileStat = await handle.stat({ bigint: true });
		if (!fileStat.isFile()) return emptyPage(["Workflow journal is not a regular file."], cursor !== undefined);
		const currentIdentityKey = identityOf(journalPath, fileStat.dev, fileStat.ino);
		let reset = false;
		let offset = 0;
		let priorBytes: Uint8Array<ArrayBufferLike> = new Uint8Array();
		let discarding = false;
		if (cursor !== undefined) {
			if (!cursorIsUsable(cursor)) {
				reset = true;
			} else if (
				cursor.fileIdentity !== currentIdentityKey ||
				BigInt(cursor.byteOffset) > fileStat.size
			) {
				reset = true;
			} else {
				offset = cursor.byteOffset;
				priorBytes = cursor.incompleteBytes;
				discarding = cursor.discardingOversizedRecord;
			}
		}

		const available = fileStat.size - BigInt(offset);
		const batchLength = Number(available > BigInt(MAX_BATCH_BYTES) ? BigInt(MAX_BATCH_BYTES) : available);
		if (batchLength === 0) {
			return {
				metadata: { records: [] },
				warnings: [],
				reset,
				cursor: {
					fileIdentity: currentIdentityKey,
					byteOffset: offset,
					incompleteBytes: priorBytes,
					discardingOversizedRecord: discarding,
				},
			};
		}

		await setImmediate();
		const buffer = Buffer.allocUnsafe(batchLength);
		const { bytesRead } = await handle.read(buffer, 0, batchLength, offset);
		const readBytes = buffer.subarray(0, bytesRead);
		const processed = processBytes(priorBytes, readBytes, discarding, offset - priorBytes.byteLength);
		return {
			metadata: processed.metadata,
			warnings: processed.warnings,
			reset,
			cursor: {
				fileIdentity: currentIdentityKey,
				byteOffset: offset + bytesRead,
				incompleteBytes: processed.incompleteBytes,
				discardingOversizedRecord: processed.discardingOversizedRecord,
			},
		};
	} catch {
		return emptyPage(["Workflow journal could not be read."], cursor !== undefined);
	} finally {
		await handle.close();
	}
}
