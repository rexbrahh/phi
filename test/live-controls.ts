import assert from "node:assert/strict";
import { randomUUID, type UUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Options, SDKMessage, SDKResultMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { startSession, type Session } from "../src/session.js";
import { formatErrorText } from "../src/ui/error-text.js";
import {
	combinedQueryCost,
	createCanonicalTempRoot,
	fixtureOptions,
	inspectFixtureServerStop,
	isFixtureCheckpointPath,
	OUTPUT_TOKENS,
	recordQueryCost,
	SERVER_TIMEOUT_MS,
	type Controls,
	type Fixture,
	type FixtureServerStopEvidence,
	type QueryCostLedger,
	type QueryKind,
} from "./live-controls-support.js";
import {
	assertPinnedModelUsage,
	cleanupLiveFixture,
	closeSession,
	formatLiveFailureDiagnostic,
	isBackgroundTaskActive,
	LiveRunRefusal,
	observedResultTotalCostUsd,
	validateLiveInvocation,
	waitFor,
	withDeadline,
	writeLiveFailureTrace,
} from "./live.js";

const INITIAL_SHARE = 0.75;
const CLOSE_TIMEOUT_MS = 15_000;
const TOTAL_TIMEOUT_MS = 150_000;

type Events = { messages: SDKMessage[]; errors: unknown[] };

function isMainModule(): boolean { return process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url; }
function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}
function findToolUse(messages: readonly SDKMessage[], name: string): Array<{ id: string; input: Record<string, unknown> }> {
	const found: Array<{ id: string; input: Record<string, unknown> }> = [];
	for (const message of messages) {
		const content = asRecord(asRecord(message)?.message)?.content;
		if (!Array.isArray(content)) continue;
		for (const blockValue of content) {
			const block = asRecord(blockValue);
			const input = asRecord(block?.input);
			if (block?.type === "tool_use" && block.name === name && typeof block.id === "string" && input) {
				found.push({ id: block.id, input });
			}
		}
	}
	return found;
}
function taskStarted(messages: readonly SDKMessage[], toolUseId: string): Record<string, unknown> | undefined {
	return messages.map(asRecord).find((event) => event?.type === "system" && event.subtype === "task_started" && event.tool_use_id === toolUseId);
}
function taskStopped(messages: readonly SDKMessage[], taskId: string): Record<string, unknown> | undefined {
	return messages.map(asRecord).find((event) => event?.type === "system" && event.subtype === "task_notification" && event.task_id === taskId && event.status === "stopped");
}
function resultFor(messages: readonly SDKMessage[], uuid: UUID): SDKResultMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i]!;
		const result = asRecord(message);
		if (result?.type !== "result") continue;
		const typed = message as SDKResultMessage;
		if (typed.user_message_uuid === uuid || typed.user_message_uuids?.includes(uuid)) return typed;
	}
	return undefined;
}
function userMessage(text: string, uuid: UUID): SDKUserMessage { return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, uuid }; }
async function createFixture(): Promise<Fixture> {
	const root = await createCanonicalTempRoot("phi-live-controls-");
	const fixture = {
		root, project: join(root, "synthetic-project"), home: join(root, "synthetic-home"),
		config: join(root, "synthetic-claude-config"), temp: join(root, "synthetic-tmp"),
		target: join(root, "synthetic-project", "target.txt"),
	};
	try {
		await Promise.all([fixture.project, fixture.home, fixture.config, fixture.temp, join(fixture.config, "tmp"), join(fixture.config, "plugins")]
			.map((path) => mkdir(path, { recursive: true, mode: 0o700 })));
		await writeFile(fixture.target, "before\n", { flag: "wx", mode: 0o600 });
		await writeFile(join(fixture.project, "server.js"), serverProgram(), { flag: "wx", mode: 0o600 });
		return fixture;
	} catch (error) {
		await rm(root, { recursive: true, force: true });
		throw error;
	}
}

function serverProgram(): string {
	return [
		"const fs = require('node:fs'), http = require('node:http');",
		"const log = (line) => fs.appendFileSync('server.log', `${line}\\n`, { mode: 0o600 });",
		"const server = http.createServer((req, res) => { log(`request ${req.method} ${req.url}`); res.end('fixture\\n'); });",
		"let stopping = false;",
		"const stop = (reason) => { if (stopping) return; stopping = true; log(`stopping ${reason}`);",
		"  server.close(() => { log('closed'); process.exit(0); }); server.closeAllConnections?.(); };",
		"process.once('SIGTERM', () => stop('SIGTERM')); process.once('SIGINT', () => stop('SIGINT'));",
		`setTimeout(() => stop('deadline'), ${SERVER_TIMEOUT_MS}).unref();`,
		"server.listen(0, '127.0.0.1', () => { const addr = server.address();",
		"  if (!addr || typeof addr === 'string') throw new Error('loopback listen failed');",
		"  log(`listening ${addr.port}`); });",
	].join("\n");
}

