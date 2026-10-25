import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
	assertPinnedModelUsage,
	FIXED_WORKFLOW_MONITOR_INPUTS,
	LIVE_MODEL,
	LiveRunRefusal,
	parseLiveBudget,
} from "./live.js";

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
	waitFor<T>(
		read: () => T | undefined | Promise<T | undefined>,
		events: { messages: unknown[]; errors: unknown[] },
		deadline: number,
		label: string,
		session: { done: Promise<void>; close(): Promise<void> },
	): Promise<T>;
}

type DiagnosticHarness = {
	formatLiveFailureDiagnostic(
		error: unknown,
		options?: {
			latestObservedTotalCostUsd?: number;
			cleanupTerminationObserved?: boolean;
			cleanupErrors?: unknown[];
			permissionEvidence?: PermissionEvidence;
			selectedApiKey?: string;
		},
	): string;
	observedResultTotalCostUsd(message: unknown): number | undefined;
};

type NativeAgentStopHarness = {
	stopNativeAgentTask?: (
		nativeTaskId: string | undefined,
		stopTask: (taskId: string) => Promise<unknown>,
	) => Promise<string>;
};

type PermissionEvidence = {
	deniedActionCount: number;
	denials: Array<{ toolName: string; inputKeys: string; reason: string }>;
	traceDenials?: Array<{ toolName: string; input: Record<string, unknown>; reason: string; toolUseID?: string }>;
};

type FixtureCallbackHarness = {
	fixtureCallbacks(
		fixture: { repository: string; toolEditTarget: string; workflowScript: string },
		permissionEvidence: PermissionEvidence,
		selectedApiKey?: string,
	): {
		canUseTool: NonNullable<import("@anthropic-ai/claude-agent-sdk").Options["canUseTool"]>;
	};
};

type FixtureCleanupHarness = {
	cleanupLiveFixture?: (
		root: string,
		options: {
			scenarioFailed: boolean;
			nativeScenarioStarted: boolean;
			queriesTerminated: boolean;
			expectedTripwireFailure: boolean;
		},
		reportRetainedRoot?: (root: string) => void,
	) => Promise<unknown | undefined>;
};

const runner = join(dirname(fileURLToPath(import.meta.url)), "live.js");
const workflowScriptPath = join(dirname(fileURLToPath(import.meta.url)), "../../test/live-workflow.js");
const workflowScript = readFileSync(workflowScriptPath, "utf8");

test("native control hooks append without replacing existing SDK hook callbacks", async () => {
	type HookMatcher = { matcher?: string; hooks: unknown[] };
	type HookSet = Record<string, HookMatcher[]>;
	const live = await import("./live.js") as unknown as {
		mergeHookMatchers?: (existing: HookSet | undefined, additions: HookSet) => HookSet;
	};
	assert.equal(typeof live.mergeHookMatchers, "function", "SDK hook matcher merge helper must exist");
	const fixtureHook = async () => ({});
	const controlHook = async () => ({});
	const existing: HookSet = {
		PostToolUse: [{ matcher: "Edit", hooks: [fixtureHook] }],
		PreToolUse: [{ matcher: "Bash", hooks: [fixtureHook] }],
	};
	const merged = live.mergeHookMatchers!(existing, {
		PreToolUse: [{ matcher: "Monitor", hooks: [controlHook] }],
		SubagentStart: [{ hooks: [controlHook] }],
	});

	assert.equal(merged.PostToolUse?.[0]?.hooks[0], fixtureHook);
	assert.equal(merged.PreToolUse?.[0]?.hooks[0], fixtureHook);
	assert.equal(merged.PreToolUse?.[1]?.hooks[0], controlHook);
	assert.equal(merged.SubagentStart?.[0]?.hooks[0], controlHook);
});

async function withCleanupFixture(run: (root: string) => Promise<void>): Promise<void> {
	const parent = mkdtempSync(join(tmpdir(), "phi-live-cleanup-test-"));
	const root = join(parent, "owned-fixture");
	mkdirSync(root, { mode: 0o700 });
	try {
		await run(root);
	} finally {
		rmSync(parent, { recursive: true, force: true });
	}
}

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

