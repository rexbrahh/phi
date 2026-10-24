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
