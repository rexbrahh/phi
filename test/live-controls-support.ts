import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { HookCallback, Options } from "@anthropic-ai/claude-agent-sdk";
import { buildOptions, parseArgs } from "../src/config.js";

export const MODEL = "claude-haiku-5-5";
export const MAX_TURNS = 4;
export const OUTPUT_TOKENS = "1024";
export const SERVER_TIMEOUT_MS = 45_000;

export type Fixture = {
	root: string; project: string; home: string; config: string; temp: string; target: string;
};

export type Controls = {
	firstPartyRoute: boolean; nativeEdit: boolean; serverListening: boolean; registeredBackgroundTask: boolean;
	nativeTaskStopNotificationObserved: boolean; nativeServerStopProven: boolean; cleanupTaskStopAttempted: boolean;
	cleanupTaskStopNotificationObserved: boolean; serverClosedObserved: boolean; serverStopReason: "signal" | "deadline" | "unknown";
	continuedInput: boolean; checkpointPreview: boolean; sessionResumed: boolean; workflowChildStopClaimed: false;
	deniedToolActions: number; queryTerminationObserved: boolean; naturalDeadlineTermination: boolean; timedOut: boolean;
};

export type QueryKind = "initial" | "resumed";
export type QueryCostLedger = Partial<Record<QueryKind, number>>;

export type FixtureServerStopEvidence = {
	closed: boolean;
	reason: "signal" | "deadline" | "unknown";
};

export async function createCanonicalTempRoot(prefix: string): Promise<string> {
	const createdRoot = await mkdtemp(join(tmpdir(), prefix));
	try {
		return await realpath(createdRoot);
	} catch (error) {
		await rm(createdRoot, { recursive: true, force: true });
		throw error;
	}
}

export async function isFixtureCheckpointPath(project: string, target: string, reportedPath: string): Promise<boolean> {
	try {
		return await realpath(resolve(project, reportedPath)) === target;
	} catch {
		return false;
	}
}

export function recordQueryCost(ledger: QueryCostLedger, query: QueryKind, cost: number | undefined): void {
	if (cost !== undefined && Number.isFinite(cost)) ledger[query] = cost;
}

export function combinedQueryCost(ledger: QueryCostLedger): number | undefined {
	if (ledger.initial === undefined || ledger.resumed === undefined) return undefined;
	return ledger.initial + ledger.resumed;
}

export function inspectFixtureServerStop(log: string): FixtureServerStopEvidence {
	const closed = /(?:^|\n)closed(?:\r?\n|$)/.test(log);
	if (!closed) return { closed: false, reason: "unknown" };
	if (/^stopping SIG(?:TERM|INT)$/m.test(log)) return { closed: true, reason: "signal" };
	if (/^stopping deadline$/m.test(log)) return { closed: true, reason: "deadline" };
	return { closed: true, reason: "unknown" };
}

function fixtureHook(fixture: Fixture, controls: Pick<Controls, "deniedToolActions">): HookCallback {
	return async (hookInput) => {
		if (hookInput.hook_event_name !== "PreToolUse") return {};
		const input = asRecord(hookInput.tool_input) ?? {};
		const keysAllowed = (keys: string[]) => Reflect.ownKeys(input).every((key) => typeof key === "string" && keys.includes(key));
		const read = hookInput.tool_name === "Read" && keysAllowed(["file_path", "offset", "limit"]) &&
			resolve(String(input.file_path ?? "")) === fixture.target;
		const edit = hookInput.tool_name === "Edit" &&
			keysAllowed(["file_path", "old_string", "new_string", "replace_all"]) &&
			resolve(String(input.file_path ?? "")) === fixture.target &&
			input.old_string === "before" && input.new_string === "after" && input.replace_all !== true;
		const server = hookInput.tool_name === "Bash" &&
			keysAllowed(["command", "description", "timeout", "run_in_background"]) &&
			input.command === "node server.js" && input.run_in_background === true &&
			input.timeout === SERVER_TIMEOUT_MS &&
			(typeof input.description === "undefined" ||
				(typeof input.description === "string" && input.description.length <= 80));
		if (read || edit || server) {
			return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
		}
		controls.deniedToolActions += 1;
		return {
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason: "The isolated fixture denied an unlisted tool action.",
			},
		};
	};
}

export function fixtureOptions(
	fixture: Fixture,
	env: NodeJS.ProcessEnv,
	controls: Pick<Controls, "deniedToolActions">,
	budget: number,
	resume?: string,
): Options {
	const args = ["--cwd", fixture.project, "--model", MODEL, "--permission-mode", "acceptEdits", "--max-budget-usd",
		String(budget), ...(resume ? ["--resume", resume] : [])];
	const options = buildOptions(parseArgs(args, env), {
		hooks: { PreToolUse: [{ timeout: 10, hooks: [fixtureHook(fixture, controls)] }] },
		onElicitation: async () => ({ action: "decline" }),
	}, env);
	Object.assign(options, {
		model: MODEL,
		effort: "low",
		thinking: { type: "adaptive" },
		maxTurns: MAX_TURNS,
		tools: ["Bash", "Edit", "Read"],
		settingSources: [],
		mcpServers: {},
		strictMcpConfig: true,
		plugins: [],
		skills: [],
		enableFileCheckpointing: true,
	});
	options.env = { ...options.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: OUTPUT_TOKENS, CLAUDE_CODE_MAX_RETRIES: "0" };
	assert.deepEqual(Object.keys(options.env).sort(), [
		"ANTHROPIC_API_KEY", "PATH", "HOME", "TMPDIR", "PHI_HOME", "LANG", "CLAUDE_CODE_EFFORT_LEVEL",
		"CLAUDE_CODE_MAX_OUTPUT_TOKENS", "CLAUDE_CODE_MAX_RETRIES", "CLAUDE_CONFIG_DIR",
		"CLAUDE_CODE_PLUGIN_CACHE_DIR", "CLAUDE_CODE_TMPDIR", "CLAUDE_AGENT_SDK_CLIENT_APP",
	].sort());
	assert.equal(options.cwd, fixture.project);
	assert.equal(options.model, MODEL);
	assert.equal(options.fallbackModel, undefined);
	assert.equal(options.maxTurns, MAX_TURNS);
	assert.equal(options.effort, "low");
	assert.deepEqual(options.thinking, { type: "adaptive" });
	assert.deepEqual(options.tools, ["Bash", "Edit", "Read"]);
	assert.deepEqual(options.settingSources, []);
	assert.equal(options.maxBudgetUsd, budget);
	assert.equal(options.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, OUTPUT_TOKENS);
	assert.equal(options.env.CLAUDE_CODE_MAX_RETRIES, "0");
	return options;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}
