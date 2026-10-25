import assert from "node:assert/strict";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
	combinedQueryCost,
	createCanonicalTempRoot,
	fixtureOptions,
	inspectFixtureServerStop,
	isFixtureCheckpointPath,
	recordQueryCost,
	type Fixture,
	type QueryCostLedger,
} from "./live-controls-support.js";

test("canonical fixture roots bind SDK cwd and aliased checkpoint paths to the target", async () => {
	const root = await createCanonicalTempRoot("phi-live-controls-support-");
	const fixture: Fixture = {
		root,
		project: join(root, "synthetic-project"),
		home: join(root, "synthetic-home"),
		config: join(root, "synthetic-config"),
		temp: join(root, "synthetic-temp"),
		target: join(root, "synthetic-project", "target.txt"),
	};
	try {
		await Promise.all([fixture.project, fixture.home, fixture.config, fixture.temp].map((path) =>
			mkdir(path, { recursive: true, mode: 0o700 })));
		await writeFile(fixture.target, "before\n", { mode: 0o600 });
		const aliasProject = join(root, "project-alias");
		await symlink(fixture.project, aliasProject, "dir");
		const env: NodeJS.ProcessEnv = {
			ANTHROPIC_API_KEY: "offline-fixture-value",
			PATH: "/opt/homebrew/bin:/usr/bin:/bin",
			HOME: fixture.home,
			TMPDIR: fixture.temp,
			PHI_HOME: fixture.config,
			LANG: "en_US.UTF-8",
			CLAUDE_CODE_EFFORT_LEVEL: "low",
			CLAUDE_CODE_MAX_OUTPUT_TOKENS: "1024",
			CLAUDE_CODE_MAX_RETRIES: "0",
		};
		const options = fixtureOptions(fixture, env, { deniedToolActions: 0 }, 0.01);

		assert.equal(options.cwd, fixture.project);
		assert.equal(await isFixtureCheckpointPath(fixture.project, fixture.target, "target.txt"), true);
		assert.equal(await isFixtureCheckpointPath(fixture.project, fixture.target, join(aliasProject, "target.txt")), true);
		assert.equal(await isFixtureCheckpointPath(fixture.project, fixture.target, "outside.txt"), false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("query cost ledger retains each latest estimate and sums both queries", () => {
	const costs: QueryCostLedger = {};
	recordQueryCost(costs, "initial", 0.01);
	recordQueryCost(costs, "resumed", 0.02);
	recordQueryCost(costs, "initial", 0.03);
	recordQueryCost(costs, "resumed", 0.04);
	recordQueryCost(costs, "initial", Number.NaN);

	assert.deepEqual(costs, { initial: 0.03, resumed: 0.04 });
	assert.equal(combinedQueryCost(costs), 0.07);
	assert.equal(combinedQueryCost({ initial: 0.03 }), undefined);
});

test("server stop evidence distinguishes a signal from its natural deadline", () => {
	assert.deepEqual(inspectFixtureServerStop("stopping SIGTERM\nclosed\n"), { closed: true, reason: "signal" });
	assert.deepEqual(inspectFixtureServerStop("stopping deadline\nclosed\n"), { closed: true, reason: "deadline" });
	assert.deepEqual(inspectFixtureServerStop("closed\n"), { closed: true, reason: "unknown" });
	assert.deepEqual(inspectFixtureServerStop("listening 4321\n"), { closed: false, reason: "unknown" });
});
