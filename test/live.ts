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
const AGENT_SLEEP_COMMAND = "sleep 90";
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
async function main(): Promise<void> {
	const maxBudgetUsd = validateLiveInvocation(process.env, process.argv.slice(2));
	const deadline = Date.now() + MAX_TOTAL_TIME_MS;
	const [{ parseArgs, buildOptions }, { startSession }, { readWorkflowJournal }] = await Promise.all([
		import("../src/config.js"),
		import("../src/session.js"),
		import("../src/workflows.js"),
	]);

	const fixture = await createFixture();
	const sessions: Array<ReturnType<typeof startSession>> = [];
	let reportedSpend: number | undefined;
	let sessionId: string | undefined;
	let checkpointId: UUID | undefined;
	let workflowTaskId: string | undefined;
	let workflowRunId: string | undefined;

	try {
		const firstBudgetUsd = maxBudgetUsd * INITIAL_BUDGET_SHARE;
		const initialLaunch = parseArgs([
			"--cwd", fixture.repository,
			"--permission-mode", "acceptEdits",
			"--max-budget-usd", String(firstBudgetUsd),
		]);
		const firstOptions = buildOptions(initialLaunch, fixtureCallbacks(fixture));
		firstOptions.maxTurns = 3;
		firstOptions.disallowedTools = ["WebFetch", "WebSearch"];
		firstOptions.mcpServers = {};
		firstOptions.strictMcpConfig = true;
		firstOptions.env = {
			...firstOptions.env,
			CLAUDE_CONFIG_DIR: fixture.configRoot,
			CLAUDE_CODE_MAX_TURNS: "2",
			CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS: "2",
		};

		sessionId = firstOptions.sessionId;
		assert.ok(sessionId, "new native query must have an SDK session id");
		const events: EventLog = { messages: [], errors: [] };
		const session = startSession(firstOptions, {
			onMessage(message) {
				events.messages.push(message);
			},
			onError(error) {
				events.errors.push(error);
			},
		});
		sessions.push(session);

		const initialized = await withDeadline(session.ready, deadline, "initial SDK initialization");
		assert.equal(initialized.account.apiProvider, "firstParty", "fixture must use the first-party API route");
		assert.equal(initialized.account.apiKeySource, "ANTHROPIC_API_KEY", "fixture must use its environment key source");
		assert.ok(
			JSON.stringify(initialized.commands).includes(SKILL_NAME),
			"native initialization must discover the project acceptance skill",
		);

		checkpointId = randomUUID();
		session.send(userMessage(buildInitialPrompt(fixture.workflowPath, checkpointId), checkpointId));

		const mainBash = await waitFor(
			() => findToolUse(events.messages, "Bash", (input) => input.command === MAIN_SLEEP_COMMAND),
			events,
			deadline,
			"bounded foreground Bash tool call",
		);
		const mainBashTask = await waitFor(
			() => findTaskStarted(events.messages, (task) => task.tool_use_id === mainBash.id),
			events,
			deadline,
			"native foreground task registration",
		);
		const mainBashTaskId = asString(mainBashTask.task_id);
		assert.ok(mainBashTaskId, "foreground Bash task must have a native task id");
		assert.notEqual(mainBashTask.is_backgrounded, true, "sleep command must start in the foreground");
		assert.equal(
			await withDeadline(session.query.backgroundTasks(mainBash.id), deadline, "native task backgrounding"),
			true,
			"native backgroundTasks must background the selected command",
		);
		await waitFor(
			() => hasBackgroundTask(events.messages, mainBashTaskId),
			events,
			deadline,
			"background task membership",
		);
		const workflowCall = await waitFor(
			() => findToolUse(events.messages, "Workflow", (input) => input.name === SKILL_NAME),
			events,
			deadline,
			"native Workflow tool call",
		);
		assert.equal(workflowCall.input.name, SKILL_NAME);

		const workflowOutput = await waitFor(
			() => findWorkflowOutput(events.messages),
			events,
			deadline,
			"native Workflow launch result",
		);
		assert.equal(workflowOutput.status, "async_launched");
		assert.equal(workflowOutput.workflowName, SKILL_NAME);
		assert.ok(workflowOutput.taskId, "WorkflowOutput.taskId is required for the workflow task");
		assert.ok(workflowOutput.runId, "WorkflowOutput.runId is required for local workflow resume metadata");
		assert.ok(workflowOutput.transcriptDir, "WorkflowOutput.transcriptDir is required for native metadata inspection");
		workflowTaskId = workflowOutput.taskId;
		workflowRunId = workflowOutput.runId;
		assert.notEqual(workflowTaskId, workflowRunId, "native task id and workflow run id must remain distinct");
		assert.notEqual(workflowTaskId, sessionId, "Workflow task id and session id must remain distinct");
		assert.notEqual(workflowRunId, sessionId, "Workflow run id and session id must remain distinct");
		assert.notEqual(checkpointId, sessionId, "checkpoint UUID and session id must remain distinct");
		assert.notEqual(checkpointId, workflowTaskId, "checkpoint UUID and native task id must remain distinct");
		assert.notEqual(checkpointId, workflowRunId, "checkpoint UUID and workflow run id must remain distinct");

		const journalRef = {
			sessionId,
			output: workflowOutput,
			configRoot: fixture.configRoot,
		};
		const journal = await waitForJournal(
			readWorkflowJournal,
			journalRef,
			events,
			deadline,
		);
		const startedAgentRecords = journal.records.filter(
			(record) => record.type === "started" && record.phase === "Parallel fixture probes",
		);
		assert.equal(new Set(startedAgentRecords.map((record) => record.agentId)).size, 2);
		assert.ok(startedAgentRecords.every((record) => record.agentId), "phase records must expose native agent ids");

		const workflowAgents = await waitFor(
			() => {
				const agents = uniqueTaskStarts(events.messages).filter((task) => {
					const prompt = asString(task.prompt) ?? "";
					const description = asString(task.description) ?? "";
					return task.task_type === "local_agent" ||
						prompt.includes("phi-live-agent-") || description.includes("phi-live-agent-");
				});
				return agents.length >= 2 ? agents.slice(0, 2) : undefined;
			},
			events,
			deadline,
			"two native Workflow agent tasks",
		);
		const firstAgentTaskId = asString(asRecord(workflowAgents[0])?.task_id);
		const secondAgentTaskId = asString(asRecord(workflowAgents[1])?.task_id);
		assert.ok(firstAgentTaskId && secondAgentTaskId);
		assert.notEqual(firstAgentTaskId, secondAgentTaskId, "the two Workflow agent task ids must differ");
		assert.notEqual(firstAgentTaskId, workflowTaskId);
		assert.notEqual(secondAgentTaskId, workflowTaskId);
		const nativeIdentifiers = [
			sessionId,
			checkpointId,
			workflowTaskId,
			workflowRunId,
			mainBashTaskId,
			firstAgentTaskId,
			secondAgentTaskId,
		];
		assert.equal(
			new Set(nativeIdentifiers).size,
			nativeIdentifiers.length,
			"session, checkpoint, Workflow run, and task ids must be distinct",
		);
		const secondAgentStartIndex = events.messages.findIndex((message) => {
			const record = asRecord(message);
			return record?.subtype === "task_started" && record.task_id === secondAgentTaskId;
		});
		assert.ok(
			!events.messages.slice(0, secondAgentStartIndex).some(
				(message) => isTaskNotification(message, firstAgentTaskId),
			),
			"both Workflow agents must overlap before the first one settles",
		);

		await withDeadline(session.query.stopTask(firstAgentTaskId), deadline, "stop first Workflow agent");
		await waitFor(
			() => hasTaskNotification(events.messages, firstAgentTaskId, "stopped"),
			events,
			deadline,
			"individual native task stop",
		);
		assert.ok(
			!hasTaskNotification(events.messages, secondAgentTaskId, "stopped"),
			"stopping one Workflow agent must leave its parallel sibling active",
		);

		const firstTurn = await waitFor(
			() => allResults(events.messages)[0],
			events,
			deadline,
			"first main turn result",
		);
		assert.equal(firstTurn.session_id, sessionId);
		assert.equal(firstTurn.is_error, false, "initial native session turn must succeed");
		assert.equal(findToolUses(events.messages, "Edit").length, 1, "the fixture must produce exactly one native Edit call");
		assert.ok(findToolUse(events.messages, "Skill", (input) => input.skill === SKILL_NAME), "native Skill tool must run");
		assert.ok(
			findToolUse(events.messages, "Workflow", (input) => input.name === SKILL_NAME),
			"native Workflow tool must run",
		);

		const editedText = await readFile(fixture.toolEditTarget, "utf8");
		assert.equal(editedText, "after\n", "native Edit tool must change only the synthetic target");
		const hookLog = await readFile(fixture.settingsHookLog, "utf8");
		assert.equal(hookLog.trim(), "native-settings-and-hook-ok", "project settings env and hook must both be active");

		const rewindPreview = await withDeadline(
			session.query.rewindFiles(checkpointId, { dryRun: true }),
			deadline,
			"native checkpoint dry run",
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
		assert.ok(
			!hasTaskNotification(events.messages, secondAgentTaskId, "completed") &&
			!hasTaskNotification(events.messages, secondAgentTaskId, "stopped"),
			"the second Workflow agent must still be active before continued main input",
		);
		session.send(userMessage("The first turn is complete. Reply only `continuation accepted`; do not use tools.", randomUUID()));

		const continuedTurn = await waitFor(
			() => {
				return allResults(events.messages)[1];
			},
			events,
			deadline,
			"continued main input while a Workflow agent is active",
		);
		assert.equal(continuedTurn.session_id, sessionId);
		assert.equal(continuedTurn.is_error, false);
		assert.ok(
			!hasTaskNotification(events.messages, secondAgentTaskId, "completed"),
			"the main session must accept input while the other Workflow agent remains active",
		);
		const remainingBudgetUsd = maxBudgetUsd - continuedTurn.total_cost_usd;
		assert.ok(remainingBudgetUsd > 0, "reported initial spend leaves room inside the requested total budget for resume");
		reportedSpend = continuedTurn.total_cost_usd;
		console.log(`Reported session spend before resume: $${reportedSpend.toFixed(4)} USD.`);

		await waitFor(
			() => hasTaskNotification(events.messages, mainBashTaskId, "completed"),
			events,
			deadline,
			"background Bash completion",
		);
		await withDeadline(session.query.stopTask(secondAgentTaskId), deadline, "stop remaining Workflow agent");
		await waitFor(
			() => hasTaskNotification(events.messages, secondAgentTaskId, "stopped"),
			events,
			deadline,
			"cleanup stop for the remaining Workflow agent",
		);

		await closeSession(session, deadline, "initial session close");

		const resumeOptions = buildOptions(
			parseArgs([
				"--cwd", fixture.repository,
				"--resume", sessionId,
				"--permission-mode", "acceptEdits",
				"--max-budget-usd", String(remainingBudgetUsd),
			]),
			fixtureCallbacks(fixture),
		);
		resumeOptions.maxTurns = 1;
		resumeOptions.disallowedTools = ["WebFetch", "WebSearch"];
		resumeOptions.mcpServers = {};
		resumeOptions.strictMcpConfig = true;
		resumeOptions.env = {
			...resumeOptions.env,
			CLAUDE_CONFIG_DIR: fixture.configRoot,
			CLAUDE_CODE_MAX_TURNS: "2",
			CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS: "2",
		};

		const resumedEvents: EventLog = { messages: [], errors: [] };
		const resumed = startSession(resumeOptions, {
			onMessage(message) {
				resumedEvents.messages.push(message);
			},
			onError(error) {
				resumedEvents.errors.push(error);
			},
		});
		sessions.push(resumed);
		const resumedInitialization = await withDeadline(resumed.ready, deadline, "resumed SDK initialization");
		assert.equal(resumedInitialization.account.apiProvider, "firstParty");
		assert.equal(resumedInitialization.account.apiKeySource, "ANTHROPIC_API_KEY");

		const resumePromptId = randomUUID();
		resumed.send(userMessage(
			`What exact resume marker appeared in the earlier conversation? Reply with only that marker.`,
			resumePromptId,
		));
		const resumedResult = await waitFor(
			() => latestResult(resumedEvents.messages),
			resumedEvents,
			deadline,
			"resumed session result",
		);
		assert.equal(resumedResult.session_id, sessionId, "native session resume must retain the original session id");
		assert.equal(resumedResult.is_error, false);
		if (resumedResult.subtype !== "success") {
			throw new Error(`Native session resume ended with ${resumedResult.subtype}`);
		}
		const expectedResumeMarker = extractResumeMarker(events.messages, checkpointId);
		assert.ok(resumedResult.result.includes(expectedResumeMarker), "resumed conversation must retain its earlier user context");
		reportedSpend = resumedResult.total_cost_usd;
		console.log(`Reported session spend after resume: $${reportedSpend.toFixed(4)} USD.`);
		assert.ok(reportedSpend <= maxBudgetUsd, "reported session spend must remain within the requested budget");

		console.log(`Native SDK acceptance scenario completed. Reported session spend: $${reportedSpend.toFixed(4)} USD.`);
		console.log(`Session ${sessionId}; Workflow task ${workflowTaskId}; Workflow run ${workflowRunId}; checkpoint ${checkpointId}.`);
	} finally {
		const closeOutcomes = await Promise.allSettled(
			sessions.reverse().map((session) => closeSession(session, Date.now() + 15_000, "final session cleanup")),
		);
		const cleanupFailure = closeOutcomes.find((outcome) => outcome.status === "rejected");
		if (cleanupFailure?.status === "rejected") {
			console.error("Native SDK session cleanup did not complete cleanly.");
			process.exitCode = process.exitCode || 1;
		}
		await rm(fixture.root, { recursive: true, force: true });
	}
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

if (isMainModule()) {
	void main().catch((error: unknown) => {
		if (error instanceof LiveRunRefusal) {
			console.error(error.message);
			process.exitCode = 2;
			return;
		}
		const errorName = error instanceof Error ? error.name : "UnknownError";
		console.error(`Native SDK acceptance scenario failed (${errorName}); no credential values were printed.`);
		process.exitCode = 1;
	});
}
