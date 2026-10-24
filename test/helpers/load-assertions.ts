import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import type { AppController } from "../../src/ui/app.js";

export interface LoadStateCounts {
	conversationBlocks: number;
	provisionalBlocks: number;
	toolReceipts: number;
	childMessages: number;
	tasks: number;
	liveBackgroundTaskIds: number;
	inputReceipts: number;
	notices: number;
	seenEnvelopeIds: number;
}

export function retainedStateCounts(controller: AppController): LoadStateCounts {
	return {
		conversationBlocks: controller.state.conversationBlocks.length,
		provisionalBlocks: controller.state.provisionalBlocks.size,
		toolReceipts: controller.state.toolReceipts.size,
		childMessages: controller.state.childMessages.size,
		tasks: controller.state.tasks.size,
		liveBackgroundTaskIds: controller.state.liveBackgroundTaskIds.size,
		inputReceipts: controller.state.inputReceipts.size,
		notices: controller.state.notices.length,
		seenEnvelopeIds: controller.state.seenEnvelopeIds.size,
	};
}

export function fullRedrawCount(controller: AppController): number | null {
	const value: unknown = Reflect.get(controller.views.tui, "fullRedrawCount");
	return typeof value === "number" ? value : null;
}

export async function waitForCondition(
	description: string,
	condition: () => boolean,
	timeoutMs = 180_000,
	failure?: () => Error | undefined,
): Promise<void> {
	const deadline = performance.now() + timeoutMs;
	while (!condition()) {
		const error = failure?.();
		if (error) throw error;
		if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${description}.`);
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
}

export function percentile(values: readonly number[], fraction: number): number {
	assert.ok(values.length > 0, "latency sample set must not be empty");
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.ceil(fraction * sorted.length) - 1] ?? 0;
}