function fixtureEnvironment(fixture: Fixture): NodeJS.ProcessEnv {
	return {
		ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
		PATH: `/opt/homebrew/bin:${process.env.PATH ?? "/usr/bin:/bin"}`,
		HOME: fixture.home,
		TMPDIR: fixture.temp,
		PHI_HOME: fixture.config,
		LANG: "en_US.UTF-8",
		CLAUDE_CODE_EFFORT_LEVEL: "low",
		CLAUDE_CODE_MAX_OUTPUT_TOKENS: OUTPUT_TOKENS,
		CLAUDE_CODE_MAX_RETRIES: "0",
	};
}

async function waitForServerStop(fixture: Fixture, deadline: number): Promise<FixtureServerStopEvidence> {
	let log = "";
	while (Date.now() < deadline) {
		log = await readFile(join(fixture.project, "server.log"), "utf8").catch(() => "");
		const evidence = inspectFixtureServerStop(log);
		if (evidence.closed) return evidence;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
	}
	log = await readFile(join(fixture.project, "server.log"), "utf8").catch(() => log);
	return inspectFixtureServerStop(log);
}

function summary(controls: Controls, budget: number, costs: QueryCostLedger): string {
	const combined = combinedQueryCost(costs);
	return Object.entries({
		...controls,
		combinedCapUsd: budget.toFixed(4),
		initialQueryCostUsd: costs.initial?.toFixed(6) ?? "not-observed",
		resumedQueryCostUsd: costs.resumed?.toFixed(6) ?? "not-observed",
		combinedTotalCostUsd: combined?.toFixed(6) ?? "not-observed",
	})
		.map(([key, value]) => `${key}=${value}`).join("; ");
}
async function main(): Promise<void> {
	const totalBudget = validateLiveInvocation(process.env, process.argv.slice(2));
	const initialBudget = totalBudget * INITIAL_SHARE;
	const resumeBudget = totalBudget - initialBudget;
	const controls: Controls = {
		firstPartyRoute: false, nativeEdit: false, serverListening: false, registeredBackgroundTask: false,
		nativeTaskStopNotificationObserved: false, nativeServerStopProven: false, cleanupTaskStopAttempted: false,
		cleanupTaskStopNotificationObserved: false, serverClosedObserved: false, serverStopReason: "unknown",
		continuedInput: false, checkpointPreview: false, sessionResumed: false, workflowChildStopClaimed: false,
		deniedToolActions: 0, queryTerminationObserved: false, naturalDeadlineTermination: false, timedOut: false,
	};
	const fixture = await createFixture();
	const env = fixtureEnvironment(fixture);
	const sessions: Session[] = [];
	const initial: Events = { messages: [], errors: [] };
	const resumed: Events = { messages: [], errors: [] };
	let initialSession: Session | undefined;
	let sessionId: string | undefined;
	let taskId: string | undefined;
	let queryStarted = false;
	let failed = false;
	let failure: unknown;
	const costs: QueryCostLedger = {};
	const deadline = Date.now() + TOTAL_TIMEOUT_MS;
	const start = (options: Options, events: Events, query: QueryKind): Session => {
		const session = startSession(options, {
			onMessage(message) {
				events.messages.push(message);
				recordQueryCost(costs, query, observedResultTotalCostUsd(message));
			},
			onError(error) { events.errors.push(error); },
		});
		queryStarted = true;
		sessions.push(session);
		return session;
	};

	try {
		const options = fixtureOptions(fixture, env, controls, initialBudget);
		sessionId = options.sessionId;
		assert.ok(sessionId);
		const session = initialSession = start(options, initial, "initial");
		const init = await withDeadline(session.ready, deadline, "initial SDK initialization", session);
		assert.equal(initial.messages.some((message) => asRecord(message)?.type === "user"), false);
		assert.equal(init.account.apiProvider, "firstParty");
		assert.equal(init.account.apiKeySource, "ANTHROPIC_API_KEY");
		controls.firstPartyRoute = true;

		const marker = `phi-controls-resume-${randomUUID()}`;
		const firstId = randomUUID();
		session.send(userMessage([
			"Use only native Read, Edit, and Bash tools in this synthetic project.",
			`Read ${fixture.target}. Then use Edit once to replace before with after.`,
			`Run exactly 'node server.js' with run_in_background=true and timeout=${SERVER_TIMEOUT_MS}.`,
			"Run no other command. Change no other file.",
			`Remember this marker: ${marker}. Reply only: ready.`,
		].join("\n"), firstId));
		const first = await waitFor(() => resultFor(initial.messages, firstId), initial, deadline, "initial native controls turn", session);
		assert.equal(first.is_error, false);
		assert.equal(first.subtype, "success");
		assertPinnedModelUsage(first.modelUsage);
		recordQueryCost(costs, "initial", first.total_cost_usd);
		assert.ok(first.total_cost_usd <= initialBudget);
		assert.equal(findToolUse(initial.messages, "Edit").length, 1);
		assert.equal(await readFile(fixture.target, "utf8"), "after\n");
		controls.nativeEdit = true;

		const bash = findToolUse(initial.messages, "Bash").find((use) => use.input.command === "node server.js");
		assert.ok(bash);
		const started = await waitFor(() => taskStarted(initial.messages, bash.id), initial, deadline, "registered Bash task", session);
		taskId = typeof started.task_id === "string" ? started.task_id : undefined;
		assert.ok(taskId);
		assert.equal(started.task_type, "local_bash");
		assert.equal(started.is_backgrounded, true);
		controls.registeredBackgroundTask = true;
		await waitFor(async () => {
			const log = await readFile(join(fixture.project, "server.log"), "utf8").catch(() => "");
			return log.includes("listening ") ? true : undefined;
		}, initial, deadline, "loopback server listening log", session);
		controls.serverListening = true;
		assert.ok(isBackgroundTaskActive(initial.messages, taskId));

		const preview = await withDeadline(session.query.rewindFiles(firstId, { dryRun: true }), deadline,
			"native checkpoint dry-run preview", session);
		assert.equal(preview.canRewind, true);
		const changed = preview.filesChanged ?? [];
		const changedTargets = await Promise.all(changed.map((path) =>
			isFixtureCheckpointPath(fixture.project, fixture.target, path)));
		assert.ok(changedTargets.some(Boolean));
		assert.ok(changedTargets.every(Boolean));
		assert.equal(await readFile(fixture.target, "utf8"), "after\n");
		controls.checkpointPreview = true;

		const nextId = randomUUID();
		session.send(userMessage("Reply only: continuation accepted.", nextId));
		const continued = await waitFor(() => resultFor(initial.messages, nextId), initial, deadline,
			"continued input while Bash task remains active", session);
		assert.equal(continued.is_error, false);
		assertPinnedModelUsage(continued.modelUsage);
		recordQueryCost(costs, "initial", continued.total_cost_usd);
		assert.ok(continued.total_cost_usd <= initialBudget);
		assert.ok(isBackgroundTaskActive(initial.messages, taskId));
		assert.ok(costs.initial !== undefined, "initial query must report a cumulative cost estimate");
		assert.ok(costs.initial <= initialBudget, "initial query cumulative cost must stay within its allocation");
		controls.continuedInput = true;

		await withDeadline(session.query.stopTask(taskId), deadline, "public stopTask for registered Bash task", session);
		await waitFor(() => taskStopped(initial.messages, taskId!), initial, deadline,
			"actual stopped notification for registered Bash task", session);
		controls.nativeTaskStopNotificationObserved = true;
		const stopEvidence = await waitForServerStop(fixture, Math.min(deadline, Date.now() + SERVER_TIMEOUT_MS));
		controls.serverClosedObserved = stopEvidence.closed;
		controls.serverStopReason = stopEvidence.reason;
		controls.naturalDeadlineTermination = stopEvidence.reason === "deadline";
		controls.nativeServerStopProven = controls.nativeTaskStopNotificationObserved &&
			stopEvidence.closed && stopEvidence.reason === "signal";
		assert.ok(controls.nativeServerStopProven,
			"native stopTask must signal and close the fixture server before its natural deadline");
		const closed = await closeSession(session, CLOSE_TIMEOUT_MS, "initial query close");
		assert.ok(closed.terminated);
		assert.equal(closed.error, undefined);

		const resumeOptions = fixtureOptions(fixture, env, controls, resumeBudget, sessionId);
		const resumedSession = start(resumeOptions, resumed, "resumed");
		const resumedInit = await withDeadline(resumedSession.ready, deadline, "resumed SDK initialization", resumedSession);
		assert.equal(resumedInit.account.apiProvider, "firstParty");
		assert.equal(resumedInit.account.apiKeySource, "ANTHROPIC_API_KEY");
		const resumeId = randomUUID();
		resumedSession.send(userMessage("Return only the marker I asked you to remember in the earlier conversation. Use no tools.", resumeId));
		const resumedResult = await waitFor(() => resultFor(resumed.messages, resumeId), resumed, deadline,
			"resumed session result", resumedSession);
		assert.equal(resumedResult.session_id, sessionId);
		assert.equal(resumedResult.is_error, false);
		assert.equal(resumedResult.subtype, "success");
		assertPinnedModelUsage(resumedResult.modelUsage);
		assert.ok(resumedResult.result.includes(marker));
		recordQueryCost(costs, "resumed", resumedResult.total_cost_usd);
		assert.ok(resumedResult.total_cost_usd <= resumeBudget);
		assert.ok(costs.resumed !== undefined, "resumed query must report a cumulative cost estimate");
		assert.ok(costs.resumed <= resumeBudget, "resumed query cumulative cost must stay within its allocation");
		const combined = combinedQueryCost(costs);
		assert.ok(combined !== undefined, "both query cost estimates are required for the combined ledger");
		assert.ok(combined <= totalBudget, "combined initial and resumed costs must stay within the total cap");
		controls.sessionResumed = true;
	} catch (error) {
		failed = true;
		failure = error;
		controls.timedOut = error instanceof Error && /timed out/i.test(error.message);
	} finally {
		if (taskId && initialSession && !controls.nativeTaskStopNotificationObserved) {
			controls.cleanupTaskStopAttempted = true;
			try {
				await withDeadline(initialSession.query.stopTask(taskId), Date.now() + CLOSE_TIMEOUT_MS, "cleanup stopTask", initialSession);
				await waitFor(() => taskStopped(initial.messages, taskId!), initial, Date.now() + CLOSE_TIMEOUT_MS,
					"cleanup stopped notification", initialSession);
				controls.cleanupTaskStopNotificationObserved = true;
			} catch { /* Query close below terminates the CLI and its task processes. */ }
		}
		const outcomes = await Promise.all(sessions.slice().reverse().map((session) =>
			closeSession(session, CLOSE_TIMEOUT_MS, "final query cleanup")));
		controls.queryTerminationObserved = outcomes.every((outcome) => outcome.terminated);
		const serverLog = await readFile(join(fixture.project, "server.log"), "utf8").catch(() => "");
		const serverWasListening = controls.serverListening || serverLog.includes("listening ");
		const finalStopEvidence = serverWasListening
			? await waitForServerStop(fixture, Date.now() + SERVER_TIMEOUT_MS + 1_000)
			: inspectFixtureServerStop(serverLog);
		controls.serverClosedObserved ||= finalStopEvidence.closed;
		if (controls.serverStopReason === "unknown" || !controls.serverClosedObserved) {
			controls.serverStopReason = finalStopEvidence.reason;
		}
		controls.naturalDeadlineTermination ||= finalStopEvidence.reason === "deadline";
		if (!controls.queryTerminationObserved || outcomes.some((outcome) => outcome.error) ||
			(serverWasListening && !controls.serverClosedObserved)) {
			failed = true;
			failure ??= new Error("Fixture cleanup did not confirm query and bounded server termination");
		}
		if (failed && queryStarted) {
			try {
				await writeLiveFailureTrace(fixture.root, initial.messages, resumed.messages, process.env.ANTHROPIC_API_KEY);
			} catch (error) { failure = new AggregateError([failure, error], "Private failure trace write failed"); }
		}
		const cleanupError = await cleanupLiveFixture(fixture.root, {
			scenarioFailed: failed,
			nativeScenarioStarted: queryStarted,
			queriesTerminated: controls.queryTerminationObserved,
			expectedTripwireFailure: false,
		});
		if (cleanupError) { failed = true; failure ??= cleanupError; }
		if (failed) {
			const stderr = sessions.map((session) => session.stderr).filter(Boolean).join("\n");
			const safeStderr = formatErrorText(stderr, process.env.ANTHROPIC_API_KEY).slice(0, 900);
			const diagnostic = safeStderr ? new Error(`${String(failure)}; SDK stderr: ${safeStderr}`, { cause: failure }) : failure;
			console.error(formatLiveFailureDiagnostic(diagnostic, {
				latestObservedTotalCostUsd: combinedQueryCost(costs),
				cleanupTerminationObserved: controls.queryTerminationObserved,
				selectedApiKey: process.env.ANTHROPIC_API_KEY,
			}));
			console.error(`Native SDK controls evidence; ${summary(controls, totalBudget, costs)}`);
			if (queryStarted) console.error(`Private native SDK failure artifacts retained under ${fixture.root}`);
			process.exitCode = process.exitCode || 1;
		}
	}
	if (!failed) console.log(`Native SDK controls fixture completed; ${summary(controls, totalBudget, costs)}`);
}

if (isMainModule()) {
	void main().catch((error: unknown) => {
		console.error(formatLiveFailureDiagnostic(error, { selectedApiKey: process.env.ANTHROPIC_API_KEY }));
		process.exitCode = error instanceof LiveRunRefusal ? 2 : 1;
	});
}
