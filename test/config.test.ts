import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ListSessionsOptions, SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import { ArgumentError, buildOptions, parseArgs, resolveLaunchOptions } from "../src/config.js";
import { startSession } from "../src/session.js";
import { FakeQueryHarness, optionCallbacks } from "./helpers/fake-query.js";

const testHome = join(tmpdir(), `phi-config-home-${process.pid}`);
const testEnvironment: NodeJS.ProcessEnv = { ...process.env, PHI_HOME: testHome };

function testLaunch(argv: string[] = []) {
	return parseArgs(argv, testEnvironment);
}

function sessionInfo(sessionId: string, lastModified: number): SDKSessionInfo {
	return { sessionId, summary: sessionId, lastModified };
}

test("invalid_args_do_not_create_query", () => {
	const fake = new FakeQueryHarness();
	const callbacks = { onMessage() {}, onError() {} };
	const invalidArguments: Array<{ argv: string[]; message: RegExp }> = [
		{ argv: ["--permission-mode", "bypassPermissions"], message: /dangerously-skip-permissions/ },
		{ argv: ["--cwd", "/path/that/does/not/exist"], message: /directory/ },
		{
			argv: ["--resume", "00000000-0000-4000-8000-000000000000", "--continue"],
			message: /mutually exclusive/,
		},
	];

	for (const invalid of invalidArguments) {
		assert.throws(() => {
			const parsed = testLaunch(invalid.argv);
			return startSession(buildOptions(parsed, optionCallbacks()), callbacks, fake.createQuery);
		}, invalid.message);
		assert.equal(fake.parameters, undefined);
	}
});

test("parseArgs resolves cwd and validates mutually exclusive resume modes", () => {
	const launch = testLaunch();
	assert.equal(launch.cwd, process.cwd());
	assert.equal(launch.home, testHome);
	assert.equal(launch.continue, false);
	assert.deepEqual(launch.pluginDirs, []);
	assert.throws(() => testLaunch(["--resume", "00000000-0000-4000-8000-000000000000", "--continue"]), /mutually exclusive/);
	assert.throws(() => testLaunch(["--cwd", "/path/that/does/not/exist"]), /directory/);
});

