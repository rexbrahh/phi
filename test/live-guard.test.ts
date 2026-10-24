import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { assertPinnedModelUsage, LIVE_MODEL, LiveRunRefusal, parseLiveBudget } from "./live.js";

type HarnessAssertions = {
	isExactFixtureTarget(repository: string, target: string, value: unknown): boolean;
	isNamedFixtureWorkflow(input: Record<string, unknown>, workflowName: string): boolean;
	isBackgroundTaskActive(messages: unknown[], taskId: string): boolean;
	hasSkillMarker(messages: unknown[], marker: string): boolean;
	withDeadline<T>(
		promise: Promise<T>,
		deadline: number,
		label: string,
		session: { done: Promise<void>; close(): Promise<void> },
	): Promise<T>;
	closeSession(
		session: { done: Promise<void>; close(): Promise<void> },
		timeoutMs: number,
		label: string,
	): Promise<{ terminated: boolean; error?: unknown }>;
};

const runner = join(dirname(fileURLToPath(import.meta.url)), "live.js");

test("live budget parser accepts the planned positive cap and rejects malformed arguments", () => {
	assert.equal(parseLiveBudget(["--max-budget-usd", "0.10"]), 0.10);
	assert.throws(() => parseLiveBudget([]), LiveRunRefusal);
	assert.throws(() => parseLiveBudget(["--max-budget-usd", "0"]), LiveRunRefusal);
	assert.throws(() => parseLiveBudget(["--max-budget-usd", "0.1001"]), /must not exceed \$0\.10/);
	assert.throws(() => parseLiveBudget(["--max-budget-usd", "0.01", "--max-budget-usd", "0.02"]), /exactly once/);
});

test("the runner and both native Workflow agents stay pinned to Haiku 5.5", () => {
	assert.equal(LIVE_MODEL, "claude-haiku-5-5");
	assert.doesNotThrow(() => assertPinnedModelUsage({ [LIVE_MODEL]: {} }));
	assert.doesNotThrow(() => assertPinnedModelUsage({ [`${LIVE_MODEL}-20261007`]: {} }));
	assert.throws(() => assertPinnedModelUsage({}), /must report per-model usage/);
	assert.throws(
		() => assertPinnedModelUsage({ [LIVE_MODEL]: {}, "claude-opus-5-5": {} }),
		/usage must stay on claude-haiku-5-5/,
	);

	const workflowPath = join(dirname(fileURLToPath(import.meta.url)), "../../test/live-workflow.js");
	const workflowSource = readFileSync(workflowPath, "utf8");
	assert.match(workflowSource, new RegExp(`const LIVE_MODEL = "${LIVE_MODEL}";`));
	assert.equal((workflowSource.match(/model: LIVE_MODEL/g) ?? []).length, 2);
});

test("tool assertions constrain Edit, Workflow, active tasks, and fixture skill evidence", async () => {
	const harness = await import("./live.js") as unknown as HarnessAssertions;
	const repository = "/tmp/phi-fixture";
	const target = join(repository, "target.txt");
	assert.equal(harness.isExactFixtureTarget(repository, target, target), true);
	assert.equal(harness.isExactFixtureTarget(repository, target, join(repository, "nested", "target.txt")), false);
	assert.equal(harness.isExactFixtureTarget(repository, target, "/tmp/other/target.txt"), false);

	assert.equal(harness.isNamedFixtureWorkflow({ name: "phi-live-acceptance" }, "phi-live-acceptance"), true);
	assert.equal(harness.isNamedFixtureWorkflow({ name: "phi-live-acceptance", script: "override" }, "phi-live-acceptance"), false);
	assert.equal(harness.isNamedFixtureWorkflow({ name: "phi-live-acceptance", scriptPath: "/tmp/override.js" }, "phi-live-acceptance"), false);
	assert.equal(harness.isNamedFixtureWorkflow({ name: "phi-live-acceptance", args: {} }, "phi-live-acceptance"), false);

	const membership = {
		type: "system",
		subtype: "background_tasks_changed",
		tasks: [{ task_id: "sibling-task" }],
	};
	assert.equal(harness.isBackgroundTaskActive([membership], "sibling-task"), true);
	for (const status of ["completed", "failed", "stopped"]) {
		assert.equal(harness.isBackgroundTaskActive([
			membership,
			{ type: "system", subtype: "task_notification", task_id: "sibling-task", status },
		], "sibling-task"), false, `${status} is terminal for a sibling task`);
	}
	assert.equal(
		harness.isBackgroundTaskActive([
			membership,
			{ ...membership, tasks: [] },
		], "sibling-task"),
		false,
	);
	assert.equal(harness.hasSkillMarker([
		{ type: "assistant", message: { content: [{ type: "text", text: "phi-live-skill-ok" }] } },
	], "phi-live-skill-ok"), true);
	assert.equal(harness.hasSkillMarker([], "phi-live-skill-ok"), false);
});

