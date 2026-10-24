import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { LiveRunRefusal, parseLiveBudget } from "./live.js";

const runner = join(dirname(fileURLToPath(import.meta.url)), "live.js");

test("live budget parser accepts the planned positive cap and rejects malformed arguments", () => {
	assert.equal(parseLiveBudget(["--max-budget-usd", "5"]), 5);
	assert.throws(() => parseLiveBudget([]), LiveRunRefusal);
	assert.throws(() => parseLiveBudget(["--max-budget-usd", "0"]), LiveRunRefusal);
	assert.throws(() => parseLiveBudget(["--max-budget-usd", "5", "--max-budget-usd", "6"]), LiveRunRefusal);
});

test(
	"live runner refuses missing opt-in, missing or invalid budget, and missing isolated fixture key before query import",
	() => {
		const baseEnvironment = { ...process.env };
		delete baseEnvironment.PHI_LIVE_TEST;
		delete baseEnvironment.ANTHROPIC_API_KEY;

		const cases = [
			{
				name: "missing opt-in",
				args: ["--max-budget-usd", "5"],
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
				name: "missing isolated fixture API key",
				args: ["--max-budget-usd", "5"],
				env: { ...baseEnvironment, PHI_LIVE_TEST: "1" },
				message: /requires ANTHROPIC_API_KEY/,
			},
		];

		for (const scenario of cases) {
			const result = spawnSync(process.execPath, [runner, ...scenario.args], {
				encoding: "utf8",
				env: scenario.env,
			});
			assert.equal(result.status, 2, `${scenario.name} must be refused with exit status 2`);
			assert.match(result.stderr, scenario.message, scenario.name);
			assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /sk-ant-[A-Za-z0-9_-]+/);
		}
	},
);
