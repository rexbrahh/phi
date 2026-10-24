import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { arch, cpus, platform, release, tmpdir, version as osVersion } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { parseArgs } from "../src/config.js";
import { AppController } from "../src/ui/app.js";
import { LOAD_TOOL_CALLS, LOAD_CHILD_CONVERSATIONS, LOAD_OVERSIZED_BYTES, LOAD_RESULT_BYTES, loadToolUseId } from "./helpers/load-events.js";
import { fullRedrawCount, percentile, retainedStateCounts, waitForCondition, type LoadStateCounts } from "./helpers/load-assertions.js";
import { FakeQueryHarness, type FakeQuerySampleGroup } from "./helpers/fake-query.js";
import { LoadTerminal } from "./helpers/load-terminal.js";
import { appDependencies } from "./helpers/ui-app.js";

const EXPECTED_UNIQUE_EVENTS = 2 * LOAD_TOOL_CALLS + 5 * LOAD_CHILD_CONVERSATIONS + 1;
const EXPECTED_DELIVERIES = 2 * EXPECTED_UNIQUE_EVENTS + 1;
const INJECTED_PROMPTS = ["load input one", "load input two", "load input three"] as const;
const KEYBOARD_SAMPLE_INTERVAL_EVENTS = 50;
const KEYBOARD_SAMPLE_CHARACTER = "x";
const KEYBOARD_SAMPLE_BACKSPACE = "\u007f";
const EXPECTED_KEYBOARD_SAMPLE_EVENTS = Math.floor((EXPECTED_UNIQUE_EVENTS - 1) / KEYBOARD_SAMPLE_INTERVAL_EVENTS) + 1;
const EXPECTED_KEYBOARD_INPUT_SAMPLES = 2 * EXPECTED_KEYBOARD_SAMPLE_EVENTS;

interface FeederReady {
	type: "ready";
	eventCountPerPass: number;
	producerWorkerHeapUsedBytes: number;
}

interface FeederEvent {
	type: "event";
	phase: FakeQuerySampleGroup;
	eventIndex: number;
	message: SDKMessage;
}

interface FeederPhaseComplete {
	type: "phase-complete";
	phase: "unique" | "duplicate";
	firstEmittedAt: number;
	lastEmittedAt: number;
	producerWorkerHeapUsedBytes: number;
}

interface FeederComplete {
	type: "complete";
	deliveryCount: number;
	firstEmittedAt: number;
	lastEmittedAt: number;
	producerWorkerHeapUsedBytes: number;
}

type FeederNotice = FeederReady | FeederPhaseComplete | FeederComplete;
type FeederMessage = FeederEvent | FeederNotice;

interface MemorySample {
	stage: string;
	parentRssBytes: number;
	parentHeapUsedBytes: number;
	parentExternalBytes: number;
	producerWorkerHeapUsedBytes: number;
}

interface ProgressSample {
	timeMs: number;
	eventsRead: number;
	uniqueEnvelopeIds: number;
	frameWrites: number;
	fullRedrawCount: number | null;
	retained: LoadStateCounts;
}

interface PhaseStateCounts {
	afterUnique?: LoadStateCounts;
	afterDuplicates?: LoadStateCounts;
	afterOversized?: LoadStateCounts;
}

