import assert from "node:assert/strict";
import { randomUUID, type UUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
	HookCallback,
	HookEvent,
	HookJSONOutput,
	Options,
	PreToolUseHookInput,
	SDKMessage,
	SDKResultMessage,
	SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { MonitorInput } from "@anthropic-ai/claude-agent-sdk/sdk-tools.js";
import type { WorkflowJournalMetadata, WorkflowOutput, WorkflowReference } from "../src/workflows.js";
import { formatErrorText } from "../src/ui/error-text.js";

const SKILL_NAME = "phi-live-acceptance";
export const LIVE_MODEL = "claude-haiku-5-5";
const MAX_LIVE_BUDGET_USD = 0.10;
const MAX_OUTPUT_TOKENS = "1024";
const MAX_MAIN_TURNS = 6;
const MAX_WORKFLOW_AGENT_TURNS = "2";
const MAIN_SLEEP_COMMAND = "sleep 8";
const AGENT_SLEEP_COMMAND = "sleep 90";
const INITIAL_BUDGET_SHARE = 0.75;
const MAX_TOTAL_TIME_MS = 180_000;
const STEP_TIMEOUT_MS = 60_000;
const NATIVE_STOP_OBSERVATION_MS = 8_000;
const TERMINATION_TIMEOUT_MS = 15_000;
const WORKFLOW_AGENT_RELEASE_FILE_NAMES = {
	stopped: ".phi-live-agent-stopped.release",
	continued: ".phi-live-agent-continued.release",
} as const;
type FixtureMonitorInput = Required<Pick<MonitorInput, "description" | "timeout_ms" | "command">>;
export const FIXED_WORKFLOW_MONITOR_INPUTS = {
	stopped: {
		description: "Wait for the stopped agent release file",
		timeout_ms: STEP_TIMEOUT_MS,
		command: `until [ -f ${WORKFLOW_AGENT_RELEASE_FILE_NAMES.stopped} ]; do sleep 1; done`,
	},
	continued: {
		description: "Wait for the continued agent release file",
		timeout_ms: STEP_TIMEOUT_MS,
		command: `until [ -f ${WORKFLOW_AGENT_RELEASE_FILE_NAMES.continued} ]; do sleep 1; done`,
	},
} as const satisfies Record<"stopped" | "continued", FixtureMonitorInput>;
const MAX_FAILURE_DIAGNOSTIC_CHARS = 1_200;
const MAX_CAUSE_DETAILS = 4;
const MAX_CAUSE_MESSAGE_CHARS = 220;
const MAX_WORKFLOW_FAILURE_EVIDENCE_CHARS = 1_900;
const MAX_WORKFLOW_ERROR_EXCERPT_CHARS = 320;
const MAX_DIAGNOSTIC_LIST_ITEMS = 6;
const MAX_DIAGNOSTIC_LABEL_CHARS = 40;
const MAX_FAILURE_TRACE_BYTES = 2 * 1024 * 1024;
const FAILURE_TRACE_FILENAME = "native-sdk-failure-trace.json";
const MAX_PERMISSION_DENIALS = 3;
const MAX_PERMISSION_SUMMARY_CHARS = 640;
const MAX_PERMISSION_INPUT_KEYS = 3;
const MAX_PERMISSION_INPUT_KEY_CHARS = 32;
const WORKFLOW_AGENT_LABELS = {
	stopped: "phi-live-agent-stopped",
	continued: "phi-live-agent-continued",
} as const;
const WORKFLOW_TASK_EVENT_TYPES = [
	"task_started",
	"task_notification",
	"task_updated",
	"task_progress",
	"background_tasks_changed",
] as const;
const SAFE_WORKFLOW_TASK_TYPES = new Set(["local_agent", "local_bash", "local_workflow", "mcp_task"]);
const SAFE_BACKGROUND_TASK_CLASSES = new Set([
	...SAFE_WORKFLOW_TASK_TYPES,
	"shell",
	"subagent",
	"monitor",
	"workflow",
	"other",
]);
const WORKFLOW_TERMINAL_STATUSES = ["completed", "failed", "stopped"] as const;

let failureDiagnosticEmitted = false;

function createNativeControlTrace(): NativeControlTrace {
	return {
		lifecycle: [],
		monitorRequests: [],
		backgroundControls: [],
		stopAttempts: [],
	};
}

export function mergeHookMatchers(
	existing: Options["hooks"] | undefined,
	additions: NonNullable<Options["hooks"]>,
): NonNullable<Options["hooks"]> {
	const merged: NonNullable<Options["hooks"]> = { ...(existing ?? {}) };
	for (const event of Object.keys(additions) as HookEvent[]) {
		const addedMatchers = additions[event];
		if (addedMatchers === undefined) continue;
		merged[event] = [...(merged[event] ?? []), ...addedMatchers];
	}
	return merged;
}

export function formatNativeControlSummary(trace: NativeControlTrace): string {
	const startedAgentIds = new Set(trace.lifecycle
		.filter((record) => record.event === "SubagentStart")
		.map((record) => record.agentId));
	const observedClasses = new Set(trace.backgroundControls.flatMap((record) =>
		record.subsequentTaskClasses.flat(),
	).filter((taskClass) => SAFE_BACKGROUND_TASK_CLASSES.has(taskClass)));
	const taskClasses = [...observedClasses].sort().join(",") || "none";
	const backgroundResult = trace.backgroundControls.length > 0
		? String(trace.backgroundControls.at(-1)?.returned)
		: "unobserved";
	const firstStop = trace.stopAttempts[0];
	const secondStop = trace.stopAttempts[1];
	const stopConfirmed = (attempt: NativeStopAttemptRecord | undefined) =>
		attempt?.candidateKind === "native-task" && attempt.callResolved === true &&
		attempt.stoppedNotification === true && attempt.monitorCancelled === true;
	const countRequests = (settlement: NativeMonitorRequestRecord["settlement"]) =>
		trace.monitorRequests.filter((record) => record.settlement === settlement).length;
	return [
		`workflowPhaseStarts=${trace.journalPhaseStarts ?? "unobserved"}`,
		`nativeAgentStarts=${startedAgentIds.size}`,
		`journalIdentityMatches=${trace.journalMatchedAgentStarts ?? "unobserved"}`,
		`monitorToolRequests=${trace.monitorRequests.filter((record) => record.scenario !== "invalid").length}`,
		`pendingMonitorRequestsAtControl=${trace.pendingMonitorRequestCount ?? "unobserved"}`,
		`monitorRequestsSignalCancelled=${countRequests("signal-aborted")}`,
		`backgroundTasksReturned=${backgroundResult}`,
		`backgroundTargetClass=${trace.backgroundControls.at(-1)?.targetClass ?? "unobserved"}`,
		`backgroundTaskClasses=[${taskClasses}]`,
		`firstStopConfirmed=${String(stopConfirmed(firstStop))}`,
		`firstStopTargetClass=${firstStop?.candidateKind ?? "unobserved"}`,
		`siblingPendingAfterFirstStop=${String(trace.siblingPendingAfterFirstStop ?? false)}`,
		`secondStopConfirmed=${String(stopConfirmed(secondStop))}`,
		`subagentStopHooks=${trace.lifecycle.filter((record) => record.event === "SubagentStop").length}`,
		`continuedInput=${String(trace.continuedInput ?? false)}`,
		`checkpointPreview=${String(trace.checkpointPreview ?? false)}`,
		`resumed=${String(trace.resumed ?? false)}`,
	].join("; ");
}

export interface LiveQueryLifecycle {
	done: Promise<void>;
	close(): Promise<void>;
}

export interface LiveCloseOutcome {
	terminated: boolean;
	error?: unknown;
}

export interface LivePermissionDenial {
	toolName: string;
	inputKeys: string;
	reason: string;
}

export interface LivePermissionTraceDenial {
	toolName: string;
	input: Record<string, unknown>;
	reason: string;
	toolUseID?: string;
}

export interface LivePermissionEvidence {
	deniedActionCount: number;
	denials: LivePermissionDenial[];
	traceDenials?: LivePermissionTraceDenial[];
}

export interface LiveFailureDiagnosticOptions {
	latestObservedTotalCostUsd?: number;
	cleanupTerminationObserved?: boolean;
	cleanupErrors?: unknown[];
	permissionEvidence?: LivePermissionEvidence;
	selectedApiKey?: string;
}

export interface WorkflowFailureEvidenceContext {
	workflowTaskId?: string;
	journal?: WorkflowJournalMetadata;
	journalWarningCount?: number;
}

export interface NativeAgentLifecycleRecord {
	event: "SubagentStart" | "SubagentStop";
	agentId: string;
	agentType: string;
	callbackToolUseId?: string;
}

export interface NativeMonitorRequestRecord {
	agentId?: string;
	agentType?: string;
	toolUseId?: string;
	callbackToolUseId?: string;
	scenario: "stopped" | "continued" | "invalid";
	settlement: "pending" | "signal-aborted" | "cleanup-denied" | "denied-invalid";
}

export interface NativeBackgroundControlRecord {
	targetClass: "all-foreground" | "tool-use";
	targetToolUseId?: string;
	returned: boolean;
	subsequentTaskClasses: string[][];
}

export interface NativeStopAttemptRecord {
	agentId: string;
	targetId?: string;
	candidateKind: "native-task" | "missing-native-control";
	callResolved?: boolean;
	stoppedNotification?: boolean;
	monitorCancelled?: boolean;
	siblingPending?: boolean;
	subagentStopObserved?: boolean;
}

export interface NativeControlTrace {
	lifecycle: NativeAgentLifecycleRecord[];
	monitorRequests: NativeMonitorRequestRecord[];
	backgroundControls: NativeBackgroundControlRecord[];
	stopAttempts: NativeStopAttemptRecord[];
	journalPhaseStarts?: number;
	journalMatchedAgentStarts?: number;
	pendingMonitorRequestCount?: number;
	siblingPendingAfterFirstStop?: boolean;
	continuedInput?: boolean;
	checkpointPreview?: boolean;
	resumed?: boolean;
}

interface PendingMonitorRequest {
	record: NativeMonitorRequestRecord;
	deny(settlement: "signal-aborted" | "cleanup-denied"): void;
	settled: Promise<void>;
}

export class LiveRunRefusal extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LiveRunRefusal";
	}
}

class QueryCreationTripwireError extends Error {
	constructor() {
		super("The offline query-creation tripwire blocked the native SDK query.");
		this.name = "QueryCreationTripwireError";
	}
}

export function parseLiveBudget(argv: string[]): number {
	let budget: number | undefined;

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument !== "--max-budget-usd") {
			throw new LiveRunRefusal(`Unsupported live-test argument: ${argument ?? "missing"}`);
		}
		if (budget !== undefined) {
			throw new LiveRunRefusal("Pass --max-budget-usd exactly once");
		}

		const value = argv[index + 1];
		if (value === undefined || value.startsWith("--")) {
			throw new LiveRunRefusal("--max-budget-usd requires a positive number");
		}
		const parsed = Number(value);
		if (!Number.isFinite(parsed) || parsed <= 0) {
			throw new LiveRunRefusal("--max-budget-usd must be a finite positive number");
		}
		if (parsed > MAX_LIVE_BUDGET_USD) {
			throw new LiveRunRefusal("--max-budget-usd must not exceed $0.10 USD");
		}
		budget = parsed;
		index += 1;
	}

	if (budget === undefined) {
		throw new LiveRunRefusal("Pass an explicit --max-budget-usd <positive-number>");
	}
	return budget;
}

export function validateLiveInvocation(env: NodeJS.ProcessEnv, argv: string[]): number {
	if (env.PHI_LIVE_TEST !== "1") {
		throw new LiveRunRefusal("Refusing live inference: set PHI_LIVE_TEST=1 to opt in");
	}
	const budget = parseLiveBudget(argv);
	if (!env.ANTHROPIC_API_KEY) {
		throw new LiveRunRefusal(
			"This isolated fixture requires ANTHROPIC_API_KEY in the process environment; " +
				"the harness does not read or configure other credentials",
		);
	}
	return budget;
}