test("Workflow agent prompts match the fixed Monitor inputs", () => {
	const agentPrompts = [
		{
			inputName: "STOPPED_MONITOR_INPUT",
			label: "phi-live-agent-stopped",
			marker: "phi-live-agent-stopped",
			input: FIXED_WORKFLOW_MONITOR_INPUTS.stopped,
		},
		{
			inputName: "CONTINUED_MONITOR_INPUT",
			label: "phi-live-agent-continued",
			marker: "phi-live-agent-continued",
			input: FIXED_WORKFLOW_MONITOR_INPUTS.continued,
		},
	];

	for (const { inputName, label, marker, input } of agentPrompts) {
		const labelOffset = workflowScript.indexOf(`label: "${label}"`);
		assert.notEqual(labelOffset, -1, `${label} must remain in the Workflow fixture`);
		const callOffset = workflowScript.lastIndexOf("() => agent(", labelOffset);
		assert.notEqual(callOffset, -1, `${label} must remain a real Workflow agent`);
		const prompt = workflowScript.slice(callOffset, labelOffset);
		const inputOffset = workflowScript.indexOf(`const ${inputName} = {`);
		assert.notEqual(inputOffset, -1, `${label} must have a fixed Monitor input`);
		const inputEnd = workflowScript.indexOf("};", inputOffset);
		assert.notEqual(inputEnd, -1, `${label} Monitor input must be complete`);
		const inputDeclaration = workflowScript.slice(inputOffset, inputEnd + 2);
		assert.ok(inputDeclaration.includes(`description: "${input.description}"`));
		assert.ok(inputDeclaration.includes(`timeout_ms: ${input.timeout_ms}`));
		assert.ok(inputDeclaration.includes(`command: "${input.command}"`));
		assert.equal((inputDeclaration.match(/^\s*[A-Za-z_$][\w$]*\s*:/gm) ?? []).length, 3);
		assert.ok(prompt.includes(`JSON.stringify(${inputName})`), `${label} prompt must pass its exact Monitor input`);
		assert.ok(prompt.includes("Wait for the Monitor call to finish"));
		assert.ok(prompt.includes(`return only ${marker}`));
		assert.ok(prompt.includes("Do not use other tools or edit files"));
	}

	assert.doesNotMatch(workflowScript, /sleep 90|run_in_background|pgrep|ps -/);
});

test("failure diagnostics retain bounded nested causes and redact the selected key", async () => {
	const harness = await import("./live.js") as unknown as DiagnosticHarness;
	const syntheticKey = "offline-synthetic-key-nested";
	const failure = new Error("wait failed", {
		cause: new Error(`native callback rejected with ${syntheticKey}`),
	});
	const diagnostic = harness.formatLiveFailureDiagnostic(failure, {
		latestObservedTotalCostUsd: 0.125,
		cleanupTerminationObserved: true,
		selectedApiKey: syntheticKey,
	});

	assert.match(diagnostic, /Error: wait failed/);
	assert.match(diagnostic, /native callback rejected with \[redacted API key\]/);
	assert.match(diagnostic, /latest total_cost_usd=\$0\.1250 USD/);
	assert.match(diagnostic, /cleanup termination observed=yes/);
	assert.ok(diagnostic.length <= 1_200, "failure diagnostics must stay bounded");
	assert.equal(diagnostic.includes(syntheticKey), false);

	const longDiagnostic = harness.formatLiveFailureDiagnostic(new Error("x".repeat(5_000)), {
		latestObservedTotalCostUsd: 0.5,
		cleanupTerminationObserved: false,
	});
	assert.ok(longDiagnostic.length <= 1_200);
	assert.match(longDiagnostic, /latest total_cost_usd=\$0\.5000 USD/);
	assert.match(longDiagnostic, /cleanup termination observed=no/);
});

test("waitFor preserves callback errors as causes and reports them without the synthetic key", async () => {
	const harness = await import("./live.js") as unknown as HarnessAssertions & DiagnosticHarness;
	const syntheticKey = "offline-synthetic-key-callback";
	const callbackError = new Error(`native SDK callback failed with ${syntheticKey}`);
	let waitFailure: unknown;
	await assert.rejects(
		harness.waitFor(
			() => undefined,
			{ messages: [], errors: [callbackError] },
			Date.now() + 1_000,
			"callback result",
			{ done: Promise.resolve(), close: async () => undefined },
		),
		(error: unknown) => {
			waitFailure = error;
			return error instanceof Error && error.cause === callbackError;
		},
	);
	assert.ok(waitFailure instanceof Error);
	const diagnostic = harness.formatLiveFailureDiagnostic(waitFailure, {
		latestObservedTotalCostUsd: 0.25,
		cleanupTerminationObserved: true,
		selectedApiKey: syntheticKey,
	});
	assert.match(diagnostic, /SDK reported an error while waiting for callback result/);
	assert.match(diagnostic, /native SDK callback failed with \[redacted API key\]/);
	assert.equal(diagnostic.includes(syntheticKey), false);
});

