import assert from "node:assert/strict";
import test from "node:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
	applySdkMessage,
	createState,
	markInputsDeliveryUnknown,
	recordSubmittedInput,
	type PhiState,
} from "../src/state.js";
import {
	assistantMessage,
	backgroundTasksChanged,
	compactBoundary,
	conversationReset,
	nativeUuid,
	inputJsonDelta,
	replayUserMessage,
	refusalFallbackMessage,
	resultMessage,
	sdkStatus,
	sessionStateChanged,
	streamEvent,
	taskNotification,
	taskStarted,
	taskUpdated,
	textBlock,
	textDelta,
	textStreamStart,
	toolResultMessage,
	toolProgressMessage,
	toolJsonStart,
	toolUseBlock,
	userTextMessage,
} from "./helpers/sdk-events.js";

function projectionApi() {
	return { applySdkMessage, createState, markInputsDeliveryUnknown, recordSubmittedInput };
}

function textOf(state: PhiState, index: number): string | undefined {
	const content: unknown = state.conversationBlocks[index]?.content;
	if (content === null || typeof content !== "object" || !("text" in content)) return undefined;
	return typeof content.text === "string" ? content.text : undefined;
}

test("merged user UUID echoes mark every submitted input consumed", async () => {
	const { createState, applySdkMessage, recordSubmittedInput } = await projectionApi();
	const state = createState("/repo");
	const first = nativeUuid("input-first");
	const second = nativeUuid("input-second");
	recordSubmittedInput(state, first);
	recordSubmittedInput(state, second);
	applySdkMessage(state, assistantMessage({
		envelopeId: "merged-reply",
		modelMessageId: "msg-merged-reply",
		content: [textBlock("reply")],
		userMessageUuid: "input-second",
		userMessageUuids: ["input-first", "input-second"],
	}));

	assert.equal(state.inputReceipts.get(first)?.status, "consumed");
	assert.equal(state.inputReceipts.get(second)?.status, "consumed");
});

test("a historical user replay does not acknowledge a new submission", async () => {
	const { createState, applySdkMessage, recordSubmittedInput } = await projectionApi();
	const state = createState("/repo");
	const uuid = nativeUuid("historical-input");
	recordSubmittedInput(state, uuid);
	applySdkMessage(state, replayUserMessage({ inputUuid: "historical-input", text: "old prompt" }));

	assert.equal(state.inputReceipts.get(uuid)?.status, "submitted");
});

test("a current SDK user echo marks a submitted input received", async () => {
	const { createState, applySdkMessage, recordSubmittedInput } = await projectionApi();
	const state = createState("/repo");
	const uuid = nativeUuid("current-input");
	recordSubmittedInput(state, uuid);
	applySdkMessage(state, userTextMessage({ inputUuid: "current-input", text: "hello" }));

	assert.equal(state.inputReceipts.get(uuid)?.status, "received");
});

test("unknown interruption receipts do not erase or invent submitted inputs", async () => {
	const { createState, markInputsDeliveryUnknown, recordSubmittedInput } = await projectionApi();
	const state = createState("/repo");
	const submitted = nativeUuid("submitted-input");
	recordSubmittedInput(state, submitted);
	markInputsDeliveryUnknown(state, [submitted, nativeUuid("not-submitted")]);

	assert.equal(state.inputReceipts.size, 1);
	assert.equal(state.inputReceipts.get(submitted)?.status, "delivery_unknown");
});

test("missing SDK cost remains unknown", async () => {
	const { createState, applySdkMessage } = await projectionApi();
	const state = createState("/repo");
	applySdkMessage(state, resultMessage({ envelopeId: "no-cost" }));

	assert.equal(state.usage?.totalCostUsd, null);
});