export function assertPinnedModelUsage(modelUsage: Record<string, unknown>): void {
	const models = Object.keys(modelUsage);
	assert.ok(models.length > 0, "native SDK result must report per-model usage");
	assert.ok(
		models.every((model) => model === LIVE_MODEL || model.startsWith(`${LIVE_MODEL}-`)),
		`native SDK usage must stay on ${LIVE_MODEL}; received: ${models.join(", ")}`,
	);
}

function isMainModule(): boolean {
	const entry = process.argv[1];
	return entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url;
}

interface HarnessFixture {
	root: string;
	repository: string;
	configRoot: string;
	homeRoot: string;
	tempRoot: string;
	pluginCacheRoot: string;
	settingsHookLog: string;
	toolEditTarget: string;
	workflowPath: string;
	workflowScript: string;
	workflowReleaseFiles: {
		stopped: string;
		continued: string;
	};
}

interface ToolUse {
	id: string;
	name: string;
	input: Record<string, unknown>;
}

interface EventLog {
	messages: SDKMessage[];
	errors: unknown[];
}

export function observedResultTotalCostUsd(message: SDKMessage): number | undefined {
	if (message.type !== "result" || !Number.isFinite(message.total_cost_usd)) return undefined;
	return message.total_cost_usd;
}

export function formatLiveFailureDiagnostic(
	error: unknown,
	options: LiveFailureDiagnosticOptions = {},
): string {
	const key = options.selectedApiKey;
	const cause = describeDiagnosticCause(error, key);
	const spend = Number.isFinite(options.latestObservedTotalCostUsd)
		? `$${options.latestObservedTotalCostUsd?.toFixed(4)} USD`
		: "not observed";
	const termination = options.cleanupTerminationObserved === undefined
		? "not observed"
		: options.cleanupTerminationObserved ? "yes" : "no";
	const cleanupErrors = (options.cleanupErrors ?? [])
		.slice(0, 2)
		.map((cleanupError) => describeDiagnosticCause(cleanupError, key))
		.filter(Boolean);
	const omittedCleanupErrors = (options.cleanupErrors?.length ?? 0) > cleanupErrors.length;
	const cleanupDetail = cleanupErrors.length > 0
		? `; cleanup error: ${cleanupErrors.join("; ")}${omittedCleanupErrors ? "; additional cleanup errors omitted" : ""}`
		: "";
	const safeCleanupDetail = boundedDiagnosticText(cleanupDetail, key, 300);
	const permissionDetail = formatPermissionEvidence(options.permissionEvidence, key);
	const prefix = "Live fixture failure: ";
	const summary = `; latest total_cost_usd=${spend}; cleanup termination observed=${termination}${safeCleanupDetail}; ${permissionDetail}`;
	const causeLimit = Math.max(0, MAX_FAILURE_DIAGNOSTIC_CHARS - prefix.length - summary.length);
	const diagnostic = `${prefix}${boundedDiagnosticText(cause, key, causeLimit)}${summary}`;
	return boundedDiagnosticText(diagnostic, key, MAX_FAILURE_DIAGNOSTIC_CHARS);
}

export function formatWorkflowFailureEvidence(
	messages: readonly unknown[],
	selectedApiKey?: string,
	fixtureName = SKILL_NAME,
	context: WorkflowFailureEvidenceContext = {},
): string {
	const call = findDiagnosticWorkflowUse(messages, fixtureName);
	const matchedResult = call?.id ? findCorrelatedWorkflowResult(messages, call.id) : undefined;
	const resultBlock = matchedResult?.block;
	const resultMessage = matchedResult?.message;
	const toolError = resultBlock?.is_error === true;
	const structuredPresent = resultMessage !== undefined && Object.hasOwn(resultMessage, "tool_use_result");
	const structuredResult = structuredPresent ? asRecord(resultMessage?.tool_use_result) : undefined;
	let latestResult: Record<string, unknown> | undefined;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const record = asRecord(messages[index]);
		if (record?.type === "result") {
			latestResult = record;
			break;
		}
	}
	const modelUsage = asRecord(latestResult?.modelUsage);
	const modelNames = modelUsage ? Object.keys(modelUsage) : [];
	const numTurns = latestResult?.num_turns;
	const fields = ["taskId", "workflowName", "runId", "transcriptDir"].map((field) => {
		if (!structuredResult || !Object.hasOwn(structuredResult, field)) return `${field}=absent`;
		const value = structuredResult[field];
		return `${field}=${value === null ? "null" : Array.isArray(value) ? "array" : typeof value}/present`;
	}).join(",");
	const content = resultBlock?.content;
	const contentKinds = typeof content === "string"
		? ["text"]
		: Array.isArray(content)
			? content.slice(0, MAX_DIAGNOSTIC_LIST_ITEMS).map((value) => {
				const block = asRecord(value);
				return typeof block?.type === "string" ? block.type : diagnosticType(value);
			})
			: [];
	const subtype = latestResult?.subtype;
	const hasStatus = structuredResult !== undefined && Object.hasOwn(structuredResult, "status");
	const status = hasStatus ? structuredResult.status : undefined;
	const parts = [
		`toolUseSeen=${call !== undefined}`,
		`toolName=${call ? boundedDiagnosticText(call.name, selectedApiKey, 32) : "none"}`,
		`fixtureNameMatched=${call?.input.name === fixtureName}`,
		`inputKeys=${formatDiagnosticKeys(call?.input ?? {}, selectedApiKey, true)}`,
		`resultMatched=${resultBlock !== undefined}`,
		`is_error=${typeof resultBlock?.is_error === "boolean" ? resultBlock.is_error : "unknown"}`,
		`contentKinds=${formatDiagnosticLabels(contentKinds, selectedApiKey, Array.isArray(content) ? content.length - contentKinds.length : 0)}`,
		`structuredPresent=${structuredPresent}`,
		`structuredType=${structuredPresent ? diagnosticType(resultMessage?.tool_use_result) : "missing"}`,
		`structuredKeys=${formatDiagnosticKeys(structuredResult ?? {}, selectedApiKey)}`,
		`status=${!hasStatus ? "missing" : typeof status === "string" ? boundedDiagnosticText(status, selectedApiKey, 96) || "empty" : diagnosticType(status)}`,
		fields,
		`latestResultSubtype=${typeof subtype === "string" ? boundedDiagnosticText(subtype, selectedApiKey, 96) || "empty" : subtype === undefined ? "none" : diagnosticType(subtype)}`,
		`latestResultNumTurns=${typeof numTurns === "number" && Number.isFinite(numTurns) ? numTurns : "none"}`,
		`modelUsageModels=${formatDiagnosticLabels(modelNames, selectedApiKey, Math.max(0, modelNames.length - MAX_DIAGNOSTIC_LIST_ITEMS))}`,
		formatWorkflowTaskFailureEvidence(messages, selectedApiKey, context.workflowTaskId, context.journal),
		formatWorkflowJournalEvidence(context.journal, context.journalWarningCount),
	];
	if (toolError) {
		const text = typeof content === "string"
			? content
			: Array.isArray(content)
				? content.map((value) => {
					const block = asRecord(value);
					return block?.type === "text" && typeof block.text === "string" ? block.text : "";
				}).filter(Boolean).join(" ")
				: "";
		const excerpt = text.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
		parts.push(`errorExcerpt=${redactNativeTaskFailureSummary(
			excerpt,
			messages,
			selectedApiKey,
			context.workflowTaskId,
			context.journal,
		) || "none"}`);
	}
	return boundedDiagnosticText(`Workflow failure evidence: ${parts.join("; ")}`, selectedApiKey, MAX_WORKFLOW_FAILURE_EVIDENCE_CHARS);
}

function formatWorkflowTaskFailureEvidence(
	messages: readonly unknown[],
	selectedApiKey: string | undefined,
	workflowTaskId: string | undefined,
	journal: WorkflowJournalMetadata | undefined,
): string {
	const eventCounts = new Map<string, number>(WORKFLOW_TASK_EVENT_TYPES.map((type) => [type, 0]));
	const taskTypes = new Map<string, number>(
		[...SAFE_WORKFLOW_TASK_TYPES, "other", "missing", "invalid"].map((type) => [type, 0] as const),
	);
	const labelShapes = new Map<string, number>();
	const parentShapes = new Map<string, number>();
	const expectedLabelMatches = new Map<string, number>(Object.keys(WORKFLOW_AGENT_LABELS).map((label) => [label, 0]));
	const terminalStatuses = new Map<string, number>([
		...WORKFLOW_TERMINAL_STATUSES.map((status) => [status, 0] as const),
		["other", 0],
	]);
	const starts: Record<string, unknown>[] = [];
	const workflowTaskIds = new Set<string>();
	const taskNotifications: Record<string, unknown>[] = [];
	let workflowTaskStartsWithoutId = 0;

	for (const message of messages) {
		const record = asRecord(message);
		if (record?.type !== "system" || typeof record.subtype !== "string") continue;
		if (eventCounts.has(record.subtype)) {
			eventCounts.set(record.subtype, (eventCounts.get(record.subtype) ?? 0) + 1);
		}
		if (record.subtype === "task_started") {
			starts.push(record);
			const rawTaskType = record.task_type;
			const taskType = typeof rawTaskType !== "string"
				? rawTaskType === undefined ? "missing" : "invalid"
				: SAFE_WORKFLOW_TASK_TYPES.has(rawTaskType) ? rawTaskType : "other";
			taskTypes.set(taskType, (taskTypes.get(taskType) ?? 0) + 1);
			incrementCount(labelShapes, Object.hasOwn(record, "label") ? diagnosticType(record.label) : "missing");
			incrementCount(
				parentShapes,
				Object.hasOwn(record, "parent_task_id") ? diagnosticType(record.parent_task_id) : "missing",
			);

			const labelValues = [record.label, record.description, record.prompt]
				.filter((value): value is string => typeof value === "string");
			for (const [name, label] of Object.entries(WORKFLOW_AGENT_LABELS)) {
				if (labelValues.some((value) => value.includes(label))) {
					expectedLabelMatches.set(name, (expectedLabelMatches.get(name) ?? 0) + 1);
				}
			}
			if (record.task_type === "local_agent" && !asString(record.task_id)) {
				workflowTaskStartsWithoutId += 1;
			} else if (isNativeWorkflowAgentTask(record, workflowTaskId)) {
				const taskId = asString(record.task_id);
				if (taskId) workflowTaskIds.add(taskId);
			}
		}
		if (record.subtype === "task_notification") {
			taskNotifications.push(record);
			const status = typeof record.status === "string" && terminalStatuses.has(record.status)
				? record.status
				: "other";
			terminalStatuses.set(status, (terminalStatuses.get(status) ?? 0) + 1);
		}
	}

	const parentMatches = workflowTaskId === undefined
		? "unavailable"
		: String(starts.filter((record) => record.parent_task_id === workflowTaskId).length);
	const workflowTaskTerminalStatuses = new Map<string, number>([
		...WORKFLOW_TERMINAL_STATUSES.map((status) => [status, 0] as const),
		["other", 0],
	]);
	for (const notification of taskNotifications) {
		if (!workflowTaskIds.has(asString(notification.task_id) ?? "")) continue;
		const status = typeof notification.status === "string" && workflowTaskTerminalStatuses.has(notification.status)
			? notification.status
			: "other";
		workflowTaskTerminalStatuses.set(status, (workflowTaskTerminalStatuses.get(status) ?? 0) + 1);
	}
	const counts = (values: Map<string, number>, includeZero = false) => [...values]
		.filter(([, count]) => includeZero || count > 0)
		.map(([name, count]) => `${name}:${count}`)
		.join(",") || "none";
	const taskFailureSummary = findNativeWorkflowTaskFailureSummary(messages, selectedApiKey, workflowTaskId, journal);
	return [
		`taskEvents=[${counts(eventCounts, true)}]`,
		`taskTypes=[${counts(taskTypes, true)}]`,
		`taskLabelShapes=[${counts(labelShapes)}]`,
		`taskParentShapes=[${counts(parentShapes)}]`,
		`expectedLabels=[${counts(expectedLabelMatches, true)}]`,
		`workflowParentMatches=${parentMatches}`,
		`workflowTaskStarts=${workflowTaskIds.size};withoutId=${workflowTaskStartsWithoutId}`,
		`taskTerminalStatuses=[${counts(terminalStatuses, true)}]`,
		`workflowTaskTerminalStatuses=[${counts(workflowTaskTerminalStatuses, true)}]`,
		`nativeTaskFailureSummary=${taskFailureSummary}`,
	].join("; ");
}