test("deadline closes the query and waits for iterator termination", async () => {
	const harness = await import("./live.js") as unknown as HarnessAssertions;
	let finishDone!: () => void;
	let closeCalls = 0;
	const session = {
		done: new Promise<void>((resolveDone) => {
			finishDone = resolveDone;
		}),
		close: async () => {
			closeCalls += 1;
			finishDone();
		},
	};
	const never = new Promise<never>(() => undefined);
	await assert.rejects(
		harness.withDeadline(never, Date.now() + 5, "fake query operation", session),
		/Timed out waiting for fake query operation/,
	);
	assert.equal(closeCalls, 1, "query close must be called on deadline");

	let unconfirmedCloseCalls = 0;
	const unconfirmedSession = {
		done: new Promise<void>(() => undefined),
		close: async () => {
			unconfirmedCloseCalls += 1;
		},
	};
	const outcome = await harness.closeSession(unconfirmedSession, 5, "unconfirmed fake query");
	assert.equal(unconfirmedCloseCalls, 1);
	assert.equal(outcome.terminated, false, "fixture cleanup must know when iterator termination was not observed");
});

test(
	"live runner refuses missing opt-in, missing or invalid budget, and missing isolated fixture key before query import",
	async () => {
		const testHome = mkdtempSync(join(tmpdir(), "phi-live-guard-"));
		const baseEnvironment = {
			PATH: "/opt/homebrew/bin:/usr/bin:/bin",
			HOME: testHome,
			TMPDIR: testHome,
			PHI_LIVE_TEST_QUERY_CREATION_TRIPWIRE: "1",
		};

		const cases = [
			{
				name: "missing opt-in",
				args: ["--max-budget-usd", "0.10"],
				env: { ...baseEnvironment },
				message: /PHI_LIVE_TEST=1/,
			},
			{
				name: "missing budget",
				args: [],
				env: { ...baseEnvironment, PHI_LIVE_TEST: "1" },
				message: /--max-budget-usd/,
			},
			{
				name: "zero budget",
				args: ["--max-budget-usd", "0"],
				env: { ...baseEnvironment, PHI_LIVE_TEST: "1" },
				message: /positive number/,
			},
			{
				name: "non-finite budget",
				args: ["--max-budget-usd", "Infinity"],
				env: { ...baseEnvironment, PHI_LIVE_TEST: "1" },
				message: /finite positive number/,
			},
			{
				name: "budget above fixture cap",
				args: ["--max-budget-usd", "0.1001"],
				env: { ...baseEnvironment, PHI_LIVE_TEST: "1" },
				message: /must not exceed \$0\.10/,
			},
			{
				name: "missing isolated fixture API key",
				args: ["--max-budget-usd", "0.10"],
				env: { ...baseEnvironment, PHI_LIVE_TEST: "1" },
				message: /requires ANTHROPIC_API_KEY/,
			},
		];

		try {
			for (const scenario of cases) {
				const result = spawnSync(process.execPath, [runner, ...scenario.args], {
					cwd: testHome,
					encoding: "utf8",
					env: scenario.env,
					timeout: 5_000,
					killSignal: "SIGKILL",
					maxBuffer: 64 * 1024,
				});
				assert.equal(result.error, undefined, `${scenario.name} subprocess must finish within five seconds`);
				assert.equal(result.status, 2, `${scenario.name} must be refused with exit status 2`);
				assert.match(result.stderr, scenario.message, scenario.name);
				assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /sk-ant-[A-Za-z0-9_-]+/);
			}

			const tripwire = spawnSync(process.execPath, [runner, "--max-budget-usd", "0.10"], {
				cwd: testHome,
				encoding: "utf8",
				env: {
					...baseEnvironment,
					PHI_LIVE_TEST: "1",
					ANTHROPIC_API_KEY: "offline-tripwire-only",
				},
				timeout: 5_000,
				killSignal: "SIGKILL",
				maxBuffer: 64 * 1024,
			});
			assert.equal(tripwire.error, undefined, "query creation tripwire subprocess must finish within five seconds");
			assert.equal(tripwire.status, 86, "query tripwire must stop before the SDK query function runs");
			assert.match(tripwire.stderr, /query-creation tripwire blocked/i);
			assert.doesNotMatch(`${tripwire.stdout}\n${tripwire.stderr}`, /offline-tripwire-only/);
		} finally {
			rmSync(testHome, { recursive: true, force: true });
		}
	},
);