test("cleanup diagnostics retain cleanup errors and report unobserved termination without the key", async () => {
	const harness = await import("./live.js") as unknown as DiagnosticHarness;
	const syntheticKey = "offline-synthetic-key-cleanup";
	const failure = new Error("fixture assertion failed", {
		cause: new Error(`nested failure with ${syntheticKey}`),
	});
	const diagnostic = harness.formatLiveFailureDiagnostic(failure, {
		cleanupTerminationObserved: false,
		cleanupErrors: [new Error(`query close failed with ${syntheticKey}`)],
		selectedApiKey: syntheticKey,
	});

	assert.match(diagnostic, /nested failure with \[redacted API key\]/);
	assert.match(diagnostic, /latest total_cost_usd=not observed/);
	assert.match(diagnostic, /cleanup termination observed=no/);
	assert.match(diagnostic, /cleanup error: Error: query close failed with \[redacted API key\]/);
	assert.equal(diagnostic.includes(syntheticKey), false);
});

test("result callbacks expose the latest cumulative SDK spend for failure diagnostics", async () => {
	const harness = await import("./live.js") as unknown as DiagnosticHarness;
	assert.equal(harness.observedResultTotalCostUsd({ type: "assistant" }), undefined);
	assert.equal(harness.observedResultTotalCostUsd({ type: "result", total_cost_usd: 0.375 }), 0.375);
	assert.equal(harness.observedResultTotalCostUsd({ type: "result", total_cost_usd: Number.NaN }), undefined);
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

test("native SDK Workflow callback allows only the fixed fixture script forms", async () => {
	const harness = await import("./live.js") as unknown as FixtureCallbackHarness;
	const permissionEvidence: PermissionEvidence = { deniedActionCount: 0, denials: [] };
	const callback = harness.fixtureCallbacks({
		repository: "/tmp/phi-live-fixture",
		toolEditTarget: "/tmp/phi-live-fixture/target.txt",
		workflowScript,
	}, permissionEvidence).canUseTool;
	const options = {
		signal: new AbortController().signal,
		toolUseID: "fixture-workflow-use",
		requestId: "fixture-workflow-request",
	};
	const input = { name: "phi-live-acceptance" };
	const immutableScriptInput = { ...input, script: workflowScript };
	const previousFieldPresenceGuardWouldReject = ["script", "scriptPath", "resumeFromRunId"]
		.some((key) => Object.hasOwn(immutableScriptInput, key));
	assert.equal(previousFieldPresenceGuardWouldReject, true);

	for (const acceptedInput of [input, { ...input, script: "" }, immutableScriptInput]) {
		const allowed = await callback("Workflow", acceptedInput, options);
		if (allowed?.behavior !== "allow") assert.fail("a fixed fixture Workflow form must be allowed");
		assert.equal(allowed.behavior, "allow");
		assert.deepEqual(allowed.updatedInput, acceptedInput);
	}
	assert.equal(permissionEvidence.deniedActionCount, 0);
	assert.equal(permissionEvidence.denials.length, 0);

	for (const { input: deniedInput, reason } of [
		{ input: { ...input, script: `${workflowScript}\n` }, reason: "workflow-input-not-allowlisted" },
		{ input: { name: "another-workflow" }, reason: "workflow-name-not-fixture" },
		{ input: { ...input, args: {} }, reason: "workflow-input-not-allowlisted" },
		{ input: { ...input, scriptPath: "/tmp/other-workflow.js" }, reason: "workflow-execution-override" },
		{ input: { ...input, resumeFromRunId: "another-run" }, reason: "workflow-execution-override" },
		{ input: { ...input, script: null }, reason: "workflow-input-not-allowlisted" },
		{ input: { ...input, script: undefined }, reason: "workflow-input-not-allowlisted" },
	]) {
		permissionEvidence.denials.length = 0;
		const denied = await callback("Workflow", deniedInput, options);
		if (denied?.behavior !== "deny") assert.fail("an unlisted Workflow form must be denied");
		assert.equal(denied.behavior, "deny");
		assert.deepEqual(permissionEvidence.denials.map(({ reason: actualReason }) => actualReason), [reason]);
	}
	assert.equal(permissionEvidence.deniedActionCount, 7);
});

test("native SDK Monitor callback allows only the fixed Workflow release waits", async () => {
	const harness = await import("./live.js") as unknown as FixtureCallbackHarness;
	const permissionEvidence: PermissionEvidence = { deniedActionCount: 0, denials: [] };
	const callback = harness.fixtureCallbacks({
		repository: "/tmp/phi-live-fixture",
		toolEditTarget: "/tmp/phi-live-fixture/target.txt",
		workflowScript,
	}, permissionEvidence).canUseTool;
	const callbackOptions = {
		signal: new AbortController().signal,
		toolUseID: "fixture-monitor-use",
		requestId: "fixture-monitor-request",
	};

	for (const acceptedInput of Object.values(FIXED_WORKFLOW_MONITOR_INPUTS)) {
		const allowed = await callback("Monitor", acceptedInput, callbackOptions);
		if (allowed?.behavior !== "allow") assert.fail("a fixed fixture Monitor wait must be allowed");
		assert.equal(allowed.behavior, "allow");
		assert.deepEqual(allowed.updatedInput, acceptedInput);
	}
	assert.deepEqual(permissionEvidence, { deniedActionCount: 0, denials: [] });

	const stopped = FIXED_WORKFLOW_MONITOR_INPUTS.stopped;
	const deniedInputs: Array<Record<string, unknown>> = [
		{ ...stopped, command: "sleep 1" },
		{ ...stopped, command: "ps -A" },
		{ ...stopped, command: "until pgrep -f phi-live-agent; do sleep 1; done" },
		{ ...stopped, command: "until [ -f /tmp/phi-live-agent.release ]; do sleep 1; done" },
		{ ...stopped, timeout_ms: stopped.timeout_ms + 1 },
		{ ...stopped, ws: { url: "ws://127.0.0.1" } },
		{ ...stopped, path: "/tmp/override" },
		{ ...stopped, script: "override" },
		{ ...stopped, env: { PATH: "/tmp" } },
		{ ...stopped, description: "Monitor an unrelated condition" },
	];
	for (const deniedInput of deniedInputs) {
		const denied = await callback("Monitor", deniedInput, callbackOptions);
		if (denied?.behavior !== "deny") assert.fail("an unlisted Monitor input must be denied");
		assert.equal(denied.behavior, "deny");
	}
	assert.equal(permissionEvidence.deniedActionCount, deniedInputs.length);
	assert.ok(permissionEvidence.denials.every(({ reason }) => reason === "monitor-input-not-allowlisted"));
});

test("failure diagnostics summarize only bounded denied tool names, input keys, and reasons", async () => {
	const harness = await import("./live.js") as unknown as DiagnosticHarness & FixtureCallbackHarness;
	const syntheticKey = "offline-synthetic-api-key-permission-summary";
	const secretValue = "PRIVATE_PERMISSION_INPUT_VALUE";
	const permissionEvidence: PermissionEvidence = { deniedActionCount: 0, denials: [] };
	const callback = harness.fixtureCallbacks({
		repository: "/tmp/phi-live-fixture",
		toolEditTarget: "/tmp/phi-live-fixture/target.txt",
		workflowScript,
	}, permissionEvidence, syntheticKey).canUseTool;

	const callbackOptions = {
		signal: new AbortController().signal,
		toolUseID: "fixture-bash-use",
		requestId: "fixture-bash-request",
	};
	const denied = await callback("Bash", {
		command: secretValue,
		[`private-${syntheticKey}`]: secretValue,
	}, callbackOptions);
	if (denied?.behavior !== "deny") assert.fail("an unlisted Bash command must be denied");
	assert.equal(denied.behavior, "deny");
	for (let index = 0; index < 4; index += 1) {
		await callback("Bash", { command: `private-command-${index}` }, callbackOptions);
	}
	assert.equal(permissionEvidence.deniedActionCount, 5);
	assert.equal(permissionEvidence.denials.length, 3, "permission evidence retains only three denied actions");
	assert.equal(permissionEvidence.traceDenials?.length, 3, "private callback evidence retains only three denied actions");

	const diagnostic = harness.formatLiveFailureDiagnostic(new Error("fixture failed"), {
		permissionEvidence,
		selectedApiKey: syntheticKey,
	});
	assert.match(diagnostic, /permissionDenials=/);
	assert.match(diagnostic, /Bash/);
	assert.match(diagnostic, /command/);
	assert.match(diagnostic, /not-allowlisted/);
	assert.match(diagnostic, /2 more omitted/);
	assert.match(diagnostic, /\[redacted API key\]/);
	assert.equal(diagnostic.includes(secretValue), false);
	assert.equal(diagnostic.includes(syntheticKey), false);
	assert.ok(diagnostic.length <= 1_200);
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

test("Workflow child stop requires a registered native task handle", async () => {
	const harness = await import("./live.js") as unknown as NativeAgentStopHarness;
	assert.equal(typeof harness.stopNativeAgentTask, "function", "native child stop guard must be available offline");
	const stopTaskCalls: string[] = [];
	const stopTask = async (taskId: string): Promise<void> => {
		stopTaskCalls.push(taskId);
	};

	await assert.rejects(
		harness.stopNativeAgentTask!(undefined, stopTask),
		/Missing native control: no registered native task handle is available/,
	);
	assert.deepEqual(stopTaskCalls, [], "missing native control must fail before calling stopTask");

	await harness.stopNativeAgentTask!("registered-native-task", stopTask);
	assert.deepEqual(stopTaskCalls, ["registered-native-task"], "a registered task ID must be passed to stopTask");
});

test("successful fixture cleanup removes its owned root", async () => {
	const harness = await import("./live.js") as unknown as FixtureCleanupHarness;
	assert.equal(typeof harness.cleanupLiveFixture, "function", "fixture cleanup policy must be available for offline coverage");
	await withCleanupFixture(async (root) => {
		const retainedRoots: string[] = [];
		const error = await harness.cleanupLiveFixture!(root, {
			scenarioFailed: false,
			nativeScenarioStarted: true,
			queriesTerminated: true,
			expectedTripwireFailure: false,
		}, (retainedRoot) => retainedRoots.push(retainedRoot));

		assert.equal(error, undefined);
		assert.equal(existsSync(root), false);
		assert.deepEqual(retainedRoots, []);
	});
});

test("failure before native query creation removes its fixture root", async () => {
	const harness = await import("./live.js") as unknown as FixtureCleanupHarness;
	assert.equal(typeof harness.cleanupLiveFixture, "function", "fixture cleanup policy must be available for offline coverage");
	await withCleanupFixture(async (root) => {
		const retainedRoots: string[] = [];
		const error = await harness.cleanupLiveFixture!(root, {
			scenarioFailed: true,
			nativeScenarioStarted: false,
			queriesTerminated: true,
			expectedTripwireFailure: false,
		}, (retainedRoot) => retainedRoots.push(retainedRoot));

		assert.equal(error, undefined);
		assert.equal(existsSync(root), false);
		assert.deepEqual(retainedRoots, []);
	});
});

test("real scenario failure retains the private fixture root and reports its pointer", async () => {
	const harness = await import("./live.js") as unknown as FixtureCleanupHarness;
	assert.equal(typeof harness.cleanupLiveFixture, "function", "fixture cleanup policy must be available for offline coverage");
	await withCleanupFixture(async (root) => {
		chmodSync(root, 0o755);
		const retainedRoots: string[] = [];
		const error = await harness.cleanupLiveFixture!(root, {
			scenarioFailed: true,
			nativeScenarioStarted: true,
			queriesTerminated: true,
			expectedTripwireFailure: false,
		}, (retainedRoot) => retainedRoots.push(retainedRoot));

		assert.equal(error, undefined);
		assert.equal(existsSync(root), true);
		assert.equal(statSync(root).mode & 0o777, 0o700);
		assert.deepEqual(retainedRoots, [root]);
	});
});

test("expected query-creation tripwire failure removes its fixture root", async () => {
	const harness = await import("./live.js") as unknown as FixtureCleanupHarness;
	assert.equal(typeof harness.cleanupLiveFixture, "function", "fixture cleanup policy must be available for offline coverage");
	await withCleanupFixture(async (root) => {
		const retainedRoots: string[] = [];
		const error = await harness.cleanupLiveFixture!(root, {
			scenarioFailed: true,
			nativeScenarioStarted: false,
			queriesTerminated: true,
			expectedTripwireFailure: true,
		}, (retainedRoot) => retainedRoots.push(retainedRoot));

		assert.equal(error, undefined);
		assert.equal(existsSync(root), false);
		assert.deepEqual(retainedRoots, []);
	});
});

test("unobserved query termination keeps the fixture without a retained-root notice", async () => {
	const harness = await import("./live.js") as unknown as FixtureCleanupHarness;
	assert.equal(typeof harness.cleanupLiveFixture, "function", "fixture cleanup policy must be available for offline coverage");
	await withCleanupFixture(async (root) => {
		const retainedRoots: string[] = [];
		const error = await harness.cleanupLiveFixture!(root, {
			scenarioFailed: true,
			nativeScenarioStarted: true,
			queriesTerminated: false,
			expectedTripwireFailure: false,
		}, (retainedRoot) => retainedRoots.push(retainedRoot));

		assert.equal(error, undefined);
		assert.equal(existsSync(root), true);
		assert.deepEqual(retainedRoots, []);
	});
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
			assert.deepEqual(
				readdirSync(testHome).filter((entry) => entry.startsWith("phi-live-acceptance-")),
				[],
				"expected query-creation tripwire must remove its scratch fixture",
			);
		} finally {
			rmSync(testHome, { recursive: true, force: true });
		}
	},
);