test("load acceptance: 7,000 tool calls, 200 child histories, native tasks, and duplicate replay", { timeout: 240_000 }, async (context) => {
	const tempDirectory = await mkdtemp(join(tmpdir(), "phi-load-"));
	const cwd = await realpath(tempDirectory);
	const fake = new FakeQueryHarness();
	const terminal = new LoadTerminal();
	const controller = new AppController(parseArgs(["--cwd", cwd]), appDependencies(fake, terminal, {
		resolveLaunchOptions: async (launch) => launch,
		readWorkspace: async (cwd) => ({ kind: "not-repository", cwd }),
	}));
	const keyboardLatencies: number[] = [];
	const sdkEventLatencies: number[] = [];
	const oversizedSdkEventLatencies: number[] = [];
	const pendingSdkEvents: Array<{ eventAt: number; group: FakeQuerySampleGroup }> = [];
	const pendingKeyboardInputs: number[] = [];
	const keyboardSampleEventIndices: number[] = [];
	const memorySamples: MemorySample[] = [];
	const producerWorkerSamples: Array<{ stage: string; producerWorkerHeapUsedBytes: number }> = [];
	const progressSamples: ProgressSample[] = [];
	const notificationQueues = new Map<string, FeederNotice[]>();
	const notificationWaiters = new Map<string, Array<{
		resolve(notice: FeederNotice): void;
		reject(error: Error): void;
	}>>();
	let feederFailure: Error | undefined;
	let eventsRead = 0;
	let eventsEnqueued = 0;
	let uniqueEventsRead = 0;
	let feederWorker: Worker | undefined;
	let running: Promise<number> | undefined;
	const injected = new Set<number>();
	let recordingKeyboardSample = false;
	const injectionAt = [
		Math.floor(EXPECTED_UNIQUE_EVENTS * 0.1),
		Math.floor(EXPECTED_UNIQUE_EVENTS * 0.5),
		Math.floor(EXPECTED_UNIQUE_EVENTS * 0.9),
	];
	const phaseCounts: PhaseStateCounts = {};
	let uniqueFrameWrites = 0;
	let duplicateFrameWrites = 0;
	let oversizeFrameWrites = 0;
	const harnessStartedAt = performance.now();
	let currentStage = "initializing";
	const removeKeyboardInputObserver = controller.views.tui.addInputListener((data) => {
		if (!recordingKeyboardSample) return;
		if (data !== KEYBOARD_SAMPLE_CHARACTER && data !== KEYBOARD_SAMPLE_BACKSPACE) {
			throw new Error(`Unexpected input reached the keyboard sample seam: ${JSON.stringify(data)}`);
		}
		pendingKeyboardInputs.push(performance.now());
	});
	context.after(() => {
		context.diagnostic(`LOAD_PROGRESS ${JSON.stringify({
			stage: currentStage,
			eventsEnqueued,
			eventsRead,
			uniqueEventsRead,
			userInputsReceived: fake.receivedMessages.length,
			frameWrites: terminal.frameWriteTimes.length,
			pendingSdkEvents: pendingSdkEvents.length,
			pendingKeyboardInputs: pendingKeyboardInputs.length,
			keyboardLatency: keyboardLatencies.length
				? { sampleCount: keyboardLatencies.length, p50: percentile(keyboardLatencies, 0.5), p95: percentile(keyboardLatencies, 0.95) }
				: null,
			sdkEventLatency: sdkEventLatencies.length
				? { sampleCount: sdkEventLatencies.length, p50: percentile(sdkEventLatencies, 0.5), p95: percentile(sdkEventLatencies, 0.95) }
				: null,
			fullRedrawCount: fullRedrawCount(controller),
			retained: retainedStateCounts(controller),
			progressSamples,
		})}`);
	});
	const onNotice = (notice: FeederNotice): void => {
		const waiters = notificationWaiters.get(notice.type);
		const waiter = waiters?.shift();
		if (waiter) waiter.resolve(notice);
		else {
			const queued = notificationQueues.get(notice.type) ?? [];
			queued.push(notice);
			notificationQueues.set(notice.type, queued);
		}
	};

	const waitForNotice = <T extends FeederNotice["type"]>(type: T): Promise<Extract<FeederNotice, { type: T }>> => {
		if (feederFailure) return Promise.reject(feederFailure);
		const queued = notificationQueues.get(type);
		if (queued?.length) return Promise.resolve(queued.shift() as Extract<FeederNotice, { type: T }>);
		return new Promise((resolve, reject) => {
			const waiters = notificationWaiters.get(type) ?? [];
			waiters.push({
				resolve: (notice) => resolve(notice as Extract<FeederNotice, { type: T }>),
				reject,
			});
			notificationWaiters.set(type, waiters);
		});
	};

	const recordMemory = (stage: string, producerWorkerHeapUsedBytes: number): void => {
		const memory = process.memoryUsage();
		memorySamples.push({
			stage,
			parentRssBytes: memory.rss,
			parentHeapUsedBytes: memory.heapUsed,
			parentExternalBytes: memory.external,
			producerWorkerHeapUsedBytes,
		});
	};

	fake.onMessageRead = (_message, eventAt, group) => {
		eventsRead += 1;
		if (group === "unique") {
			uniqueEventsRead += 1;
			pendingSdkEvents.push({ eventAt, group });
		} else if (group === "oversized") {
			pendingSdkEvents.push({ eventAt, group });
		}
		if (eventsRead % 5_000 === 0) {
			progressSamples.push({
				timeMs: performance.now() - harnessStartedAt,
				eventsRead,
				uniqueEnvelopeIds: controller.state.seenEnvelopeIds.size,
				frameWrites: terminal.frameWriteTimes.length,
				fullRedrawCount: fullRedrawCount(controller),
				retained: retainedStateCounts(controller),
			});
		}
	};
	terminal.onFrameWrite = (writtenAt) => {
		for (const event of pendingSdkEvents.splice(0)) {
			const latency = writtenAt - event.eventAt;
			if (event.group === "unique") sdkEventLatencies.push(latency);
			else if (event.group === "oversized") oversizedSdkEventLatencies.push(latency);
		}
		for (const decodedAt of pendingKeyboardInputs.splice(0)) keyboardLatencies.push(writtenAt - decodedAt);
	};

	try {
		currentStage = "waiting-for-app-readiness";
		running = controller.run();
		await waitForCondition("AppController readiness", () => controller.ready !== undefined);
		assert.equal(controller.state.cwd, cwd);
		assert.equal(fake.parameters !== undefined, true, "the fake SDK must be injected through AppController");

		feederWorker = new Worker(new URL("./helpers/load-feed-worker.js", import.meta.url));
		feederWorker.on("message", (raw: FeederMessage) => {
			if (raw.type !== "event") {
				if (raw.type === "phase-complete") {
					producerWorkerSamples.push({ stage: raw.phase, producerWorkerHeapUsedBytes: raw.producerWorkerHeapUsedBytes });
				}
				onNotice(raw);
				return;
			}

			eventsEnqueued += 1;
			fake.pushMessage(raw.message, raw.phase);
			if (raw.phase === "unique" && raw.eventIndex % KEYBOARD_SAMPLE_INTERVAL_EVENTS === 0) {
				keyboardSampleEventIndices.push(raw.eventIndex);
				for (const data of [KEYBOARD_SAMPLE_CHARACTER, KEYBOARD_SAMPLE_BACKSPACE]) {
					recordingKeyboardSample = true;
					try {
						terminal.input(data);
					} finally {
						recordingKeyboardSample = false;
					}
				}
			}
			if (raw.phase === "unique" && injectionAt.includes(raw.eventIndex) && !injected.has(raw.eventIndex)) {
				const inputIndex = injectionAt.indexOf(raw.eventIndex);
				const prompt = INJECTED_PROMPTS[inputIndex];
				if (prompt === undefined) throw new Error("A load input injection was not configured.");
				injected.add(raw.eventIndex);
				terminal.input(prompt);
				terminal.input("\r");
			}
		});
		feederWorker.on("error", (error) => {
			feederFailure = error;
			for (const waiters of notificationWaiters.values()) {
				for (const waiter of waiters.splice(0)) waiter.reject(error);
			}
		});

		const ready = await waitForNotice("ready");
		currentStage = "feeder-ready";
		assert.equal(ready.eventCountPerPass, EXPECTED_UNIQUE_EVENTS);
		recordMemory("before-feed", ready.producerWorkerHeapUsedBytes);
		const firstFrameWrite = terminal.frameWriteTimes.length;
		const elapsedStart = performance.now();
		feederWorker.postMessage({ type: "start" });

		currentStage = "waiting-for-unique-phase-complete";
		const uniqueComplete = await waitForNotice("phase-complete");
		assert.equal(uniqueComplete.phase, "unique");
		currentStage = "waiting-for-unique-processing";
		await waitForCondition(
			"unique replay processing and frame writes",
			() => eventsRead >= EXPECTED_UNIQUE_EVENTS &&
				controller.state.seenEnvelopeIds.size === EXPECTED_UNIQUE_EVENTS &&
				pendingSdkEvents.length === 0 && pendingKeyboardInputs.length === 0,
			180_000,
			() => feederFailure,
		);
		currentStage = "validating-unique-processing";
		assert.equal(uniqueEventsRead, EXPECTED_UNIQUE_EVENTS);
		assert.equal(sdkEventLatencies.length, EXPECTED_UNIQUE_EVENTS, "every unique SDK event sample must reach a pi-tui frame write");
		assert.equal(keyboardSampleEventIndices.length, EXPECTED_KEYBOARD_SAMPLE_EVENTS);
		assert.equal(keyboardSampleEventIndices[0], 0, "keyboard sampling must start at the beginning of the unique feed");
		assert.equal(keyboardSampleEventIndices.at(-1), EXPECTED_UNIQUE_EVENTS - 1, "keyboard sampling must reach the end of the unique feed");
		assert.equal(keyboardLatencies.length, EXPECTED_KEYBOARD_INPUT_SAMPLES, "each decoded keyboard sample must reach its next pi-tui frame write");
		phaseCounts.afterUnique = retainedStateCounts(controller);
		recordMemory("after-unique", uniqueComplete.producerWorkerHeapUsedBytes);
		uniqueFrameWrites = terminal.frameWriteTimes.length - firstFrameWrite;
		feederWorker.postMessage({ type: "continue", phase: "unique" });

		currentStage = "waiting-for-duplicate-phase-complete";
		const duplicateComplete = await waitForNotice("phase-complete");
		assert.equal(duplicateComplete.phase, "duplicate");
		currentStage = "waiting-for-duplicate-processing";
		await waitForCondition(
			"duplicate replay processing",
			() => eventsRead >= 2 * EXPECTED_UNIQUE_EVENTS &&
				controller.state.seenEnvelopeIds.size === EXPECTED_UNIQUE_EVENTS,
			180_000,
			() => feederFailure,
		);
		phaseCounts.afterDuplicates = retainedStateCounts(controller);
		recordMemory("after-duplicates", duplicateComplete.producerWorkerHeapUsedBytes);
		duplicateFrameWrites = terminal.frameWriteTimes.length - firstFrameWrite - uniqueFrameWrites;
		feederWorker.postMessage({ type: "continue", phase: "duplicate" });

		currentStage = "waiting-for-feeder-complete";
		const complete = await waitForNotice("complete");
		currentStage = "waiting-for-oversized-processing";
		await waitForCondition(
			"oversized result processing and frame write",
			() => eventsRead === EXPECTED_DELIVERIES &&
				controller.state.seenEnvelopeIds.size === EXPECTED_UNIQUE_EVENTS + 1 &&
				pendingSdkEvents.length === 0 && pendingKeyboardInputs.length === 0,
			180_000,
			() => feederFailure,
		);
		phaseCounts.afterOversized = retainedStateCounts(controller);
		producerWorkerSamples.push({ stage: "oversized-output", producerWorkerHeapUsedBytes: complete.producerWorkerHeapUsedBytes });
		recordMemory("after-oversized-output", complete.producerWorkerHeapUsedBytes);
		oversizeFrameWrites = terminal.frameWriteTimes.length - firstFrameWrite - uniqueFrameWrites - duplicateFrameWrites;
		currentStage = "waiting-for-user-input-delivery";
		await waitForCondition("three injected user inputs", () => fake.receivedMessages.length === INJECTED_PROMPTS.length, 180_000, () => feederFailure);

		currentStage = "building-report";
		const aggregateRate = (complete.deliveryCount - 1) * 1_000 / (complete.lastEmittedAt - complete.firstEmittedAt);
		const uniqueDurationMs = uniqueComplete.lastEmittedAt - uniqueComplete.firstEmittedAt;
		const duplicateDurationMs = duplicateComplete.lastEmittedAt - duplicateComplete.firstEmittedAt;
		const uniqueRate = (EXPECTED_UNIQUE_EVENTS - 1) * 1_000 / uniqueDurationMs;
		const duplicateRate = (EXPECTED_UNIQUE_EVENTS - 1) * 1_000 / duplicateDurationMs;
		const elapsedMs = performance.now() - elapsedStart;
		const keyboardP50 = percentile(keyboardLatencies, 0.5);
		const keyboardP95 = percentile(keyboardLatencies, 0.95);
		const largeReceipt = controller.state.toolReceipts.get(loadToolUseId(LOAD_TOOL_CALLS - 1));
		const report = {
			metrics: {
				keyboardInput: "decoded keyboard input at the AppController TuiMainScreen input-listener seam to the next synchronized pi-tui frame-write end",
				sdkEvent: "fake SDK async-iterator yield to the next synchronized pi-tui frame-write end",
			},
			context: {
				terminal: { columns: terminal.columns, rows: terminal.rows },
				machine: {
					cpuModel: cpus()[0]?.model ?? null,
					architecture: arch(),
					operatingSystem: { platform: platform(), release: release(), version: osVersion() },
				},
				runtime: { node: process.version, v8: process.versions.v8 },
			},
			measurementLimits: [
				"Physical display latency is not measured.",
				"Native SDK history-worker memory is not measured.",
				"Memory values are stage snapshots, not peak measurements.",
			],
			toolCalls: LOAD_TOOL_CALLS,
			childConversations: LOAD_CHILD_CONVERSATIONS,
			nativeTasks: LOAD_CHILD_CONVERSATIONS,
			eventCounts: {
				uniqueSdkEvents: EXPECTED_UNIQUE_EVENTS,
				duplicateSdkEvents: EXPECTED_UNIQUE_EVENTS,
				oversizedSdkEvents: 1,
				processedSdkEvents: eventsRead,
				userPromptsDelivered: fake.receivedMessages.length,
				retainedUniqueEnvelopes: controller.state.seenEnvelopeIds.size,
			},
			resultBytes: {
				standard: LOAD_RESULT_BYTES,
				countBySize: [2_334, 2_333, 2_333],
				oversized: LOAD_OVERSIZED_BYTES,
			},
			feed: {
				targetSdkEventsPerSecond: 500,
				measuredUniqueSdkEventsPerSecond: uniqueRate,
				measuredDuplicateSdkEventsPerSecond: duplicateRate,
				aggregateSdkEventsPerSecondIncludingPhaseGates: aggregateRate,
				uniqueSdkEventWindowMs: uniqueDurationMs,
				duplicateSdkEventWindowMs: duplicateDurationMs,
				elapsedUntilProcessedMs: elapsedMs,
			},
			latencyMs: {
				keyboardInputToFrameWriteDuringUniqueFeed: {
					sampleCount: keyboardLatencies.length,
					sampledFeedEvents: keyboardSampleEventIndices.length,
					feedEventInterval: KEYBOARD_SAMPLE_INTERVAL_EVENTS,
					p95TargetMsExclusive: 50,
					p50: keyboardP50,
					p95: keyboardP95,
				},
				sdkEventToFrameWrite: {
					uniqueReplay: { sampleCount: sdkEventLatencies.length, p50: percentile(sdkEventLatencies, 0.5), p95: percentile(sdkEventLatencies, 0.95) },
					oversizedResult: { sampleCount: oversizedSdkEventLatencies.length, p50: percentile(oversizedSdkEventLatencies, 0.5), p95: percentile(oversizedSdkEventLatencies, 0.95) },
				},
			},
			frameWrites: {
				unique: uniqueFrameWrites,
				duplicates: duplicateFrameWrites,
				oversizedCase: oversizeFrameWrites,
			},
			retainedState: phaseCounts,
			memorySnapshots: memorySamples,
			producerWorkerHeapSnapshots: producerWorkerSamples,
		};
		context.diagnostic(`LOAD_ACCEPTANCE ${JSON.stringify(report)}`);

		currentStage = "asserting-acceptance";
		assert.equal(complete.deliveryCount, EXPECTED_DELIVERIES);
		assert.equal(eventsEnqueued, EXPECTED_DELIVERIES);
		assert.equal(eventsRead, EXPECTED_DELIVERIES);
		assert.ok(uniqueDurationMs >= 30_000, `unique feed lasted ${uniqueDurationMs.toFixed(2)} ms`);
		assert.ok(uniqueRate >= 475 && uniqueRate <= 525, `measured unique feed rate was ${uniqueRate.toFixed(2)} events/s`);
		assert.ok(duplicateRate >= 475 && duplicateRate <= 525, `measured duplicate feed rate was ${duplicateRate.toFixed(2)} events/s`);
		assert.deepEqual(injected.size, INJECTED_PROMPTS.length);
		assert.deepEqual(fake.receivedMessages.length, INJECTED_PROMPTS.length);
		assert.deepEqual(phaseCounts.afterUnique, {
			conversationBlocks: LOAD_TOOL_CALLS,
			provisionalBlocks: 0,
			toolReceipts: LOAD_TOOL_CALLS,
			childMessages: LOAD_CHILD_CONVERSATIONS,
			tasks: LOAD_CHILD_CONVERSATIONS,
			liveBackgroundTaskIds: 0,
			inputReceipts: INJECTED_PROMPTS.length,
			notices: 0,
			seenEnvelopeIds: EXPECTED_UNIQUE_EVENTS,
		});
		assert.deepEqual(phaseCounts.afterDuplicates, phaseCounts.afterUnique, "duplicate envelopes must not grow or alter retained state");
		assert.equal(phaseCounts.afterOversized?.toolReceipts, LOAD_TOOL_CALLS);
		assert.equal(phaseCounts.afterOversized?.seenEnvelopeIds, EXPECTED_UNIQUE_EVENTS + 1);
		assert.equal(largeReceipt?.resultPreview?.length, 8_192, "oversized output preview must remain bounded");
		assert.ok(largeReceipt?.resultPreview?.endsWith("…"));
		assert.equal(oversizedSdkEventLatencies.length, 1);
		assert.ok(keyboardP95 < 50, `p95 decoded keyboard input-to-write latency was ${keyboardP95.toFixed(2)} ms`);
	} finally {
		currentStage = "cleanup";
		fake.onMessageRead = undefined;
		terminal.onFrameWrite = undefined;
		removeKeyboardInputObserver();
		if (feederWorker) await feederWorker.terminate();
		await controller.close(0);
		if (running) await running;
		await rm(tempDirectory, { recursive: true, force: true });
	}
});
