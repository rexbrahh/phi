import { parentPort } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";
import { createLoadEvents, createOversizedOutputEvent } from "./load-events.js";

const port = parentPort!;
if (!port) throw new Error("Load feeder must run in a worker thread.");

type Phase = "unique" | "duplicate" | "oversized";

type ReplayPhase = Exclude<Phase, "oversized">;

async function waitUntil(target: number): Promise<void> {
	const delay = target - performance.now();
	if (delay <= 0) return;
	await new Promise<void>((resolve) => setTimeout(resolve, delay));
}

const events = createLoadEvents();
port.postMessage({
	type: "ready",
	eventCountPerPass: events.length,
	workerHeapUsedBytes: getHeapStatistics().used_heap_size,
});

port.once("message", (message: { type?: unknown }) => {
	if (message.type !== "start") return;
	void feed();
});

async function feed(): Promise<void> {
	const intervalMs = 2.0002;
	const startAt = performance.now() + 100;
	let deliveryIndex = 0;
	let firstEmittedAt: number | undefined;
	let lastEmittedAt = 0;

	for (const phase of ["unique", "duplicate"] as const) {
		let firstPhaseEmittedAt: number | undefined;
		let lastPhaseEmittedAt = 0;
		for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
			await waitUntil(startAt + deliveryIndex * intervalMs);
			const emittedAt = performance.now();
			firstEmittedAt ??= emittedAt;
			lastEmittedAt = emittedAt;
			firstPhaseEmittedAt ??= emittedAt;
			lastPhaseEmittedAt = emittedAt;
			port.postMessage({ type: "event", phase, eventIndex, message: events[eventIndex] });
			deliveryIndex += 1;
		}
		port.postMessage({
			type: "phase-complete",
			phase,
			firstEmittedAt: firstPhaseEmittedAt,
			lastEmittedAt: lastPhaseEmittedAt,
			workerHeapUsedBytes: getHeapStatistics().used_heap_size,
		});
		await waitForContinue(phase);
	}

	await waitUntil(startAt + deliveryIndex * intervalMs);
	const oversizedEmittedAt = performance.now();
	lastEmittedAt = oversizedEmittedAt;
	port.postMessage({
		type: "event",
		phase: "oversized" satisfies Phase,
		eventIndex: 0,
		message: createOversizedOutputEvent(),
	});
	deliveryIndex += 1;
	port.postMessage({
		type: "complete",
		deliveryCount: deliveryIndex,
		firstEmittedAt,
		lastEmittedAt,
		workerHeapUsedBytes: getHeapStatistics().used_heap_size,
	});
}

function waitForContinue(phase: ReplayPhase): Promise<void> {
	return new Promise((resolve, reject) => {
		port.once("message", (message: { type?: unknown; phase?: unknown }) => {
			if (message.type !== "continue" || message.phase !== phase) {
				reject(new Error(`Load feeder expected the ${phase} phase to be released.`));
				return;
			}
			resolve();
		});
	});
}