test("cumulative result usage replaces the prior session totals", async () => {
	const { createState, applySdkMessage } = await projectionApi();
	const state = createState("/repo");
	applySdkMessage(state, resultMessage({ envelopeId: "usage-first", cost: 1.25, inputTokens: 4, outputTokens: 2 }));
	applySdkMessage(state, resultMessage({ envelopeId: "usage-second", cost: 2.5, inputTokens: 9, outputTokens: 5 }));

	assert.equal(state.usage?.totalCostUsd, 2.5);
	assert.equal(state.usage?.modelUsage?.["claude-sonnet-4-5-20250929"]?.inputTokens, 9);
	assert.equal(state.usage?.mainLoopTurnUsage?.input_tokens, 9);
});

test("detached tool results leave their tool call running", async () => {
	const { createState, applySdkMessage } = await projectionApi();
	const state = createState("/repo");
	applySdkMessage(state, assistantMessage({
		envelopeId: "detached-call",
		modelMessageId: "msg-detached-call",
		content: [toolUseBlock("detached-use", "WebFetch", { url: "https://example.test" })],
	}));
	applySdkMessage(state, toolResultMessage({
		envelopeId: "detached-result",
		toolUseId: "detached-use",
		text: "running in background",
		toolUseResult: { detachedToolCall: true },
	}));

	assert.equal(state.toolReceipts.get("detached-use")?.executionState, "running");
});

test("tool previews retain at most twelve lines and 8192 characters", async () => {
	const { createState, applySdkMessage } = await projectionApi();
	const state = createState("/repo");
	applySdkMessage(state, assistantMessage({
		envelopeId: "large-tool-call",
		modelMessageId: "msg-large-tool-call",
		content: [toolUseBlock("large-tool", "Bash", {})],
	}));
	applySdkMessage(state, toolResultMessage({
		envelopeId: "large-tool-result",
		toolUseId: "large-tool",
		text: Array.from({ length: 20 }, (_, index) => `${index}:${"x".repeat(900)}`).join("\n"),
	}));
	const preview = state.toolReceipts.get("large-tool")?.resultPreview ?? "";

	assert.ok(preview.length <= 8_192);
	assert.ok(preview.split("\n").length <= 12);
});

test("tool previews clip by line count when the character limit is not reached", async () => {
	const { createState, applySdkMessage } = await projectionApi();
	const state = createState("/repo");
	applySdkMessage(state, assistantMessage({
		envelopeId: "line-call",
		modelMessageId: "msg-line-call",
		content: [toolUseBlock("line-tool", "Bash", {})],
	}));
	applySdkMessage(state, toolResultMessage({
		envelopeId: "line-result",
		toolUseId: "line-tool",
		text: Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n"),
	}));

	assert.ok((state.toolReceipts.get("line-tool")?.resultPreview ?? "").split("\n").length <= 12);
});

test("session state events set foreground status and future events stay inspectable", async () => {
	const { createState, applySdkMessage } = await projectionApi();
	const state = createState("/repo");
	applySdkMessage(state, sessionStateChanged("requires_action", "requires-action"));
	applySdkMessage(state, sessionStateChanged("running", "running-state"));
	applySdkMessage(state, sdkStatus("compacting", "compacting-state"));
	applySdkMessage(state, {
		type: "future_sdk_event",
		uuid: nativeUuid("future-event"),
		session_id: "session-1",
	} as unknown as SDKMessage);

	assert.equal(state.effectiveStatus.foreground, "running");
	assert.equal(state.effectiveStatus.phase, "compacting");
	assert.equal(state.notices.length, 1);
	assert.match(state.notices[0]?.text ?? "", /future_sdk_event/);
	assert.equal(state.toolReceipts.size, 0);
	assert.equal("generation" in state, false);
});

test("future content remains inspectable as a generic conversation block", async () => {
	const { createState, applySdkMessage } = await projectionApi();
	const state = createState("/repo");
	const futureContent = { type: "future_content", payload: "inspect this" } as never;
	applySdkMessage(state, assistantMessage({
		envelopeId: "future-content-envelope",
		modelMessageId: "msg-future-content",
		content: [futureContent],
	}));

	assert.equal(state.conversationBlocks.length, 1);
	assert.equal((state.conversationBlocks[0]?.content as { type: string }).type, "future_content");
});