test("buildOptions preserves SDK defaults unless explicit settings are supplied", () => {
	const callbacks = optionCallbacks();
	const launch = testLaunch();
	const options = buildOptions(launch, callbacks);

	assert.equal(options.permissionMode, undefined);
	assert.equal(options.allowDangerouslySkipPermissions, undefined);
	assert.deepEqual(options.systemPrompt, { type: "preset", preset: "claude_code" });
	assert.deepEqual(options.tools, { type: "preset", preset: "claude_code" });
	assert.deepEqual(options.settingSources, ["user", "project", "local"]);
	assert.equal(options.skills, "all");
	assert.equal(options.includePartialMessages, true);
	assert.equal(options.forwardSubagentText, true);
	assert.equal(options.includeHookEvents, true);
	assert.equal(options.enableFileCheckpointing, true);
	assert.deepEqual(options.extraArgs, { "replay-user-messages": null });
	assert.equal(options.env?.PATH, process.env.PATH);
	assert.equal(options.env?.CLAUDE_CONFIG_DIR, launch.home);
	assert.equal(options.env?.CLAUDE_CODE_PLUGIN_CACHE_DIR, join(launch.home, "plugins", "cache"));
	assert.equal(options.env?.CLAUDE_AGENT_SDK_CLIENT_APP, "phi/0.1.0");
	assert.equal(options.canUseTool, callbacks.canUseTool);
	assert.equal(options.onElicitation, callbacks.onElicitation);
	assert.equal(options.hooks, callbacks.hooks);
	assert.equal(typeof options.sessionId, "string");
	assert.match(options.sessionId ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

test("buildOptions keeps injected credentials and inherited environment while pinning Phi roots", () => {
	const launch = testLaunch();
	const environment: NodeJS.ProcessEnv = {
		...process.env,
		ANTHROPIC_API_KEY: "synthetic-api-key",
		CLAUDE_CONFIG_DIR: "/legacy/claude-config",
		CLAUDE_CODE_PLUGIN_CACHE_DIR: "/legacy/plugin-cache",
		PATH: "/synthetic/bin",
	};
	const priorConfigRoot = process.env.CLAUDE_CONFIG_DIR;
	const options = buildOptions(launch, optionCallbacks(), environment);

	assert.equal(options.env?.ANTHROPIC_API_KEY, "synthetic-api-key");
	assert.equal(options.env?.PATH, "/synthetic/bin");
	assert.equal(options.env?.CLAUDE_CONFIG_DIR, launch.home);
	assert.equal(options.env?.CLAUDE_CODE_PLUGIN_CACHE_DIR, join(launch.home, "plugins", "cache"));
	assert.equal(process.env.CLAUDE_CONFIG_DIR, priorConfigRoot);
});

test("parseArgs resolves an explicit Phi home without treating legacy config as the write root", () => {
	const home = join(tmpdir(), `phi-config-override-${process.pid}`);
	const launch = parseArgs([], {
		PHI_HOME: home,
		CLAUDE_CONFIG_DIR: "/legacy/claude-config",
	});
	assert.equal(launch.home, home);
});

test("buildOptions applies an explicit bypass flag without inventing a default mode", () => {
	const options = buildOptions(
		testLaunch(["--dangerously-skip-permissions"]),
		optionCallbacks(),
	);
	assert.equal(options.permissionMode, undefined);
	assert.equal(options.allowDangerouslySkipPermissions, true);

	const bypass = buildOptions(
		testLaunch(["--permission-mode", "bypassPermissions", "--dangerously-skip-permissions"]),
		optionCallbacks(),
	);
	assert.equal(bypass.permissionMode, "bypassPermissions");
	assert.equal(bypass.allowDangerouslySkipPermissions, true);
});

test("buildOptions maps repeated plugin directories and optional launch values", () => {
	const options = buildOptions(
		testLaunch([
			"--model", "claude-sonnet-test",
			"--effort", "high",
			"--permission-mode", "plan",
			"--plugin-dir", ".claude/plugin-one",
			"--plugin-dir", ".claude/plugin-two",
			"--max-budget-usd", "12.5",
			"--resume", "00000000-0000-4000-8000-000000000000",
		]),
		optionCallbacks(),
	);

	assert.equal(options.model, "claude-sonnet-test");
	assert.equal(options.effort, "high");
	assert.equal(options.permissionMode, "plan");
	assert.equal(options.maxBudgetUsd, 12.5);
	assert.deepEqual(options.plugins, [
		{ type: "local", path: `${process.cwd()}/.claude/plugin-one` },
		{ type: "local", path: `${process.cwd()}/.claude/plugin-two` },
	]);
	assert.equal(options.resume, "00000000-0000-4000-8000-000000000000");
	assert.equal(options.sessionId, undefined);
});

test("resolveLaunchOptions selects the most recently modified session", async () => {
	const launch = testLaunch(["--continue"]);
	const sessions = [
		sessionInfo("00000000-0000-4000-8000-000000000001", 100),
		sessionInfo("00000000-0000-4000-8000-000000000003", 300),
		sessionInfo("00000000-0000-4000-8000-000000000002", 200),
	];

	const resolved = await resolveLaunchOptions(launch, async () => sessions);
	assert.equal(resolved.resume, "00000000-0000-4000-8000-000000000003");
	assert.equal(resolved.continue, false);
	const options = buildOptions(resolved, optionCallbacks());
	assert.equal(options.resume, "00000000-0000-4000-8000-000000000003");
	assert.equal(options.continue, undefined);
	assert.equal(options.sessionId, undefined);
});

test("resolveLaunchOptions lists only the launch directory without worktrees and includes programmatic sessions", async () => {
	const launch = testLaunch(["--continue"]);
	let receivedOptions: ListSessionsOptions | undefined;

	await resolveLaunchOptions(launch, async (options) => {
		receivedOptions = options;
		return [sessionInfo("00000000-0000-4000-8000-000000000001", 100)];
	});

	assert.deepEqual(receivedOptions, {
		dir: launch.cwd,
		includeWorktrees: false,
		includeProgrammatic: true,
	});
});

test("resolveLaunchOptions with no history prevents query creation", async () => {
	const fake = new FakeQueryHarness();
	const callbacks = { onMessage() {}, onError() {} };

	await assert.rejects(async () => {
		const resolved = await resolveLaunchOptions(testLaunch(["--continue"]), async () => []);
		startSession(buildOptions(resolved, optionCallbacks()), callbacks, fake.createQuery);
	}, (error: unknown) => error instanceof ArgumentError && /No resumable sessions/.test(error.message));
	assert.equal(fake.parameters, undefined);
});

test("resolveLaunchOptions lookup failure prevents query creation", async () => {
	const fake = new FakeQueryHarness();
	const callbacks = { onMessage() {}, onError() {} };
	const lookupFailure = new Error("session lookup unavailable");

	await assert.rejects(async () => {
		const resolved = await resolveLaunchOptions(testLaunch(["--continue"]), async () => {
			throw lookupFailure;
		});
		startSession(buildOptions(resolved, optionCallbacks()), callbacks, fake.createQuery);
	}, (error: unknown) => error === lookupFailure);
	assert.equal(fake.parameters, undefined);
});

test("resolveLaunchOptions leaves explicit resume and new launches unchanged", async () => {
	let lookupCount = 0;
	const listSessions = async () => {
		lookupCount += 1;
		return [];
	};

	const explicit = testLaunch(["--resume", "00000000-0000-4000-8000-000000000001"]);
	const resolvedExplicit = await resolveLaunchOptions(explicit, listSessions);
	assert.strictEqual(resolvedExplicit, explicit);
	const explicitOptions = buildOptions(resolvedExplicit, optionCallbacks());
	assert.equal(explicitOptions.resume, explicit.resume);
	assert.equal(explicitOptions.continue, undefined);
	assert.equal(explicitOptions.sessionId, undefined);

	const fresh = testLaunch();
	const resolvedFresh = await resolveLaunchOptions(fresh, listSessions);
	assert.strictEqual(resolvedFresh, fresh);
	const freshOptions = buildOptions(resolvedFresh, optionCallbacks());
	assert.equal(freshOptions.resume, undefined);
	assert.equal(freshOptions.continue, undefined);
	assert.match(freshOptions.sessionId ?? "", UUID_PATTERN);
	assert.equal(lookupCount, 0);
});

test("buildOptions refuses an unresolved continue request", () => {
	assert.throws(
		() => buildOptions(testLaunch(["--continue"]), optionCallbacks()),
		/--continue must be resolved to a session/,
	);
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
