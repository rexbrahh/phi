import assert from "node:assert/strict";
import { test } from "node:test";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { InteractionQueue } from "../src/interactions.js";
import { buildOptions, parseArgs } from "../src/config.js";
import { startSession } from "../src/session.js";
import { FakeQueryHarness, optionCallbacks, sdkMessage } from "./helpers/fake-query.js";

type PermissionPromise = Promise<PermissionResult | null>;
type AbortListener = EventListenerOrEventListenerObject;

interface TrackedRequest {
	readonly requestId: string;
	readonly promise: PermissionPromise;
	readonly abort: (reason?: unknown) => void;
	readonly listenerCount: () => number;
}

interface Settlement {
	count: number;
	status: "pending" | "fulfilled" | "rejected";
	value?: PermissionResult | null;
	error?: unknown;
}

function trackedAbortSignal(): {
	signal: AbortSignal;
	abort: (reason?: unknown) => void;
	listenerCount: () => number;
} {
	const controller = new AbortController();
	const listeners = new Set<AbortListener>();
	const wrappedListeners = new Map<AbortListener, EventListener>();
	const signal = new Proxy(controller.signal, {
		get(target, property) {
			if (property === "addEventListener") {
				return (
					type: string,
					listener: AbortListener | null,
					options?: boolean | AddEventListenerOptions,
				) => {
					if (listener === null) return;
					if (type !== "abort") {
						target.addEventListener(type, listener, options);
						return;
					}
					const once = typeof options === "object" && options.once === true;
					const wrapped: EventListener = (event) => {
						if (once) {
							listeners.delete(listener);
							wrappedListeners.delete(listener);
						}
						if (typeof listener === "function") listener.call(target, event);
						else listener.handleEvent(event);
					};
					listeners.add(listener);
					wrappedListeners.set(listener, wrapped);
					target.addEventListener(type, wrapped, options);
				};
			}
			if (property === "removeEventListener") {
				return (
					type: string,
					listener: AbortListener | null,
					options?: boolean | EventListenerOptions,
				) => {
					if (listener === null) return;
					if (type !== "abort") {
						target.removeEventListener(type, listener, options);
						return;
					}
					const wrapped = wrappedListeners.get(listener);
					if (wrapped) {
						target.removeEventListener(type, wrapped, options);
						wrappedListeners.delete(listener);
						listeners.delete(listener);
					}
				};
			}
			const value = Reflect.get(target, property, target) as unknown;
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as AbortSignal;

	return {
		signal,
		abort: (reason) => controller.abort(reason),
		listenerCount: () => listeners.size,
	};
}

function enqueuePermission(
	queue: InteractionQueue,
	requestId: string,
	generation: number,
): TrackedRequest {
	const tracked = trackedAbortSignal();
	return {
		requestId,
		promise: queue.canUseTool("Bash", { command: `echo ${requestId}` }, {
			signal: tracked.signal,
			toolUseID: `tool-${requestId}-${generation}`,
			requestId,
		}),
		abort: tracked.abort,
		listenerCount: tracked.listenerCount,
	};
}

function observe(
	request: TrackedRequest,
	settlements: Map<PermissionPromise, Settlement>,
): void {
	if (settlements.has(request.promise)) return;
	const settlement: Settlement = { count: 0, status: "pending" };
	settlements.set(request.promise, settlement);
	void request.promise.then(
		(value) => {
			settlement.count += 1;
			settlement.status = "fulfilled";
			settlement.value = value;
		},
		(error: unknown) => {
			settlement.count += 1;
			settlement.status = "rejected";
			settlement.error = error;
		},
	);
}

function pendingIds(queue: InteractionQueue): string[] {
	return queue.pending.map((request) => request.requestId);
}

const TRACE_ACTIONS = [
	"answer-0",
	"abort-0",
	"answer-1",
	"abort-1",
	"replace",
	"close",
] as const;

test("bounded queue traces settle both request identities once across replacement and close", async () => {
	const traceCount = TRACE_ACTIONS.length ** 6;
	const acceptedAnswers = [0, 0];
	const effectiveAborts = [0, 0];
	let replacements = 0;
	let closedTraces = 0;

	for (let encoded = 0; encoded < traceCount; encoded += 1) {
		const queue = new InteractionQueue();
		const settlements = new Map<PermissionPromise, Settlement>();
		const allRequests: TrackedRequest[] = [];
		const requestIds = ["bounded-0", "bounded-1"] as const;
		let current = requestIds.map((requestId) => enqueuePermission(queue, requestId, 0));
		allRequests.push(...current);
		for (const request of current) observe(request, settlements);
		let generation = 0;
		let closed = false;
		let traceClosed = false;
		let trace = encoded;

		for (let step = 0; step < 6; step += 1) {
			const actionIndex = trace % TRACE_ACTIONS.length;
			trace = Math.floor(trace / TRACE_ACTIONS.length);
			const action = TRACE_ACTIONS[actionIndex];
			assert.ok(action);
			if (action === "answer-0" || action === "answer-1") {
				const target = action === "answer-0" ? 0 : 1;
				if (queue.answer(requestIds[target], { kind: "permission", action: "allow-once" })) {
					acceptedAnswers[target] = (acceptedAnswers[target] ?? 0) + 1;
				}
			} else if (action === "abort-0" || action === "abort-1") {
				const target = action === "abort-0" ? 0 : 1;
				const request = current[target];
				assert.ok(request);
				const wasPending = queue.pending.some((pending) => pending.requestId === requestIds[target]);
				request.abort(`trace abort ${target}`);
				if (wasPending) effectiveAborts[target] = (effectiveAborts[target] ?? 0) + 1;
			} else if (action === "replace") {
				queue.cancelPending("trace replacement");
				if (generation === 0) {
					generation = 1;
					current = requestIds.map((requestId) => enqueuePermission(queue, requestId, generation));
					allRequests.push(...current);
					for (const request of current) observe(request, settlements);
					replacements += 1;
					if (!closed) assert.deepEqual(pendingIds(queue), [...requestIds], `trace ${encoded}`);
				}
			} else {
				queue.cancelAll("trace close");
				closed = true;
				traceClosed = true;
			}
		}
		if (traceClosed) closedTraces += 1;

		if (generation === 0) {
			queue.cancelPending("bounded replacement");
			generation = 1;
			current = requestIds.map((requestId) => enqueuePermission(queue, requestId, generation));
			allRequests.push(...current);
			for (const request of current) observe(request, settlements);
			replacements += 1;
			if (!closed) assert.deepEqual(pendingIds(queue), [...requestIds], `trace ${encoded}`);
		}

		queue.cancelAll("bounded close");
		closed = true;
		assert.deepEqual(pendingIds(queue), [], `trace ${encoded}`);
		const late = enqueuePermission(queue, "late-after-close", generation);
		allRequests.push(late);
		observe(late, settlements);
		assert.deepEqual(pendingIds(queue), [], `late work accepted in trace ${encoded}`);

		await Promise.resolve();
		await Promise.resolve();
		for (const settlement of settlements.values()) {
			assert.equal(settlement.count, 1, `trace ${encoded}`);
			assert.equal(settlement.status, "fulfilled", `trace ${encoded}`);
			assert.ok(settlement.value, `trace ${encoded}`);
		}
		for (const request of allRequests) {
			assert.equal(request.listenerCount(), 0, `abort listener retained in trace ${encoded}`);
		}
		const lateSettlement = settlements.get(late.promise);
		assert.ok(lateSettlement?.value);
		assert.equal(lateSettlement.value.behavior, "deny", `late request accepted in trace ${encoded}`);
		}

	assert.ok(acceptedAnswers[0] > 0 && acceptedAnswers[1] > 0);
	assert.ok(effectiveAborts[0] > 0 && effectiveAborts[1] > 0);
	assert.equal(replacements, traceCount);
	assert.equal(closedTraces, traceCount - (TRACE_ACTIONS.length - 1) ** 6);
});

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (error: unknown) => void;
} {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((accept, fail) => {
		resolve = accept;
		reject = fail;
	});
	return { promise, resolve, reject };
}

function permutations<T>(values: readonly T[]): T[][] {
	if (values.length < 2) return [[...values]];
	const results: T[][] = [];
	for (let index = 0; index < values.length; index += 1) {
		const first = values[index];
		assert.notEqual(first, undefined);
		const rest = [...values.slice(0, index), ...values.slice(index + 1)];
		for (const suffix of permutations(rest)) results.push([first, ...suffix]);
	}
	return results;
}

test("session message, callback, iterator-error, and close races settle without abandoned work", async () => {
	const raceOrders = permutations(["error", "close", "callback"] as const);
	for (const callbackFails of [false, true]) {
		for (const order of raceOrders) {
			const fake = new FakeQueryHarness();
			const callbackGate = deferred<void>();
			const callbackStarted = deferred<void>();
			const iteratorError = new Error("bounded iterator error");
			const callbackError = new Error("bounded callback error");
			const errors: unknown[] = [];
			let messages = 0;
			const session = startSession(buildOptions(parseArgs([]), optionCallbacks()), {
				async onMessage() {
					messages += 1;
					callbackStarted.resolve();
					await callbackGate.promise;
				},
				onError(error) {
					errors.push(error);
				},
			}, fake.createQuery);

			await session.ready;
			fake.pushMessage(sdkMessage());
			await callbackStarted.promise;
			let closing: Promise<void> | undefined;
			for (const event of order) {
				if (event === "error") fake.failOutput(iteratorError);
				else if (event === "close") closing = session.close();
				else if (callbackFails) callbackGate.reject(callbackError);
				else callbackGate.resolve();
				await Promise.resolve();
			}

			assert.ok(closing);
			const [doneResult, closeResult] = await Promise.all([
				Promise.allSettled([session.done]),
				Promise.allSettled([closing]),
			]);
			const expectedError = callbackFails
				? callbackError
				: order.indexOf("error") < order.indexOf("close") ? iteratorError : undefined;
			assert.equal(messages, 1, `${callbackFails ? "callback error" : "callback success"}: ${order.join(",")}`);
			if (expectedError === undefined) {
				assert.equal(errors.length, 0, order.join(","));
				assert.equal(doneResult[0]?.status, "fulfilled", order.join(","));
				assert.equal(closeResult[0]?.status, "fulfilled", order.join(","));
			} else {
				assert.deepEqual(errors, [expectedError], order.join(","));
				assert.equal(doneResult[0]?.status, "rejected", order.join(","));
				assert.equal(closeResult[0]?.status, "rejected", order.join(","));
				assert.equal(doneResult[0]?.reason, expectedError, order.join(","));
				assert.equal(closeResult[0]?.reason, expectedError, order.join(","));
			}
			assert.equal(fake.closeCalls, 1, order.join(","));
			assert.throws(() => session.send({
				type: "user",
				message: { role: "user", content: "after close" },
				parent_tool_use_id: null,
			}), /closing|closed/);
		}
	}
});