function findNativeWorkflowTaskFailureSummary(
	messages: readonly unknown[],
	selectedApiKey: string | undefined,
	workflowTaskId: string | undefined,
	journal: WorkflowJournalMetadata | undefined,
): string {
	let updateError: string | undefined;
	let notificationSummary: string | undefined;
	for (const message of messages) {
		const record = asRecord(message);
		if (record?.type !== "system") continue;
		if (record.subtype === "task_updated") {
			const patch = asRecord(record.patch);
			if (patch?.status === "failed" && typeof patch.error === "string") updateError ??= patch.error;
		}
		if (record.subtype === "task_notification" && record.status === "failed" && typeof record.summary === "string") {
			notificationSummary ??= record.summary;
		}
	}
	const summary = updateError ?? notificationSummary;
	return summary === undefined
		? "none"
		: redactNativeTaskFailureSummary(summary, messages, selectedApiKey, workflowTaskId, journal) || "empty";
}

function redactNativeTaskFailureSummary(
	value: string,
	messages: readonly unknown[],
	selectedApiKey: string | undefined,
	workflowTaskId: string | undefined,
	journal: WorkflowJournalMetadata | undefined,
): string {
	const sensitiveValues = new Set<string>();
	if (workflowTaskId) sensitiveValues.add(workflowTaskId);
	const identifierFields = [
		"task_id",
		"parent_task_id",
		"run_id",
		"session_id",
		"uuid",
		"tool_use_id",
		"taskId",
		"runId",
	];
	for (const message of messages) {
		const record = asRecord(message);
		if (!record) continue;
		for (const field of identifierFields) {
			const identifier = asString(record[field]);
			if (identifier) sensitiveValues.add(identifier);
		}
		if (record.type === "system" && record.subtype === "task_started") {
			for (const field of ["prompt", "description"]) {
				const prompt = asString(record[field]);
				if (prompt) sensitiveValues.add(prompt);
			}
		}
		const nestedResult = asRecord(record.tool_use_result);
		for (const field of ["taskId", "runId", "transcriptDir"]) {
			const sensitiveValue = asString(nestedResult?.[field]);
			if (sensitiveValue) sensitiveValues.add(sensitiveValue);
		}
		const body = asRecord(record.message);
		if (body && typeof body.content === "string") sensitiveValues.add(body.content);
		if (Array.isArray(body?.content)) {
			for (const blockValue of body.content) {
				const block = asRecord(blockValue);
				for (const field of ["id", "tool_use_id"]) {
					const identifier = asString(block?.[field]);
					if (identifier) sensitiveValues.add(identifier);
				}
				if (record.type === "user" && block?.type === "text" && typeof block.text === "string") {
					sensitiveValues.add(block.text);
				}
			}
		}
	}
	for (const record of journal?.records ?? []) {
		for (const identifier of [record.id, record.key, record.agentId, record.taskId]) {
			if (identifier) sensitiveValues.add(identifier);
		}
	}

	let redacted = value;
	for (const sensitiveValue of [...sensitiveValues].sort((left, right) => right.length - left.length)) {
		if (sensitiveValue.length > 0) redacted = redacted.split(sensitiveValue).join("[redacted]");
	}
	redacted = redacted
		.replace(/\bBearer\s+\S+/gi, "Bearer [redacted credential]")
		.replace(/\b(?:sk-ant-|sk-)[A-Za-z0-9_-]{8,}\b/g, "[redacted credential]")
		.replace(/(?:[A-Za-z]:\\|\\\\)[^\s"'`<>|,:;]*/g, "[redacted path]")
		.replace(/~[\\/][^\s"'`<>|,:;]*/g, "[redacted path]")
		.replace(/\/(?:[^\s"'`<>|,:;]+\/)*[^\s"'`<>|,:;]*/g, "[redacted path]")
		.replace(/\b(?:[\w.-]+\/)+[\w.-]+\b/g, "[redacted path]")
		.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "[redacted id]")
		.replace(/\b((?:task|run|session|agent)[_-]?id)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted id]");
	return boundedDiagnosticText(redacted, selectedApiKey, MAX_WORKFLOW_ERROR_EXCERPT_CHARS);
}

function formatWorkflowJournalEvidence(
	journal: WorkflowJournalMetadata | undefined,
	warningCount: number | undefined,
): string {
	if (!journal) return "workflowJournal=unavailable";
	const typeCounts = new Map<string, number>(["launched", "started", "result", "failed"].map((type) => [type, 0]));
	const expectedPhaseStarted = journal.records.filter(
		(record) => record.type === "started" && record.phase === "Parallel fixture probes",
	).length;
	const expectedLabelCounts = new Map<string, number>(Object.keys(WORKFLOW_AGENT_LABELS).map((label) => [label, 0]));
	for (const record of journal.records) {
		typeCounts.set(record.type, (typeCounts.get(record.type) ?? 0) + 1);
		for (const [name, label] of Object.entries(WORKFLOW_AGENT_LABELS)) {
			if (record.type === "started" && record.label === label) {
				expectedLabelCounts.set(name, (expectedLabelCounts.get(name) ?? 0) + 1);
			}
		}
	}
	const counts = (values: Map<string, number>, includeZero = false) => [...values]
		.filter(([, count]) => includeZero || count > 0)
		.map(([name, count]) => `${name}:${count}`)
		.join(",") || "none";
	return [
		`workflowJournalRecords=${journal.records.length}`,
		`workflowJournalTypes=[${counts(typeCounts, true)}]`,
		`expectedPhaseStarted=${expectedPhaseStarted}`,
		`workflowJournalLabels=[${counts(expectedLabelCounts, true)}]`,
		`workflowJournalWarnings=${warningCount ?? "unknown"}`,
	].join("; ");
}

function incrementCount(counts: Map<string, number>, key: string): void {
	counts.set(key, (counts.get(key) ?? 0) + 1);
}

function findDiagnosticWorkflowUse(
	messages: readonly unknown[],
	fixtureName: string,
): { id?: string; name: string; input: Record<string, unknown> } | undefined {
	let firstWorkflow: { id?: string; name: string; input: Record<string, unknown> } | undefined;
	for (const message of messages) {
		const record = asRecord(message);
		if (record?.type !== "assistant") continue;
		const content = asRecord(record.message)?.content;
		if (!Array.isArray(content)) continue;
		for (const value of content) {
			const block = asRecord(value);
			if (block?.type !== "tool_use" || block.name !== "Workflow") continue;
			const call = {
				id: asString(block.id),
				name: block.name,
				input: asRecord(block.input) ?? {},
			};
			firstWorkflow ??= call;
			if (call.input.name === fixtureName) return call;
		}
	}
	return firstWorkflow;
}

function findCorrelatedWorkflowResult(
	messages: readonly unknown[],
	toolUseId: string,
): { block: Record<string, unknown>; message: Record<string, unknown> } | undefined {
	for (const message of messages) {
		const record = asRecord(message);
		if (!record) continue;
		const content = asRecord(record.message)?.content;
		if (!Array.isArray(content)) continue;
		for (const value of content) {
			const block = asRecord(value);
			if (block?.type === "tool_result" && block.tool_use_id === toolUseId) return { block, message: record };
		}
	}
	return undefined;
}

function formatDiagnosticKeys(
	record: Record<string, unknown>,
	selectedApiKey?: string,
	prioritizeName = false,
): string {
	const keys = Object.keys(record).sort();
	const selected = keys.slice(0, MAX_DIAGNOSTIC_LIST_ITEMS);
	if (prioritizeName && keys.includes("name") && !selected.includes("name")) {
		selected[selected.length - 1] = "name";
		selected.sort();
	}
	const omitted = keys.length - selected.length;
	return formatDiagnosticLabels(selected, selectedApiKey, omitted);
}

function formatDiagnosticLabels(values: string[], selectedApiKey?: string, omitted = 0): string {
	const labels = values.slice(0, MAX_DIAGNOSTIC_LIST_ITEMS)
		.map((value) => boundedDiagnosticText(value, selectedApiKey, MAX_DIAGNOSTIC_LABEL_CHARS));
	return `[${labels.join(",")}${omitted > 0 ? `${labels.length > 0 ? "," : ""}${omitted} more omitted` : ""}]`;
}

function formatPermissionEvidence(evidence: LivePermissionEvidence | undefined, selectedApiKey?: string): string {
	if (evidence === undefined) return "permissionDenials=not-captured";
	const samples = evidence.denials.slice(0, MAX_PERMISSION_DENIALS).map((denial) => {
		const toolName = boundedDiagnosticText(denial.toolName, selectedApiKey, MAX_DIAGNOSTIC_LABEL_CHARS) || "unknown";
		const inputKeys = boundedDiagnosticText(denial.inputKeys, selectedApiKey, 128);
		const reason = boundedDiagnosticText(denial.reason, selectedApiKey, 48) || "unknown";
		return `${toolName} keys=${inputKeys} reason=${reason}`;
	});
	const omitted = Math.max(
		0,
		Math.max(evidence.deniedActionCount, evidence.denials.length) - samples.length,
	);
	if (samples.length === 0) return "permissionDenials=none";
	const summary = `permissionDenials=[${samples.join(";")}${omitted > 0 ? `;${omitted} more omitted` : ""}]`;
	return boundedDiagnosticText(summary, selectedApiKey, MAX_PERMISSION_SUMMARY_CHARS);
}

function diagnosticType(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

function describeDiagnosticCause(error: unknown, selectedApiKey?: string): string {
	const pending: unknown[] = [error];
	const seen = new Set<unknown>();
	const details: string[] = [];
	while (pending.length > 0 && details.length < MAX_CAUSE_DETAILS) {
		const current = pending.shift();
		if (seen.has(current)) continue;
		seen.add(current);
		const name = current instanceof Error ? current.name || "Error" : current === null ? "null" : typeof current;
		const message = current instanceof Error
			? current.message
			: typeof current === "string" ? current : current === null ? "null" : current === undefined ? "undefined" : "(non-Error thrown value)";
		const safeName = boundedDiagnosticText(name, selectedApiKey, 64);
		const safeMessage = boundedDiagnosticText(message, selectedApiKey, MAX_CAUSE_MESSAGE_CHARS);
		details.push(`${safeName}: ${safeMessage || "(empty message)"}`);
		if (current instanceof Error) {
			if (current.cause !== undefined) pending.unshift(current.cause);
			if (current instanceof AggregateError) pending.push(...Array.from(current.errors).slice(0, 2));
		}
	}
	if (pending.length > 0) details.push("additional causes omitted");
	return details.join(" caused by ");
}

function boundedDiagnosticText(value: string, selectedApiKey?: string, limit = MAX_FAILURE_DIAGNOSTIC_CHARS): string {
	const oneLine = formatErrorText(value, selectedApiKey)
		.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (oneLine.length <= limit) return oneLine;
	return `${oneLine.slice(0, Math.max(0, limit - 1))}…`;
}

function reportLiveFailureDiagnostic(error: unknown, options: LiveFailureDiagnosticOptions = {}): void {
	failureDiagnosticEmitted = true;
	console.error(formatLiveFailureDiagnostic(error, {
		...options,
		selectedApiKey: options.selectedApiKey ?? process.env.ANTHROPIC_API_KEY,
	}));
}

export async function writeLiveFailureTrace(
	root: string,
	initialMessages: readonly unknown[],
	resumedMessages: readonly unknown[],
	selectedApiKey?: string,
	permissionDenials?: readonly LivePermissionTraceDenial[],
	nativeControl?: NativeControlTrace,
): Promise<string> {
	const path = join(root, FAILURE_TRACE_FILENAME);
	const serialized = JSON.stringify({
		initialMessages,
		resumedMessages,
		...(permissionDenials !== undefined && permissionDenials.length > 0 ? { permissionDenials } : {}),
		...(nativeControl === undefined ? {} : { nativeControl }),
	});
	if (typeof serialized !== "string") throw new Error("Could not serialize private native SDK failure trace");
	const redacted = selectedApiKey
		? serialized
			.replaceAll(selectedApiKey, "[redacted API key]")
			.replaceAll(JSON.stringify(selectedApiKey).slice(1, -1), "[redacted API key]")
		: serialized;
	if (Buffer.byteLength(redacted, "utf8") > MAX_FAILURE_TRACE_BYTES) {
		throw new Error("Serialized private native SDK failure trace exceeds 2 MiB");
	}
	await writeFile(path, redacted, { encoding: "utf8", flag: "wx", mode: 0o600 });
	return path;
}

export async function cleanupLiveFixture(
	root: string,
	options: {
		scenarioFailed: boolean;
		nativeScenarioStarted: boolean;
		queriesTerminated: boolean;
		expectedTripwireFailure: boolean;
	},
	reportRetainedRoot: (root: string) => void = (retainedRoot) => {
		console.error(`Retained private native acceptance fixture root: ${retainedRoot}`);
	},
): Promise<unknown | undefined> {
	if (!options.queriesTerminated) return undefined;

	if (options.scenarioFailed && options.nativeScenarioStarted && !options.expectedTripwireFailure) {
		try {
			await chmod(root, 0o700);
			reportRetainedRoot(root);
			return undefined;
		} catch (error) {
			return error;
		}
	}

	try {
		await rm(root, { recursive: true, force: true });
		return undefined;
	} catch (error) {
		return error;
	}
}

async function main(): Promise<void> {
	const maxBudgetUsd = validateLiveInvocation(process.env, process.argv.slice(2));
	const deadline = Date.now() + MAX_TOTAL_TIME_MS;
	const [{ parseArgs, buildOptions }, { startSession }, { readWorkflowJournal }, sdk] = await Promise.all([
		import("../src/config.js"),
		import("../src/session.js"),
		import("../src/workflows.js"),
		import("@anthropic-ai/claude-agent-sdk"),
	]);
	const createFixtureSession = (options: Options, callbacks: Parameters<typeof startSession>[1]) =>
		startSession(options, callbacks, (params) => {
			if (process.env.PHI_LIVE_TEST_QUERY_CREATION_TRIPWIRE === "1") {
				throw new QueryCreationTripwireError();
			}
			return sdk.query(params);
		});

	const fixture = await createFixture();
	const environment = createFixtureEnvironment(fixture);
	const sessions: Array<ReturnType<typeof startSession>> = [];
	let reportedSpend: number | undefined;
	let latestObservedTotalCostUsd: number | undefined;
	let sessionId: string | undefined;
	let workflowTaskId: string | undefined;
	let validatedWorkflowJournalRef: WorkflowReference | undefined;
	let workflowJournal: WorkflowJournalMetadata | undefined;
	let workflowJournalWarningCount: number | undefined;

	let scenarioFailed = false;
	let scenarioFailure: unknown;
	const initialEvents: EventLog = { messages: [], errors: [] };
	const resumedEvents: EventLog = { messages: [], errors: [] };
	const permissionEvidence: LivePermissionEvidence = { deniedActionCount: 0, denials: [] };
	const nativeControl = createNativeControlTrace();
	const pendingMonitorGate = new PendingMonitorGate(nativeControl);
	let backgroundSnapshotStartIndex: number | undefined;
	let backgroundControlRecord: NativeBackgroundControlRecord | undefined;
	try {
		const firstBudgetUsd = maxBudgetUsd * INITIAL_BUDGET_SHARE;
		const initialLaunch = parseArgs([
			"--cwd", fixture.repository,
			"--model", LIVE_MODEL,
			"--permission-mode", "acceptEdits",
			"--max-budget-usd", String(firstBudgetUsd),
		], environment);
		const firstOptions = buildOptions(initialLaunch, fixtureCallbacks(fixture, permissionEvidence), environment);
		firstOptions.hooks = mergeHookMatchers(firstOptions.hooks, createNativeControlHooks(nativeControl, pendingMonitorGate));
		assert.equal(firstOptions.model, LIVE_MODEL);
		firstOptions.maxTurns = MAX_MAIN_TURNS;
		firstOptions.effort = "low";
		firstOptions.disallowedTools = ["WebFetch", "WebSearch"];
		firstOptions.mcpServers = {};
		firstOptions.strictMcpConfig = true;
		firstOptions.env = {
			...firstOptions.env,
			CLAUDE_CODE_EFFORT_LEVEL: "low",
			CLAUDE_CODE_MAX_OUTPUT_TOKENS: MAX_OUTPUT_TOKENS,
			CLAUDE_CODE_MAX_RETRIES: "0",
			CLAUDE_CODE_MAX_TURNS: MAX_WORKFLOW_AGENT_TURNS,
			CLAUDE_CODE_SUBAGENT_MODEL: LIVE_MODEL,
			CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1",
			CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS: "2",
		};

		sessionId = firstOptions.sessionId;
		assert.ok(sessionId, "new native query must have an SDK session id");
		const events = initialEvents;
		const session = createFixtureSession(firstOptions, {
			onMessage(message) {
				events.messages.push(message);
				const totalCostUsd = observedResultTotalCostUsd(message);
				if (totalCostUsd !== undefined) latestObservedTotalCostUsd = totalCostUsd;
			},
			onError(error) {
				events.errors.push(error);
			},
		});
		sessions.push(session);

		const initialized = await withDeadline(session.ready, deadline, "initial SDK initialization", session);
		assert.equal(initialized.account.apiProvider, "firstParty", "fixture must use the first-party API route");
		assert.equal(initialized.account.apiKeySource, "ANTHROPIC_API_KEY", "fixture must use its environment key source");
		assert.ok(
			JSON.stringify(initialized.commands).includes(SKILL_NAME),
			"native initialization must discover the project acceptance skill",
		);

		const checkpointUserMessageUuid = randomUUID();
		session.send(userMessage(
			buildInitialPrompt(fixture.workflowPath, checkpointUserMessageUuid),
			checkpointUserMessageUuid,
		));

		const mainBash = await waitFor(
			() => findToolUse(events.messages, "Bash", (input) => input.command === MAIN_SLEEP_COMMAND),
			events,
			deadline,
			"bounded foreground Bash tool call",
			session,
		);
		const mainBashTask = await waitFor(
			() => findTaskStarted(events.messages, (task) => task.tool_use_id === mainBash.id),
			events,
			deadline,
			"native foreground task registration",
			session,
		);
		const mainBashTaskId = asString(mainBashTask.task_id);
		assert.ok(mainBashTaskId, "foreground Bash task must have a native task id");
		assert.notEqual(mainBashTask.is_backgrounded, true, "sleep command must start in the foreground");
		assert.equal(
			await withDeadline(session.query.backgroundTasks(mainBash.id), deadline, "native task backgrounding", session),
			true,
			"native backgroundTasks must background the selected command",
		);
		await waitFor(
			() => hasBackgroundTask(events.messages, mainBashTaskId),
			events,
			deadline,
			"background task membership",
			session,
		);
		const workflowCall = await waitFor(
			() => findToolUse(events.messages, "Workflow", (input) => input.name === SKILL_NAME),
			events,
			deadline,
			"native Workflow tool call",
			session,
		);
		assert.ok(isNamedFixtureWorkflow(workflowCall.input, SKILL_NAME));

		const workflowOutput = await waitFor(
			() => findWorkflowOutput(events.messages, workflowCall.id),
			events,
			deadline,
			"native Workflow launch result",
			session,
		);
		assert.equal(workflowOutput.status, "async_launched");
		assert.equal(workflowOutput.workflowName, SKILL_NAME);
		assert.ok(workflowOutput.taskId, "WorkflowOutput.taskId is required for the workflow task");
		assert.ok(workflowOutput.runId, "WorkflowOutput.runId is required for local workflow resume metadata");
		assert.ok(workflowOutput.transcriptDir, "WorkflowOutput.transcriptDir is required for native metadata inspection");
		const nativeWorkflowTaskId = workflowOutput.taskId;
		workflowTaskId = nativeWorkflowTaskId;

		const journalRef: WorkflowReference = {
			sessionId,
			output: workflowOutput,
			configRoot: fixture.configRoot,
		};
		const journal = await waitForJournal(
			readWorkflowJournal,
			journalRef,
			events,
			Math.min(deadline, Date.now() + STEP_TIMEOUT_MS),
			session,
			nativeWorkflowTaskId,
		);
		validatedWorkflowJournalRef = journalRef;
		workflowJournal = journal;
		const startedAgentRecords = journal.records.filter(
			(record) => record.type === "started" && record.phase === "Parallel fixture probes",
		);
		assert.equal(new Set(startedAgentRecords.map((record) => record.agentId)).size, 2);
		assert.ok(startedAgentRecords.every((record) => record.agentId), "phase records must expose native agent ids");
		nativeControl.journalPhaseStarts = startedAgentRecords.length;
		const journalAgentIds = startedAgentRecords.map((record) => record.agentId!);
		const journalAgentIdSet = new Set(journalAgentIds);
		const pendingAgents = await waitFor(() => {
			const workflowStatus = workflowTaskTerminalStatus(events.messages, nativeWorkflowTaskId);
			if (workflowStatus !== undefined) {
				throw new Error("Workflow completed before both native agents reached the Monitor hook boundary.");
			}
			if (nativeControl.monitorRequests.some((record) => record.settlement === "denied-invalid")) {
				throw new Error("A Monitor hook request lacked the exact fixture identity required for controlled cancellation.");
			}
			const lifecycleStops = nativeControl.lifecycle.filter((record) =>
				record.event === "SubagentStop" && journalAgentIdSet.has(record.agentId),
			);
			if (lifecycleStops.length > 0) {
				throw new Error("A Workflow agent completed before both real Monitor requests were held.");
			}

			const lifecycleStarts = nativeControl.lifecycle.filter((record) =>
				record.event === "SubagentStart" && journalAgentIdSet.has(record.agentId),
			);
			const lifecycleStartIds = new Set(lifecycleStarts.map((record) => record.agentId));
			nativeControl.journalMatchedAgentStarts = lifecycleStartIds.size;
			if (lifecycleStarts.length > 2 || lifecycleStartIds.size !== lifecycleStarts.length) {
				throw new Error("The Workflow produced duplicate native SubagentStart records for its two journal agents.");
			}

			const requests = nativeControl.monitorRequests.filter((record) => record.scenario !== "invalid");
			if (requests.some((record) => record.agentId !== undefined && !journalAgentIdSet.has(record.agentId))) {
				throw new Error("A held Monitor request did not match either native Workflow journal agent.");
			}
			for (const request of requests) {
				const lifecycleStart = lifecycleStarts.find((record) => record.agentId === request.agentId);
				if (lifecycleStart && lifecycleStart.agentType !== request.agentType) {
					throw new Error("A Monitor request agent type did not match its native SubagentStart identity.");
				}
			}
			if (requests.length >= 2 && (
				requests.length !== 2 ||
				requests.filter((record) => record.scenario === "stopped").length !== 1 ||
				requests.filter((record) => record.scenario === "continued").length !== 1 ||
				new Set(requests.map((record) => record.agentId)).size !== 2
			)) {
				throw new Error("The two held Monitor requests did not map one-to-one to the exact fixture agents.");
			}
			if (requests.length === 2 && lifecycleStartIds.size !== 2) {
				throw new Error("Two real Monitor requests arrived without two matching native SubagentStart identities.");
			}

			const stopped = requests.filter((record) =>
				record.scenario === "stopped" && record.settlement === "pending" &&
				record.agentId !== undefined && record.toolUseId !== undefined &&
				pendingMonitorGate.isPending(record.toolUseId),
			);
			const continued = requests.filter((record) =>
				record.scenario === "continued" && record.settlement === "pending" &&
				record.agentId !== undefined && record.toolUseId !== undefined &&
				pendingMonitorGate.isPending(record.toolUseId),
			);
			if (
				lifecycleStartIds.size === 2 && lifecycleStarts.length === 2 &&
				stopped.length === 1 && continued.length === 1 &&
				stopped[0]?.agentId !== continued[0]?.agentId &&
				[stopped[0]?.agentId, continued[0]?.agentId].every((agentId) =>
					agentId !== undefined && lifecycleStartIds.has(agentId),
				)
			) {
				return { stopped: stopped[0]!, continued: continued[0]! };
			}
			return undefined;
		}, events, Math.min(deadline, Date.now() + STEP_TIMEOUT_MS), "two native agents held at exact Monitor requests", session);
		nativeControl.pendingMonitorRequestCount = 2;

		const backgroundControlStartIndex = events.messages.length;
		backgroundSnapshotStartIndex = backgroundControlStartIndex;
		const backgroundedForegroundTasks = await withDeadline(
			session.query.backgroundTasks(),
			deadline,
			"post-phase foreground-task background control observation",
			session,
		);
		backgroundControlRecord = {
			targetClass: "all-foreground",
			returned: backgroundedForegroundTasks,
			subsequentTaskClasses: backgroundTaskClassesAfter(events.messages, backgroundControlStartIndex),
		};
		nativeControl.backgroundControls.push(backgroundControlRecord);

		const stopHeldAgent = async (
			selected: NativeMonitorRequestRecord,
			sibling: NativeMonitorRequestRecord,
			label: string,
			requireSiblingActive: boolean,
		): Promise<void> => {
			assert.ok(selected.agentId && selected.toolUseId && sibling.agentId && sibling.toolUseId);
			const selectedAgentId = selected.agentId!;
			const selectedToolUseId = selected.toolUseId!;
			const siblingAgentId = sibling.agentId!;
			const siblingToolUseId = sibling.toolUseId!;
			assert.ok(pendingMonitorGate.isPending(selectedToolUseId), "selected agent Monitor request must still be pending before stop");
			if (requireSiblingActive) {
				assert.ok(pendingMonitorGate.isPending(siblingToolUseId), "sibling Monitor request must still be pending before first stop");
			}
			const agentStart = nativeControl.lifecycle.find((record) =>
				record.event === "SubagentStart" && record.agentId === selectedAgentId,
			);
			const matchingNativeTaskId = agentStart === undefined
				? undefined
				: findMatchingNativeAgentTaskID(events.messages, nativeWorkflowTaskId, agentStart);
			const candidateId = matchingNativeTaskId;
			const attempt: NativeStopAttemptRecord = {
				agentId: selectedAgentId,
				...(candidateId === undefined ? {} : { targetId: candidateId }),
				candidateKind: candidateId === undefined ? "missing-native-control" : "native-task",
			};
			nativeControl.stopAttempts.push(attempt);
			const stopDeadline = Math.min(deadline, Date.now() + NATIVE_STOP_OBSERVATION_MS);
			try {
				const stoppedTaskId = await stopNativeAgentTask(candidateId, (nativeTaskId) =>
					withDeadline(session.query.stopTask(nativeTaskId), stopDeadline, label, session),
				);
				attempt.callResolved = true;
				await waitFor(() => {
					if (requireSiblingActive && workflowTaskTerminalStatus(events.messages, nativeWorkflowTaskId) !== undefined) {
						throw new Error("Workflow completed before the sibling's pending Monitor request was confirmed active.");
					}
					if (requireSiblingActive && (
						hasTerminalTaskNotification(events.messages, siblingAgentId) ||
						nativeControl.lifecycle.some((record) =>
							record.event === "SubagentStop" && record.agentId === siblingAgentId,
						)
					)) {
						throw new Error("The sibling agent completed before the selected stop was observed.");
					}
					const stoppedNotification = hasTaskNotification(events.messages, stoppedTaskId, "stopped");
					const monitorCancelled = selected.settlement === "signal-aborted";
					const siblingPending = !requireSiblingActive || pendingMonitorGate.isPending(siblingToolUseId);
					const siblingStopped = hasTerminalTaskNotification(events.messages, siblingAgentId) ||
						nativeControl.lifecycle.some((record) =>
							record.event === "SubagentStop" && record.agentId === siblingAgentId,
						);
					const workflowStillActive = !requireSiblingActive ||
						workflowTaskTerminalStatus(events.messages, nativeWorkflowTaskId) === undefined;
					if (stoppedNotification && monitorCancelled && siblingPending && workflowStillActive &&
						(!requireSiblingActive || !siblingStopped)) return true;
					return undefined;
				}, events, stopDeadline, label, session);
				attempt.stoppedNotification = hasTaskNotification(events.messages, stoppedTaskId, "stopped");
				attempt.monitorCancelled = selected.settlement === "signal-aborted";
				attempt.siblingPending = pendingMonitorGate.isPending(siblingToolUseId);
				attempt.subagentStopObserved = nativeControl.lifecycle.some((record) =>
					record.event === "SubagentStop" && record.agentId === selectedAgentId,
				);
			} catch (error) {
				if (candidateId === undefined) throw error;
				attempt.stoppedNotification = hasTaskNotification(events.messages, candidateId, "stopped");
				attempt.monitorCancelled = selected.settlement === "signal-aborted";
				attempt.siblingPending = pendingMonitorGate.isPending(siblingToolUseId);
				attempt.subagentStopObserved = nativeControl.lifecycle.some((record) =>
					record.event === "SubagentStop" && record.agentId === selectedAgentId,
				);
				throw new Error("Native agent stop candidate did not produce an exact stopped notification and isolated Monitor cancellation.", { cause: error });
			}
		};

		await stopHeldAgent(pendingAgents.stopped, pendingAgents.continued, "first isolated Workflow agent stop", true);
		nativeControl.siblingPendingAfterFirstStop = pendingMonitorGate.isPending(pendingAgents.continued.toolUseId!);
		assert.ok(
			nativeControl.siblingPendingAfterFirstStop,
			"stopping the selected Workflow agent must leave its sibling's real Monitor request pending",
		);

		const firstTurn = await waitFor(
			() => resultForMessage(events.messages, checkpointUserMessageUuid),
			events,
			deadline,
			"first main turn result",
			session,
		);
		reportedSpend = firstTurn.total_cost_usd;
		assert.equal(firstTurn.session_id, sessionId);
		assert.equal(firstTurn.is_error, false, "initial native session turn must succeed");
		assertPinnedModelUsage(firstTurn.modelUsage);
		assert.equal(findToolUses(events.messages, "Edit").length, 1, "the fixture must produce exactly one native Edit call");
		assert.ok(findToolUse(events.messages, "Skill", (input) => input.skill === SKILL_NAME), "native Skill tool must run");
		assert.ok(hasSkillMarker(events.messages, "phi-live-skill-ok"), "fixture skill marker must appear in native assistant output");
		assert.ok(
			findToolUse(events.messages, "Workflow", (input) => input.name === SKILL_NAME),
			"native Workflow tool must run",
		);

		const editedText = await readFile(fixture.toolEditTarget, "utf8");
		assert.equal(editedText, "after\n", "native Edit tool must change only the synthetic target");
		const hookLog = await readFile(fixture.settingsHookLog, "utf8");
		assert.equal(hookLog.trim(), "native-settings-and-hook-ok", "project settings env and hook must both be active");

		const rewindPreview = await withDeadline(
			session.query.rewindFiles(checkpointUserMessageUuid, { dryRun: true }),
			deadline,
			"native checkpoint dry run",
			session,
		);
		assert.equal(rewindPreview.canRewind, true, "native checkpoint must support a dry-run preview");
		const checkpointPaths = rewindPreview.filesChanged ?? [];
		assert.ok(
			checkpointPaths.some((path) => resolve(fixture.repository, path) === fixture.toolEditTarget),
			"checkpoint preview must identify the native Edit target",
		);
		assert.ok(
			checkpointPaths.every((path) => resolve(fixture.repository, path) === fixture.toolEditTarget),
			"checkpoint preview must stay within the single synthetic Edit target",
		);
		assert.equal(await readFile(fixture.toolEditTarget, "utf8"), "after\n", "dry-run checkpoint preview must not restore files");
		nativeControl.checkpointPreview = true;
		assert.ok(
			pendingMonitorGate.isPending(pendingAgents.continued.toolUseId!),
			"the sibling's real Monitor request must remain pending before continued main input",
		);
		const continuationPromptId = randomUUID();
		session.send(userMessage("The first turn is complete. Reply only `continuation accepted`; do not use tools.", continuationPromptId));

		const continuedTurn = await waitFor(
			() => resultForMessage(events.messages, continuationPromptId),
			events,
			deadline,
			"continued main input while a Workflow agent is active",
			session,
		);
		reportedSpend = continuedTurn.total_cost_usd;
		assert.equal(continuedTurn.session_id, sessionId);
		assert.equal(continuedTurn.is_error, false);
		assertPinnedModelUsage(continuedTurn.modelUsage);
		assert.ok(
			pendingMonitorGate.isPending(pendingAgents.continued.toolUseId!),
			"the sibling's real Monitor request must remain pending when continued main input completes",
		);
		nativeControl.continuedInput = true;
		const remainingBudgetUsd = Math.min(
			maxBudgetUsd - firstBudgetUsd,
			maxBudgetUsd - reportedSpend,
		);
		assert.ok(remainingBudgetUsd > 0, "reported initial spend and fixed allocation leave room inside the total budget for resume");

		await waitFor(
			() => hasTaskNotification(events.messages, mainBashTaskId, "completed"),
			events,
			deadline,
			"background Bash completion",
			session,
		);
		await stopHeldAgent(pendingAgents.continued, pendingAgents.stopped, "second isolated Workflow agent stop", false);
		await Promise.all(Object.values(fixture.workflowReleaseFiles).map((releaseFile) =>
			writeFile(releaseFile, "release\n", { flag: "wx", mode: 0o600 }),
		));

		assertCleanClose(await closeSession(session, TERMINATION_TIMEOUT_MS, "initial session close"), "initial session close");

		const resumeOptions = buildOptions(
			parseArgs([
				"--cwd", fixture.repository,
				"--resume", sessionId,
				"--model", LIVE_MODEL,
				"--permission-mode", "acceptEdits",
				"--max-budget-usd", String(remainingBudgetUsd),
			], environment),
			fixtureCallbacks(fixture, permissionEvidence),
			environment,
		);
		assert.equal(resumeOptions.model, LIVE_MODEL);
		resumeOptions.maxTurns = 1;
		resumeOptions.effort = "low";
		resumeOptions.disallowedTools = ["WebFetch", "WebSearch"];
		resumeOptions.mcpServers = {};
		resumeOptions.strictMcpConfig = true;
		resumeOptions.env = {
			...resumeOptions.env,
			CLAUDE_CODE_EFFORT_LEVEL: "low",
			CLAUDE_CODE_MAX_OUTPUT_TOKENS: MAX_OUTPUT_TOKENS,
			CLAUDE_CODE_MAX_RETRIES: "0",
			CLAUDE_CODE_MAX_TURNS: MAX_WORKFLOW_AGENT_TURNS,
			CLAUDE_CODE_SUBAGENT_MODEL: LIVE_MODEL,
			CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1",
			CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS: "2",
		};

		const resumed = createFixtureSession(resumeOptions, {
			onMessage(message) {
				resumedEvents.messages.push(message);
				const totalCostUsd = observedResultTotalCostUsd(message);
				if (totalCostUsd !== undefined) latestObservedTotalCostUsd = totalCostUsd;
			},
			onError(error) {
				resumedEvents.errors.push(error);
			},
		});
		sessions.push(resumed);
		const resumedInitialization = await withDeadline(resumed.ready, deadline, "resumed SDK initialization", resumed);
		assert.equal(resumedInitialization.account.apiProvider, "firstParty");
		assert.equal(resumedInitialization.account.apiKeySource, "ANTHROPIC_API_KEY");

		const resumePromptId = randomUUID();
		resumed.send(userMessage(
			`What exact resume marker appeared in the earlier conversation? Reply with only that marker.`,
			resumePromptId,
		));
		const resumedResult = await waitFor(
			() => resultForMessage(resumedEvents.messages, resumePromptId),
			resumedEvents,
			deadline,
			"resumed session result",
			resumed,
		);
		assert.equal(resumedResult.session_id, sessionId, "native session resume must retain the original session id");
		reportedSpend = resumedResult.total_cost_usd;
		assert.equal(resumedResult.is_error, false);
		assertPinnedModelUsage(resumedResult.modelUsage);
		if (resumedResult.subtype !== "success") {
			throw new Error(`Native session resume ended with ${resumedResult.subtype}`);
		}
		const expectedResumeMarker = extractResumeMarker(events.messages, checkpointUserMessageUuid);
		assert.ok(resumedResult.result.includes(expectedResumeMarker), "resumed conversation must retain its earlier user context");
		assert.ok(reportedSpend <= maxBudgetUsd, "reported session spend must remain within the requested budget");
		nativeControl.resumed = true;
		console.log(`Native SDK acceptance scenario completed; ${formatNativeControlSummary(nativeControl)}`);
	} catch (error) {
		scenarioFailed = true;
		scenarioFailure = error;
		if (validatedWorkflowJournalRef) {
			try {
				const page = await readWorkflowJournal(validatedWorkflowJournalRef);
				workflowJournal = page.metadata;
				workflowJournalWarningCount = page.warnings.length;
			} catch {
				workflowJournalWarningCount = undefined;
			}
		}
		console.error(formatWorkflowFailureEvidence(
			initialEvents.messages,
			process.env.ANTHROPIC_API_KEY,
			SKILL_NAME,
			{ workflowTaskId, journal: workflowJournal, journalWarningCount: workflowJournalWarningCount },
		));
		console.error(`Native control evidence: ${formatNativeControlSummary(nativeControl)}`);
		throw error;
	} finally {
		await pendingMonitorGate.denyPending();
		const closeOutcomes = await Promise.all(sessions.reverse().map(async (session) => {
			try {
				return await closeSession(session, TERMINATION_TIMEOUT_MS, "final session cleanup");
			} catch (error) {
				return { terminated: false, error };
			}
		}));
		const cleanupFailure = closeOutcomes.find((outcome) => outcome.error !== undefined || !outcome.terminated);
		if (cleanupFailure) {
			process.exitCode = process.exitCode || 1;
		}
		const allQueriesTerminated = closeOutcomes.every((outcome) => outcome.terminated);
		if (!allQueriesTerminated) process.exitCode = process.exitCode || 1;
		if (backgroundControlRecord && backgroundSnapshotStartIndex !== undefined) {
			backgroundControlRecord.subsequentTaskClasses = backgroundTaskClassesAfter(
				initialEvents.messages,
				backgroundSnapshotStartIndex,
			);
		}
		let failureTraceError: unknown;
		if (scenarioFailed && sessions.length > 0 && !(scenarioFailure instanceof QueryCreationTripwireError)) {
			try {
				const tracePath = await writeLiveFailureTrace(
					fixture.root,
					initialEvents.messages,
					resumedEvents.messages,
					process.env.ANTHROPIC_API_KEY,
					permissionEvidence.traceDenials,
					nativeControl,
				);
				console.error(`Private native SDK failure trace: ${tracePath}`);
			} catch (error) {
				failureTraceError = new Error("Could not write private native SDK failure trace", { cause: error });
			}
		}
		const fixtureCleanupError = await cleanupLiveFixture(fixture.root, {
			scenarioFailed,
			nativeScenarioStarted: sessions.length > 0,
			queriesTerminated: allQueriesTerminated,
			expectedTripwireFailure: scenarioFailure instanceof QueryCreationTripwireError,
		});
		if (fixtureCleanupError !== undefined) process.exitCode = process.exitCode || 1;

		const cleanupErrors: unknown[] = failureTraceError === undefined ? [] : [failureTraceError];
		cleanupErrors.push(...closeOutcomes
			.map((outcome) => outcome.error)
			.filter((error) => error !== undefined));
		if (fixtureCleanupError !== undefined) cleanupErrors.push(fixtureCleanupError);
		const cleanupDidFail = cleanupFailure !== undefined || fixtureCleanupError !== undefined;
		if (scenarioFailed || cleanupDidFail) {
			const diagnosticFailure = scenarioFailed
				? scenarioFailure
				: cleanupErrors[0] ?? new Error("Query termination was not observed");
			reportLiveFailureDiagnostic(diagnosticFailure, {
				latestObservedTotalCostUsd,
				cleanupTerminationObserved: closeOutcomes.length === 0 ? undefined : allQueriesTerminated,
				cleanupErrors: scenarioFailed ? cleanupErrors : cleanupErrors.slice(1),
				permissionEvidence,
				selectedApiKey: process.env.ANTHROPIC_API_KEY,
			});
		}
	}
}

export class PendingMonitorGate {
	private readonly pending = new Map<string, PendingMonitorRequest>();
	private closed = false;

	constructor(private readonly trace: NativeControlTrace) {}

	hold(
		input: PreToolUseHookInput,
		callbackToolUseId: string | undefined,
		signal: AbortSignal,
	): Promise<HookJSONOutput> {
		const toolInput = asRecord(input.tool_input);
		const scenario = fixtureMonitorScenario(toolInput);
		const agentId = asString(input.agent_id);
		const agentType = asString(input.agent_type);
		const toolUseId = asString(input.tool_use_id);
		const normalizedCallbackToolUseId = asString(callbackToolUseId);
		const valid = scenario !== undefined && agentId !== undefined && agentType !== undefined &&
			toolUseId !== undefined &&
			(normalizedCallbackToolUseId === undefined || normalizedCallbackToolUseId === toolUseId) &&
			!this.trace.monitorRequests.some((record) => record.agentId === agentId);
		const record: NativeMonitorRequestRecord = {
			...(agentId === undefined ? {} : { agentId }),
			...(agentType === undefined ? {} : { agentType }),
			...(toolUseId === undefined ? {} : { toolUseId }),
			...(normalizedCallbackToolUseId === undefined ? {} : { callbackToolUseId: normalizedCallbackToolUseId }),
			scenario: scenario ?? "invalid",
			settlement: valid ? "pending" : "denied-invalid",
		};
		this.trace.monitorRequests.push(record);
		if (!valid || toolUseId === undefined) return Promise.resolve(denyMonitorHook("fixture-monitor-identity-invalid"));
		if (this.closed) {
			record.settlement = "cleanup-denied";
			return Promise.resolve(denyMonitorHook("fixture-monitor-gate-closed"));
		}

		return new Promise<HookJSONOutput>((resolve) => {
			let settled = false;
			let resolveSettled!: () => void;
			const settledPromise = new Promise<void>((settle) => { resolveSettled = settle; });
			const settle = (settlement: "signal-aborted" | "cleanup-denied") => {
				if (settled) return;
				settled = true;
				signal.removeEventListener("abort", onAbort);
				record.settlement = settlement;
				this.pending.delete(toolUseId);
				resolve(denyMonitorHook(settlement === "signal-aborted"
					? "fixture-monitor-agent-stopped"
					: "fixture-monitor-gate-closed"));
				resolveSettled();
			};
			const onAbort = () => settle("signal-aborted");
			this.pending.set(toolUseId, { record, deny: settle, settled: settledPromise });
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) onAbort();
			else if (this.closed) settle("cleanup-denied");
		});
	}

	isPending(toolUseId: string): boolean {
		return this.pending.has(toolUseId);
	}

	async denyPending(): Promise<void> {
		this.closed = true;
		const pending = [...this.pending.values()];
		for (const request of pending) request.deny("cleanup-denied");
		await Promise.all(pending.map((request) => request.settled));
	}
}

function fixtureMonitorScenario(input: Record<string, unknown> | undefined): "stopped" | "continued" | undefined {
	if (input === undefined || !isAllowedFixtureMonitor(input)) return undefined;
	for (const [scenario, expected] of Object.entries(FIXED_WORKFLOW_MONITOR_INPUTS) as Array<
		["stopped" | "continued", FixtureMonitorInput]
	>) {
		if (input.command === expected.command && input.description === expected.description && input.timeout_ms === expected.timeout_ms) {
			return scenario;
		}
	}
	return undefined;
}

function denyMonitorHook(reason: string): HookJSONOutput {
	return {
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "deny",
			permissionDecisionReason: reason,
		},
	};
}

function createNativeControlHooks(trace: NativeControlTrace, monitorGate: PendingMonitorGate): NonNullable<Options["hooks"]> {
	const lifecycleHook: HookCallback = async (input, callbackToolUseId) => {
		if (input.hook_event_name === "SubagentStart" || input.hook_event_name === "SubagentStop") {
			trace.lifecycle.push({
				event: input.hook_event_name,
				agentId: input.agent_id,
				agentType: input.agent_type,
				...(callbackToolUseId === undefined ? {} : { callbackToolUseId }),
			});
		}
		return {};
	};
	const monitorHook: HookCallback = async (input, callbackToolUseId, options) => {
		if (input.hook_event_name !== "PreToolUse" || input.tool_name !== "Monitor") return {};
		return monitorGate.hold(input, callbackToolUseId, options.signal);
	};
	return {
		SubagentStart: [{ hooks: [lifecycleHook] }],
		SubagentStop: [{ hooks: [lifecycleHook] }],
		PreToolUse: [{
			matcher: "Monitor",
			timeout: Math.ceil(MAX_TOTAL_TIME_MS / 1_000),
			hooks: [monitorHook],
		}],
	};
}

export function fixtureCallbacks(
	fixture: Pick<HarnessFixture, "repository" | "toolEditTarget" | "workflowScript">,
	permissionEvidence: LivePermissionEvidence,
	selectedApiKey = process.env.ANTHROPIC_API_KEY,
): Pick<Options, "canUseTool" | "onElicitation" | "hooks"> {
	return {
		canUseTool: async (toolName, input, options) => {
			const rejectionReason = fixturePermissionRejectionReason(toolName, input, fixture);
			if (rejectionReason === undefined) return { behavior: "allow", updatedInput: input };
			permissionEvidence.deniedActionCount += 1;
			if (permissionEvidence.denials.length < MAX_PERMISSION_DENIALS) {
				permissionEvidence.denials.push({
					toolName: boundedDiagnosticText(toolName, selectedApiKey, MAX_DIAGNOSTIC_LABEL_CHARS) || "unknown",
					inputKeys: formatPermissionInputKeys(input, selectedApiKey),
					reason: rejectionReason,
				});
			}
			const traceDenials = permissionEvidence.traceDenials ??= [];
			if (traceDenials.length < MAX_PERMISSION_DENIALS) {
				traceDenials.push({
					toolName,
					input: structuredClone(input),
					reason: rejectionReason,
					...(options?.toolUseID === undefined ? {} : { toolUseID: options.toolUseID }),
				});
			}
			return { behavior: "deny", message: "The live fixture denied an unlisted tool action." };
		},
		onElicitation: async () => ({ action: "decline" }),
		hooks: {},
	};
}

function fixturePermissionRejectionReason(
	toolName: string,
	input: Record<string, unknown>,
	fixture: Pick<HarnessFixture, "repository" | "toolEditTarget" | "workflowScript">,
): string | undefined {
	if (toolName === "Read") {
		return isFixturePath(fixture.repository, input.file_path) ? undefined : "read-path-outside-fixture";
	}
	if (toolName === "Skill") return input.skill === SKILL_NAME ? undefined : "skill-name-not-fixture";
	if (toolName === "Edit") {
		return isExactFixtureTarget(fixture.repository, fixture.toolEditTarget, input.file_path)
			? undefined
			: "edit-target-not-fixture-target";
	}
	if (toolName === "Workflow") {
		if (input.name !== SKILL_NAME) return "workflow-name-not-fixture";
		if (["scriptPath", "resumeFromRunId"].some((key) => Object.hasOwn(input, key))) {
			return "workflow-execution-override";
		}
		return isAllowedFixtureWorkflow(input, SKILL_NAME, fixture.workflowScript)
			? undefined
			: "workflow-input-not-allowlisted";
	}
	if (toolName === "Monitor") {
		return isAllowedFixtureMonitor(input) ? undefined : "monitor-input-not-allowlisted";
	}
	if (toolName === "Bash") {
		return input.command === MAIN_SLEEP_COMMAND || input.command === AGENT_SLEEP_COMMAND
			? undefined
			: "bash-command-not-allowlisted";
	}
	return "tool-not-allowlisted";
}

function isAllowedFixtureMonitor(input: Record<string, unknown>): boolean {
	const allowedKeys = ["command", "description", "timeout_ms"] as const;
	const keys = Reflect.ownKeys(input);
	if (keys.length !== allowedKeys.length || keys.some((key) =>
		typeof key !== "string" || !allowedKeys.includes(key as (typeof allowedKeys)[number]),
	)) {
		return false;
	}
	return Object.values(FIXED_WORKFLOW_MONITOR_INPUTS).some((expected) =>
		input.command === expected.command &&
		input.description === expected.description &&
		input.timeout_ms === expected.timeout_ms,
	);
}

function formatPermissionInputKeys(input: Record<string, unknown>, selectedApiKey?: string): string {
	const keys = Object.keys(input).sort();
	const selected = keys.slice(0, MAX_PERMISSION_INPUT_KEYS)
		.map((key) => boundedDiagnosticText(key, selectedApiKey, MAX_PERMISSION_INPUT_KEY_CHARS));
	const omitted = keys.length - selected.length;
	return `[${selected.join(",")}${omitted > 0 ? `,${omitted} more omitted` : ""}]`;
}

export function isExactFixtureTarget(repository: string, target: string, value: unknown): boolean {
	return typeof value === "string" && resolve(repository, value) === resolve(target);
}

export function isNamedFixtureWorkflow(input: Record<string, unknown>, workflowName: string): boolean {
	const keys = Object.keys(input);
	return input.name === workflowName && keys.length === 1 && keys[0] === "name";
}

export function isAllowedFixtureWorkflow(
	input: Record<string, unknown>,
	workflowName: string,
	fixtureScript: string,
): boolean {
	const keys = Reflect.ownKeys(input);
	if (!Object.hasOwn(input, "name") || input.name !== workflowName) return false;
	if (keys.some((key) => key !== "name" && key !== "script")) return false;
	if (!Object.hasOwn(input, "script")) return keys.length === 1;
	return typeof input.script === "string" && (input.script === "" || input.script === fixtureScript);
}

async function createFixture(): Promise<HarnessFixture> {
	const root = await mkdtemp(join(tmpdir(), "phi-live-acceptance-"));
	const repository = join(root, "synthetic-repository");
	const configRoot = join(root, "isolated-claude-config");
	const homeRoot = join(root, "isolated-home");
	const tempRoot = join(root, "isolated-tmp");
	const pluginCacheRoot = join(root, "isolated-plugin-cache");
	const settingsHookLog = join(root, "settings-hook.log");
	const hookProgram = join(root, "verify-settings-hook.cjs");
	const toolEditTarget = join(repository, "target.txt");
	const claudeDir = join(repository, ".claude");
	const skillDir = join(claudeDir, "skills", SKILL_NAME);
	const workflowsDir = join(claudeDir, "workflows");
	const workflowPath = join(workflowsDir, `${SKILL_NAME}.js`);
	const workflowReleaseFiles = {
		stopped: join(repository, WORKFLOW_AGENT_RELEASE_FILE_NAMES.stopped),
		continued: join(repository, WORKFLOW_AGENT_RELEASE_FILE_NAMES.continued),
	};
	const fixtureWorkflowSource = resolve(dirname(fileURLToPath(import.meta.url)), "../../test/live-workflow.js");

	try {
		const workflowScript = await readFile(fixtureWorkflowSource, "utf8");
		await Promise.all([
			mkdir(repository, { recursive: true, mode: 0o700 }),
			mkdir(configRoot, { recursive: true, mode: 0o700 }),
			mkdir(join(configRoot, "tmp"), { recursive: true, mode: 0o700 }),
			mkdir(homeRoot, { recursive: true, mode: 0o700 }),
			mkdir(tempRoot, { recursive: true, mode: 0o700 }),
			mkdir(pluginCacheRoot, { recursive: true, mode: 0o700 }),
			mkdir(skillDir, { recursive: true, mode: 0o700 }),
			mkdir(workflowsDir, { recursive: true, mode: 0o700 }),
		]);
		await writeFile(join(configRoot, "settings.json"), JSON.stringify({
			env: { PHI_LIVE_USER_SETTING: "user-fixture" },
		}, null, 2));
		await writeFile(join(repository, "CLAUDE.md"), [
			"This is a synthetic disposable integration fixture.",
			`Use the ${SKILL_NAME} skill before editing.`,
			"Use the Edit tool exactly once to change target.txt from before to after.",
			`Run the exact Bash command ${MAIN_SLEEP_COMMAND} once in the foreground.`,
			`Launch the native Workflow named ${SKILL_NAME} without changing its script.`,
			"Do not access external services, other repositories, credentials, or GitHub.",
		].join("\n"));
		await writeFile(join(skillDir, "SKILL.md"), [
			"---",
			`name: ${SKILL_NAME}`,
			"description: Small fixture skill for native SDK discovery checks",
			"---",
			"Return the marker phi-live-skill-ok before proceeding.",
		].join("\n"));
		await writeFile(toolEditTarget, "before\n");
		await writeFile(hookProgram, [
			"'use strict';",
			"const { appendFileSync } = require('node:fs');",
			"if (process.env.PHI_LIVE_USER_SETTING !== 'user-fixture' || process.env.PHI_LIVE_PROJECT_SETTING !== 'project-fixture') {",
			"\tprocess.exit(23);",
			"}",
			"appendFileSync(process.argv[2], 'native-settings-and-hook-ok\\n');",
		].join("\n"));
		await writeFile(workflowPath, workflowScript);
		const projectSettings = {
			env: { PHI_LIVE_PROJECT_SETTING: "project-fixture" },
			permissions: {
				allow: ["Workflow", "Skill", "Edit", "Read", `Bash(${MAIN_SLEEP_COMMAND})`, `Bash(${AGENT_SLEEP_COMMAND})`],
			},
			hooks: {
				PostToolUse: [{
					matcher: "Edit",
					hooks: [{
						type: "command",
						command: `${shellQuote(process.execPath)} ${shellQuote(hookProgram)} ${shellQuote(settingsHookLog)}`,
					}],
				}],
			},
		};
		await writeFile(join(claudeDir, "settings.json"), JSON.stringify(projectSettings, null, 2));
		await writeFile(join(repository, ".gitignore"), ".claude/settings.local.json\n");
		const gitInit = spawnSync("git", ["init", "--quiet"], {
			cwd: repository,
			encoding: "utf8",
			timeout: 5_000,
		});
		if (gitInit.status !== 0) throw new Error("Could not initialize the disposable local Git repository");
		return {
			root,
			repository,
			configRoot,
			homeRoot,
			tempRoot,
			pluginCacheRoot,
			settingsHookLog,
			toolEditTarget,
			workflowPath,
			workflowScript,
			workflowReleaseFiles,
		};
	} catch (error) {
		await rm(root, { recursive: true, force: true });
		throw error;
	}
}

function createFixtureEnvironment(fixture: HarnessFixture): NodeJS.ProcessEnv {
	return {
		PATH: process.env.PATH,
		ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
		PHI_HOME: fixture.configRoot,
		CLAUDE_CONFIG_DIR: fixture.configRoot,
		CLAUDE_CODE_TMPDIR: fixture.tempRoot,
		CLAUDE_CODE_PLUGIN_CACHE_DIR: fixture.pluginCacheRoot,
		HOME: fixture.homeRoot,
		TMPDIR: fixture.tempRoot,
		LANG: process.env.LANG,
		LC_ALL: process.env.LC_ALL,
	};
}

function buildInitialPrompt(workflowPath: string, checkpoint: string): string {
	const marker = `phi-live-resume-${checkpoint}`;
	return [
		"Complete this bounded SDK acceptance scenario in the disposable repository only.",
		`Use the ${SKILL_NAME} skill first.`,
		"Use the Edit tool exactly once to replace `before` with `after` in target.txt.",
		`Run the exact Bash command ${MAIN_SLEEP_COMMAND} once as a foreground tool call.`,
		`Call the native Workflow tool exactly once using name ${SKILL_NAME}.`,
		`Its fixture is ${workflowPath}. Do not edit that workflow file.`,
		`The exact resume marker for the later session-resume check is ${marker}.`,
		"Do not use network tools, run other shell commands, modify other files, or access any non-fixture path.",
		"After the native Workflow tool returns its launch result, finish this turn with a short status.",
	].join("\n");
}

function userMessage(text: string, uuid: UUID): SDKUserMessage {
	return {
		type: "user",
		message: { role: "user", content: text },
		parent_tool_use_id: null,
		uuid,
	};
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function isFixturePath(repository: string, value: unknown): boolean {
	if (typeof value !== "string" || value.length === 0) return false;
	const candidate = resolve(repository, value);
	const pathFromRepository = relative(repository, candidate);
	return pathFromRepository === "" || (
		!isAbsolute(pathFromRepository) &&
		pathFromRepository !== ".." &&
		!pathFromRepository.startsWith(`..${sep}`)
	);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function findToolUses(messages: SDKMessage[], name: string): ToolUse[] {
	const uses: ToolUse[] = [];
	for (const message of messages) {
		const record = asRecord(message);
		if (record?.type !== "assistant") continue;
		const body = asRecord(record.message);
		if (!Array.isArray(body?.content)) continue;
		for (const value of body.content) {
			const block = asRecord(value);
			if (block?.type !== "tool_use" || block.name !== name) continue;
			const id = asString(block.id);
			const input = asRecord(block.input);
			if (id && input) uses.push({ id, name, input });
		}
	}
	return uses;
}

function findToolUse(
	messages: SDKMessage[],
	name: string,
	predicate: (input: Record<string, unknown>) => boolean,
): ToolUse | undefined {
	return findToolUses(messages, name).find((use) => predicate(use.input));
}

export function findWorkflowOutput(
	messages: readonly unknown[],
	workflowToolUseId: string,
): WorkflowOutput | undefined {
	const correlatedResult = findCorrelatedWorkflowResult(messages, workflowToolUseId);
	if (correlatedResult?.block.is_error === true) {
		throw new Error("Native Workflow launch returned an error result.");
	}
	for (const message of messages) {
		const record = asRecord(message);
		const output = asRecord(record?.tool_use_result);
		if (output?.status !== "async_launched" && output?.status !== "remote_launched") continue;
		if (typeof output.taskId !== "string") continue;
		return output as unknown as WorkflowOutput;
	}
	return undefined;
}

function findTaskStarted(
	messages: SDKMessage[],
	predicate: (task: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
	return uniqueTaskStarts(messages).find(predicate);
}

function uniqueTaskStarts(messages: readonly unknown[]): Record<string, unknown>[] {
	const byId = new Map<string, Record<string, unknown>>();
	for (const message of messages) {
		const record = asRecord(message);
		if (record?.type !== "system" || record.subtype !== "task_started") continue;
		const taskId = asString(record.task_id);
		if (taskId) byId.set(taskId, record);
	}
	return [...byId.values()];
}

export function findAgentTaskIDs(messages: readonly unknown[], workflowTaskId?: string): string[] {
	return uniqueTaskStarts(messages)
		.filter((task) => isNativeWorkflowAgentTask(task, workflowTaskId))
		.map((task) => asString(task.task_id)!);
}

export function findMatchingNativeAgentTaskID(
	messages: readonly unknown[],
	workflowTaskId: string,
	agentStart: NativeAgentLifecycleRecord,
): string | undefined {
	if (agentStart.event !== "SubagentStart") return undefined;
	const agentTasks = uniqueTaskStarts(messages)
		.filter((task) => isNativeWorkflowAgentTask(task, workflowTaskId) && task.parent_task_id === workflowTaskId);
	if (agentStart.callbackToolUseId === undefined) return undefined;
	const matches = agentTasks.filter((task) => task.tool_use_id === agentStart.callbackToolUseId);
	return matches.length === 1 ? asString(matches[0]?.task_id) : undefined;
}

export async function stopNativeAgentTask(
	nativeTaskId: string | undefined,
	stopTask: (taskId: string) => Promise<unknown>,
): Promise<string> {
	if (!nativeTaskId) {
		throw new Error("Missing native control: no registered native task handle is available for this Workflow child.");
	}
	await stopTask(nativeTaskId);
	return nativeTaskId;
}

function isNativeWorkflowAgentTask(task: Record<string, unknown>, workflowTaskId?: string): boolean {
	const taskId = asString(task.task_id);
	return task.task_type === "local_agent" && taskId !== undefined && taskId.length > 0 && taskId !== workflowTaskId;
}

function isTaskNotification(message: SDKMessage, taskId: string): boolean {
	const record = asRecord(message);
	return record?.type === "system" && record.subtype === "task_notification" && record.task_id === taskId;
}

const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "stopped"]);

function hasTerminalTaskNotification(messages: readonly unknown[], taskId: string): boolean {
	return messages.some((message) => {
		const record = asRecord(message);
		return record?.type === "system" && record.subtype === "task_notification" &&
			record.task_id === taskId && typeof record.status === "string" &&
			TERMINAL_TASK_STATUSES.has(record.status);
	});
}

export function isBackgroundTaskActive(messages: readonly unknown[], taskId: string): boolean {
	let currentMembership: Set<string> | undefined;
	for (const message of messages) {
		const record = asRecord(message);
		if (record?.type !== "system" || record.subtype !== "background_tasks_changed" || !Array.isArray(record.tasks)) {
			continue;
		}
		currentMembership = new Set(record.tasks.flatMap((value) => {
			const taskId = asString(asRecord(value)?.task_id);
			return taskId ? [taskId] : [];
		}));
	}
	return currentMembership?.has(taskId) === true && !hasTerminalTaskNotification(messages, taskId);
}

export function hasSkillMarker(messages: readonly unknown[], marker: string): boolean {
	return messages.some((message) => {
		const record = asRecord(message);
		if (record?.type !== "assistant") return false;
		const body = asRecord(record.message);
		if (!Array.isArray(body?.content)) return false;
		return body.content.some((value) => {
			const block = asRecord(value);
			return block?.type === "text" && typeof block.text === "string" && block.text.includes(marker);
		});
	});
}

function hasTaskNotification(messages: SDKMessage[], taskId: string, status: string): boolean {
	return messages.some((message) => {
		const record = asRecord(message);
		return isTaskNotification(message, taskId) && record?.status === status;
	});
}

function hasBackgroundTask(messages: SDKMessage[], taskId: string): boolean {
	return messages.some((message) => {
		const record = asRecord(message);
		if (record?.type !== "system" || record.subtype !== "background_tasks_changed" || !Array.isArray(record.tasks)) return false;
		return record.tasks.some((value) => asRecord(value)?.task_id === taskId);
	});
}

function workflowTaskTerminalStatus(messages: readonly unknown[], workflowTaskId: string): string | undefined {
	for (const message of messages) {
		const record = asRecord(message);
		if (record?.type !== "system" || record.subtype !== "task_notification" || record.task_id !== workflowTaskId) continue;
		if (typeof record.status === "string" && WORKFLOW_TERMINAL_STATUSES.includes(record.status as (typeof WORKFLOW_TERMINAL_STATUSES)[number])) {
			return record.status;
		}
	}
	return undefined;
}

function backgroundTaskClassesAfter(messages: readonly unknown[], startIndex: number): string[][] {
	const snapshots: string[][] = [];
	for (const message of messages.slice(startIndex)) {
		const record = asRecord(message);
		if (record?.type !== "system" || record.subtype !== "background_tasks_changed" || !Array.isArray(record.tasks)) continue;
		const classes = record.tasks.map((taskValue) => {
			const task = asRecord(taskValue);
			const taskClass = asString(task?.task_type) ?? asString(task?.type);
			return taskClass !== undefined && SAFE_BACKGROUND_TASK_CLASSES.has(taskClass) ? taskClass : "other";
		});
		snapshots.push(classes);
	}
	return snapshots;
}

function resultForMessage(messages: SDKMessage[], userMessageId: UUID): SDKResultMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		const record = asRecord(message);
		if (record?.type !== "result") continue;
		const result = message as SDKResultMessage;
		if (result.user_message_uuid === userMessageId || result.user_message_uuids?.includes(userMessageId)) {
			return result;
		}
	}
	return undefined;
}

export async function waitFor<T>(
	read: () => T | undefined | Promise<T | undefined>,
	events: EventLog,
	deadline: number,
	label: string,
	session: LiveQueryLifecycle,
): Promise<T> {
	return withDeadline((async () => {
		while (Date.now() < deadline) {
			const value = await read();
			if (value !== undefined) return value;
			if (events.errors.length > 0) {
				throw new Error(`SDK reported an error while waiting for ${label}`, { cause: events.errors[0] });
			}
			await delay(100);
		}
		throw new DeadlineExceededError(`Timed out waiting for ${label}`);
	})(), deadline, label, session);
}

async function waitForJournal(
	readJournal: typeof import("../src/workflows.js").readWorkflowJournal,
	ref: import("../src/workflows.js").WorkflowReference,
	events: EventLog,
	deadline: number,
	session: LiveQueryLifecycle,
	workflowTaskId: string,
): Promise<import("../src/workflows.js").WorkflowJournalMetadata> {
	return waitFor(async () => {
		if (workflowTaskTerminalStatus(events.messages, workflowTaskId) !== undefined) {
			throw new Error("Workflow completed before its two native phase-start records were available.");
		}
		const page = await readJournal(ref);
		const started = page.metadata.records.filter(
			(record) => record.type === "started" && record.phase === "Parallel fixture probes",
		);
		const startedIds = new Set(started.map((record) => record.agentId).filter(Boolean));
		const completed = page.metadata.records.some((record) =>
			(record.type === "result" || record.type === "failed") &&
			(record.phase === "Parallel fixture probes" ||
				(record.agentId !== undefined && startedIds.has(record.agentId)) ||
				(record.type === "failed" && record.agentId === undefined)),
		);
		if (completed) throw new Error("A Workflow agent completed before the native control probe reached its hook boundary.");
		return startedIds.size >= 2 ? page.metadata : undefined;
	}, events, deadline, "workflow phase journal metadata", session);
}

export async function closeSession(
	session: LiveQueryLifecycle,
	timeoutMs: number,
	label: string,
): Promise<LiveCloseOutcome> {
	const startedAt = Date.now();
	let closeError: unknown;
	let doneError: unknown;
	let closePromise: Promise<void>;
	try {
		closePromise = session.close().then(
			() => undefined,
			(error: unknown) => {
				closeError = error;
			},
		);
	} catch (error) {
		closeError = error;
		closePromise = Promise.resolve();
	}
	const donePromise = session.done.then(
		() => undefined,
		(error: unknown) => {
			doneError = error;
		},
	);
	try {
		await waitBounded(donePromise, timeoutMs, `${label} query termination`);
	} catch (error) {
		return { terminated: false, error };
	}
	try {
		const remainingMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
		await waitBounded(closePromise, remainingMs, `${label} close`);
	} catch (error) {
		return { terminated: true, error: closeError ?? doneError ?? error };
	}
	const error = closeError ?? doneError;
	return error === undefined ? { terminated: true } : { terminated: true, error };
}

function assertCleanClose(outcome: LiveCloseOutcome, label: string): void {
	if (!outcome.terminated) {
		throw new Error(`${label} did not establish query termination`, { cause: outcome.error });
	}
	if (outcome.error !== undefined) {
		throw new Error(`${label} reported a cleanup failure`, { cause: outcome.error });
	}
}

export async function withDeadline<T>(
	promise: Promise<T>,
	deadline: number,
	label: string,
	session: LiveQueryLifecycle,
): Promise<T> {
	const remainingMs = Math.min(STEP_TIMEOUT_MS, Math.max(0, deadline - Date.now()));
	try {
		return await waitBounded(promise, remainingMs, label);
	} catch (error) {
		if (!(error instanceof DeadlineExceededError)) throw error;
		const cleanup = await closeSession(session, TERMINATION_TIMEOUT_MS, `${label} timeout termination`);
		if (!cleanup.terminated || cleanup.error !== undefined) {
			const details = cleanup.error === undefined ? [error] : [error, cleanup.error];
			const message = cleanup.terminated
				? `${label} timed out and query cleanup failed`
				: `${label} timed out and query termination was not observed`;
			throw new AggregateError(details, message);
		}
		throw error;
	}
}

class DeadlineExceededError extends Error {}

async function waitBounded<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_, reject) => {
				timer = setTimeout(() => reject(new DeadlineExceededError(`Timed out waiting for ${label}`)), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function extractResumeMarker(messages: SDKMessage[], checkpoint: string): string {
	const prompt = messages
		.map((message) => asRecord(message))
		.find((record) => record?.uuid === checkpoint);
	const body = asRecord(prompt?.message);
	const content = typeof body?.content === "string" ? body.content : "";
	const match = content.match(/phi-live-resume-[0-9a-f-]+/i);
	assert.ok(match, "initial user message must contain its session-resume marker");
	return match[0];
}

function delay(ms: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

if (isMainModule()) {
	void main().catch((error: unknown) => {
		if (error instanceof LiveRunRefusal) {
			if (!failureDiagnosticEmitted) reportLiveFailureDiagnostic(error);
			process.exitCode = 2;
			return;
		}
		if (error instanceof QueryCreationTripwireError) {
			if (!failureDiagnosticEmitted) reportLiveFailureDiagnostic(error);
			process.exitCode = 86;
			return;
		}
		if (!failureDiagnosticEmitted) reportLiveFailureDiagnostic(error);
		process.exitCode = 1;
	});
}
