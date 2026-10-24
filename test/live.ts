import assert from "node:assert/strict";
import { randomUUID, type UUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Options, SDKMessage, SDKResultMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { WorkflowOutput } from "../src/workflows.js";

const SKILL_NAME = "phi-live-acceptance";
const MAIN_SLEEP_COMMAND = "sleep 8";
const AGENT_SLEEP_COMMAND = "sleep 30";
const INITIAL_BUDGET_SHARE = 0.75;
const MAX_TOTAL_TIME_MS = 180_000;
const STEP_TIMEOUT_MS = 60_000;

export class LiveRunRefusal extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LiveRunRefusal";
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
			"This isolated fixture requires ANTHROPIC_API_KEY in the process environment; the harness does not read or configure other credentials",
		);
	}
	return budget;
}

function isMainModule(): boolean {
	const entry = process.argv[1];
	return entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url;
}

if (isMainModule()) {
	try {
		validateLiveInvocation(process.env, process.argv.slice(2));
		console.error("The native SDK acceptance scenario is not assembled yet.");
		process.exitCode = 1;
	} catch (error: unknown) {
		console.error(error instanceof LiveRunRefusal ? error.message : "Live invocation guard failed.");
		process.exitCode = 2;
	}
}
interface HarnessFixture {
	root: string;
	repository: string;
	configRoot: string;
	settingsHookLog: string;
	toolEditTarget: string;
	workflowPath: string;
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

function fixtureCallbacks(fixture: HarnessFixture): Pick<Options, "canUseTool" | "onElicitation" | "hooks"> {
	return {
		canUseTool: async (toolName, input) => {
			if (toolName === "Read" && isFixturePath(fixture.repository, input.file_path)) {
				return { behavior: "allow", updatedInput: input };
			}
			if (toolName === "Skill" && input.skill === SKILL_NAME) {
				return { behavior: "allow", updatedInput: input };
			}
			if (toolName === "Edit" && isFixturePath(fixture.repository, input.file_path) && basename(String(input.file_path)) === "target.txt") {
				return { behavior: "allow", updatedInput: input };
			}
			if (toolName === "Workflow" && input.name === SKILL_NAME) {
				return { behavior: "allow", updatedInput: input };
			}
			if (toolName === "Bash" && (input.command === MAIN_SLEEP_COMMAND || input.command === AGENT_SLEEP_COMMAND)) {
				return { behavior: "allow", updatedInput: input };
			}
			return { behavior: "deny", message: "The live fixture denied an unlisted tool action." };
		},
		onElicitation: async () => ({ action: "decline" }),
		hooks: {},
	};
}

async function createFixture(): Promise<HarnessFixture> {
	const root = await mkdtemp(join(tmpdir(), "phi-live-acceptance-"));
	const repository = join(root, "synthetic-repository");
	const configRoot = join(root, "isolated-claude-config");
	const settingsHookLog = join(root, "settings-hook.log");
	const hookProgram = join(root, "verify-settings-hook.cjs");
	const toolEditTarget = join(repository, "target.txt");
	const claudeDir = join(repository, ".claude");
	const skillDir = join(claudeDir, "skills", SKILL_NAME);
	const workflowsDir = join(claudeDir, "workflows");
	const workflowPath = join(workflowsDir, `${SKILL_NAME}.js`);
	const fixtureWorkflowSource = resolve(dirname(fileURLToPath(import.meta.url)), "../../test/live-workflow.js");

	try {
		await Promise.all([
			mkdir(repository, { recursive: true }),
			mkdir(configRoot, { recursive: true }),
			mkdir(skillDir, { recursive: true }),
			mkdir(workflowsDir, { recursive: true }),
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
		await copyFile(fixtureWorkflowSource, workflowPath);
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
		return { root, repository, configRoot, settingsHookLog, toolEditTarget, workflowPath };
	} catch (error) {
		await rm(root, { recursive: true, force: true });
		throw error;
	}
}

function buildInitialPrompt(workflowPath: string, checkpoint: string): string {
	const marker = `phi-live-resume-${checkpoint}`;
	return [
		"Complete this bounded SDK acceptance scenario in the disposable repository only.",
		`Use the ${SKILL_NAME} skill first.`,
		"Use the Edit tool exactly once to replace `before` with `after` in target.txt.",
		`Run the exact Bash command ${MAIN_SLEEP_COMMAND} once as a foreground tool call.`,
		`Call the native Workflow tool exactly once using name ${SKILL_NAME}; its fixture is ${workflowPath}. Do not edit that workflow file.`,
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

function findWorkflowOutput(messages: SDKMessage[]): WorkflowOutput | undefined {
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

function uniqueTaskStarts(messages: SDKMessage[]): Record<string, unknown>[] {
	const byId = new Map<string, Record<string, unknown>>();
	for (const message of messages) {
		const record = asRecord(message);
		if (record?.type !== "system" || record.subtype !== "task_started") continue;
		const taskId = asString(record.task_id);
		if (taskId) byId.set(taskId, record);
	}
	return [...byId.values()];
}

function isTaskNotification(message: SDKMessage, taskId: string): boolean {
	const record = asRecord(message);
	return record?.type === "system" && record.subtype === "task_notification" && record.task_id === taskId;
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

function latestResult(messages: SDKMessage[]): SDKResultMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const record = asRecord(messages[index]);
		if (record?.type === "result") return messages[index] as SDKResultMessage;
	}
	return undefined;
}

function allResults(messages: SDKMessage[]): SDKResultMessage[] {
	return messages.filter((message) => asRecord(message)?.type === "result") as SDKResultMessage[];
}

async function waitFor<T>(
	read: () => T | undefined | Promise<T | undefined>,
	events: EventLog,
	deadline: number,
	label: string,
): Promise<T> {
	return withDeadline((async () => {
		while (Date.now() < deadline) {
			const value = await read();
			if (value !== undefined) return value;
			if (events.errors.length > 0) throw new Error(`SDK reported an error while waiting for ${label}`);
			await delay(100);
		}
		throw new Error(`Timed out waiting for ${label}`);
	})(), deadline, label);
}

async function waitForJournal(
	readJournal: typeof import("../src/workflows.js").readWorkflowJournal,
	ref: import("../src/workflows.js").WorkflowReference,
	events: EventLog,
	deadline: number,
): Promise<import("../src/workflows.js").WorkflowJournalMetadata> {
	return waitFor(async () => {
		const page = await readJournal(ref);
		const started = page.metadata.records.filter(
			(record) => record.type === "started" && record.phase === "Parallel fixture probes",
		);
		return new Set(started.map((record) => record.agentId).filter(Boolean)).size >= 2
			? page.metadata
			: undefined;
	}, events, deadline, "workflow phase journal metadata");
}

async function closeSession(
	session: ReturnType<typeof import("../src/session.js").startSession>,
	deadline: number,
	label: string,
): Promise<void> {
	await withDeadline(session.close(), deadline, label);
}

async function withDeadline<T>(promise: Promise<T>, deadline: number, label: string): Promise<T> {
	const remainingMs = Math.min(STEP_TIMEOUT_MS, Math.max(0, deadline - Date.now()));
	if (remainingMs === 0) throw new Error(`Timed out before ${label} started`);
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), remainingMs);
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

