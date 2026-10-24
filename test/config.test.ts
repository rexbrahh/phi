import assert from "node:assert/strict";
import { test } from "node:test";
import { buildOptions, parseArgs } from "../src/config.js";
import { startSession } from "../src/session.js";
import { FakeQueryHarness, optionCallbacks } from "./helpers/fake-query.js";

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
			const parsed = parseArgs(invalid.argv);
			return startSession(buildOptions(parsed, optionCallbacks()), callbacks, fake.createQuery);
		}, invalid.message);
		assert.equal(fake.parameters, undefined);
	}
});

test("parseArgs resolves cwd and validates mutually exclusive resume modes", () => {
	const launch = parseArgs([]);
	assert.equal(launch.cwd, process.cwd());
	assert.equal(launch.continue, false);
	assert.deepEqual(launch.pluginDirs, []);
	assert.throws(() => parseArgs(["--resume", "00000000-0000-4000-8000-000000000000", "--continue"]), /mutually exclusive/);
	assert.throws(() => parseArgs(["--cwd", "/path/that/does/not/exist"]), /directory/);
});

test("buildOptions preserves SDK defaults unless explicit settings are supplied", () => {
	const callbacks = optionCallbacks();
	const options = buildOptions(parseArgs([]), callbacks);

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
	assert.equal(options.env?.CLAUDE_CONFIG_DIR, process.env.CLAUDE_CONFIG_DIR);
	assert.equal(options.env?.CLAUDE_AGENT_SDK_CLIENT_APP, "phi/0.1.0");
	assert.equal(options.canUseTool, callbacks.canUseTool);
	assert.equal(options.onElicitation, callbacks.onElicitation);
	assert.equal(options.hooks, callbacks.hooks);
	assert.equal(typeof options.sessionId, "string");
	assert.match(options.sessionId ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

test("buildOptions applies an explicit bypass flag without inventing a default mode", () => {
	const options = buildOptions(
		parseArgs(["--dangerously-skip-permissions"]),
		optionCallbacks(),
	);
	assert.equal(options.permissionMode, undefined);
	assert.equal(options.allowDangerouslySkipPermissions, true);

	const bypass = buildOptions(
		parseArgs(["--permission-mode", "bypassPermissions", "--dangerously-skip-permissions"]),
		optionCallbacks(),
	);
	assert.equal(bypass.permissionMode, "bypassPermissions");
	assert.equal(bypass.allowDangerouslySkipPermissions, true);
});

test("buildOptions maps repeated plugin directories and optional launch values", () => {
	const options = buildOptions(
		parseArgs([
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
