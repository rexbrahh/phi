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
