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

test("two final blocks sharing a model message id stay distinct", async () => {
	const { createState, applySdkMessage } = await projectionApi();
	const state = createState("/repo");
	applySdkMessage(
		state,
		assistantMessage({ envelopeId: "env-one", modelMessageId: "msg-shared", content: [textBlock("first")] }),
	);
	applySdkMessage(
		state,
		assistantMessage({ envelopeId: "env-two", modelMessageId: "msg-shared", content: [textBlock("second")] }),
	);

	assert.equal(state.conversationBlocks.length, 2);
	assert.deepEqual(state.conversationBlocks.map((_block, index) => textOf(state, index)), ["first", "second"]);
	assert.deepEqual(state.conversationBlocks.map((block) => block.id), [
		`${nativeUuid("env-one")}:0`,
		`${nativeUuid("env-two")}:0`,
	]);
	assert.deepEqual(state.conversationBlocks.map((block) => block.aborted), [false, false]);
});

test("a final block arriving before content_block_stop replaces its provisional block", async () => {
	const { createState, applySdkMessage } = await projectionApi();
	const state = createState("/repo");
	for (const [index, event] of textStreamStart("msg-stream").entries()) {
		applySdkMessage(state, streamEvent({ envelopeId: `partial-${index}`, event }));
	}
	applySdkMessage(
		state,
		streamEvent({ envelopeId: "partial-text", event: textDelta(0, "partial text") }),
	);
	applySdkMessage(
		state,
		assistantMessage({ envelopeId: "final-text", modelMessageId: "msg-stream", content: [textBlock("final text")] }),
	);
	applySdkMessage(
		state,
		streamEvent({ envelopeId: "partial-stop", event: { type: "content_block_stop", index: 0 } }),
	);

	assert.equal(state.conversationBlocks.length, 1);
	assert.equal(textOf(state, 0), "final text");
	assert.equal(state.conversationBlocks[0]?.id, `${nativeUuid("final-text")}:0`);
	assert.equal(state.provisionalBlocks.size, 0);
});

test("unknown stream events and deltas stay inspectable and replay only once", async () => {
	const { createState, applySdkMessage } = await projectionApi();
	const state = createState("/repo");
	const unknownEvent = streamEvent({
		envelopeId: "unknown-stream-event",
		event: { type: "future_stream_event", payload: "inspect stream" } as never,
	});
	const unknownDelta = streamEvent({
		envelopeId: "unknown-stream-delta",
		event: {
			type: "content_block_delta",
			index: 0,
			delta: { type: "future_delta", payload: "inspect delta" },
		} as never,
	});

	applySdkMessage(state, unknownEvent);
	applySdkMessage(state, unknownDelta);

	assert.equal(state.notices.length, 2);
	assert.match(state.notices[0]?.text ?? "", /unknown stream event future_stream_event/);
	assert.match(state.notices[1]?.text ?? "", /unknown stream event delta future_delta/);
	assert.equal(state.notices[0]?.sourceMessage, unknownEvent);
	assert.equal(state.notices[1]?.sourceMessage, unknownDelta);

	applySdkMessage(state, { ...unknownEvent });
	applySdkMessage(state, { ...unknownDelta });
	assert.equal(state.notices.length, 2);

	for (const [index, event] of textStreamStart("known-stream").entries()) {
		applySdkMessage(state, streamEvent({ envelopeId: `known-stream-${index}`, event }));
	}
	applySdkMessage(state, streamEvent({ envelopeId: "known-text-delta", event: textDelta(0, "known text") }));
	applySdkMessage(state, streamEvent({
		envelopeId: "known-message-delta",
		event: { type: "message_delta" } as never,
	}));
	applySdkMessage(state, streamEvent({
		envelopeId: "known-block-stop",
		event: { type: "content_block_stop", index: 0 },
	}));
	applySdkMessage(state, streamEvent({ envelopeId: "known-message-stop", event: { type: "message_stop" } }));

	assert.equal(state.notices.length, 2);
	assert.equal(state.provisionalBlocks.get("known-stream:0")?.text, "known text");
	assert.equal(state.provisionalBlocks.get("known-stream:0")?.closed, true);
	assert.equal(state.activeStreamMessageId, undefined);
});

test("an empty skipped partial block does not duplicate the final block", async () => {
	const { createState, applySdkMessage } = await projectionApi();
	const state = createState("/repo");
	for (const [index, event] of textStreamStart("msg-empty").entries()) {
		applySdkMessage(state, streamEvent({ envelopeId: `empty-partial-${index}`, event }));
	}
	applySdkMessage(state, streamEvent({ envelopeId: "empty-stop", event: { type: "content_block_stop", index: 0 } }));
	applySdkMessage(state, assistantMessage({
		envelopeId: "empty-final",
		modelMessageId: "msg-empty",
		content: [textBlock("visible final")],
	}));

	assert.equal(state.conversationBlocks.length, 1);
	assert.equal(textOf(state, 0), "visible final");
});

test("an empty skipped block does not consume the populated block that follows it", async () => {
	const { createState, applySdkMessage } = await projectionApi();
	const state = createState("/repo");
	for (const [index, event] of textStreamStart("msg-skipped").entries()) {
		applySdkMessage(state, streamEvent({ envelopeId: `skipped-start-${index}`, event }));
	}
	applySdkMessage(state, streamEvent({
		envelopeId: "skipped-second-block",
		event: {
			type: "content_block_start",
			index: 1,
			content_block: { type: "text", text: "", citations: [] },
		},
	}));
	applySdkMessage(state, streamEvent({ envelopeId: "skipped-second-delta", event: textDelta(1, "visible final") }));
	applySdkMessage(state, assistantMessage({
		envelopeId: "skipped-final",
		modelMessageId: "msg-skipped",
		content: [textBlock("visible final")],
	}));
	applySdkMessage(state, streamEvent({ envelopeId: "skipped-stop-zero", event: { type: "content_block_stop", index: 0 } }));
	applySdkMessage(state, streamEvent({ envelopeId: "skipped-stop-one", event: { type: "content_block_stop", index: 1 } }));

	assert.equal(state.conversationBlocks.length, 1);
	assert.equal(textOf(state, 0), "visible final");
	assert.equal(state.provisionalBlocks.size, 0);
});

test("a nonempty SDK sequence match takes precedence over a text-prefix match", async () => {
	const { createState, applySdkMessage } = await projectionApi();
	const state = createState("/repo");
	for (const [index, event] of textStreamStart("msg-sequence").entries()) {
		applySdkMessage(state, streamEvent({ envelopeId: `sequence-start-${index}`, event }));
	}
	applySdkMessage(state, streamEvent({ envelopeId: "sequence-first-delta", event: textDelta(0, "first partial") }));
	applySdkMessage(state, streamEvent({
		envelopeId: "sequence-second-start",
		event: {
			type: "content_block_start",
			index: 1,
			content_block: { type: "text", text: "", citations: [] },
		},
	}));
	applySdkMessage(state, streamEvent({ envelopeId: "sequence-second-delta", event: textDelta(1, "second final with suffix") }));
	applySdkMessage(state, assistantMessage({
		envelopeId: "sequence-final",
		modelMessageId: "msg-sequence",
		content: [textBlock("second final")],
	}));

	assert.equal(state.provisionalBlocks.has("msg-sequence:0"), false);
	assert.equal(state.provisionalBlocks.has("msg-sequence:1"), true);
});

test("aborted tool JSON stays incomplete and is not requested", async () => {
	const { createState, applySdkMessage } = await projectionApi();
	const state = createState("/repo");
	for (const [index, event] of toolJsonStart({
		modelMessageId: "msg-tool",
		toolUseId: "tool-1",
		toolName: "Bash",
	}).entries()) {
		applySdkMessage(state, streamEvent({ envelopeId: `tool-partial-${index}`, event }));
	}
	applySdkMessage(
		state,
		streamEvent({ envelopeId: "tool-json", event: inputJsonDelta(0, '{"command":') }),
	);
	applySdkMessage(
		state,
		assistantMessage({
			envelopeId: "aborted-tool",
			modelMessageId: "msg-tool",
			content: [toolUseBlock("tool-1", "Bash", {})],
			aborted: true,
		}),
	);

	assert.equal(state.conversationBlocks.length, 1);
	assert.equal(state.conversationBlocks[0]?.aborted, true);
	assert.equal(state.toolReceipts.get("tool-1")?.inputComplete, false);
	assert.notEqual(state.toolReceipts.get("tool-1")?.executionState, "requested");
});

test("child assistant messages do not extend the main conversation", async () => {
	const { createState, applySdkMessage } = await projectionApi();
	const state = createState("/repo");
	applySdkMessage(
		state,
		assistantMessage({ envelopeId: "main", modelMessageId: "msg-main", content: [textBlock("main text")] }),
	);
	applySdkMessage(
		state,
		assistantMessage({
			envelopeId: "child",
			modelMessageId: "msg-child",
			content: [textBlock("child text")],
			parentToolUseId: "task-call",
			agentId: "task-1",
		}),
	);

	assert.equal(state.conversationBlocks.length, 1);
	assert.equal(textOf(state, 0), "main text");
	assert.equal(state.childMessages.get("task-1")?.text, "child text");
});

test("child display previews stay bounded while the SDK message remains addressable", async () => {
	const { createState, applySdkMessage } = await projectionApi();
	const state = createState("/repo");
	const childText = Array.from({ length: 20 }, (_, index) => `child ${index}`).join("\n");
	applySdkMessage(state, assistantMessage({
		envelopeId: "long-child",
		modelMessageId: "msg-long-child",
		content: [textBlock(childText)],
		parentToolUseId: "child-call",
		agentId: "child-task",
	}));
	const preview = state.childMessages.get("child-task")?.text ?? "";

	assert.equal(state.childMessages.get("child-task")?.sourceEnvelopeId, nativeUuid("long-child"));
	assert.ok(preview.split("\n").length <= 12);
	assert.ok(preview.length <= 8_192);
});

test("a complete tool call is requested before progress marks it running", async () => {
	const { createState, applySdkMessage } = await projectionApi();
	const state = createState("/repo");
	applySdkMessage(state, assistantMessage({
		envelopeId: "tool-request",
		modelMessageId: "msg-tool-request",
		content: [toolUseBlock("tool-request-id", "Bash", { command: "pwd" })],
	}));
	assert.equal(state.toolReceipts.get("tool-request-id")?.inputComplete, true);
	assert.equal(state.toolReceipts.get("tool-request-id")?.executionState, "requested");

	applySdkMessage(state, toolProgressMessage({
		envelopeId: "tool-progress",
		toolUseId: "tool-request-id",
		toolName: "Bash",
	}));
	assert.equal(state.toolReceipts.get("tool-request-id")?.executionState, "running");
});

test("a stopped tool input block establishes a request before execution starts", async () => {
	const { createState, applySdkMessage } = await projectionApi();
	const state = createState("/repo");
	for (const [index, event] of toolJsonStart({
		modelMessageId: "msg-stopped-tool",
		toolUseId: "stopped-tool",
		toolName: "Bash",
	}).entries()) {
		applySdkMessage(state, streamEvent({ envelopeId: `stopped-start-${index}`, event }));
	}
	applySdkMessage(state, streamEvent({
		envelopeId: "stopped-tool-input",
		event: inputJsonDelta(0, '{"command":"pwd"}'),
	}));
	applySdkMessage(state, streamEvent({
		envelopeId: "stopped-tool-stop",
		event: { type: "content_block_stop", index: 0 },
	}));

	assert.equal(state.toolReceipts.get("stopped-tool")?.inputComplete, true);
	assert.equal(state.toolReceipts.get("stopped-tool")?.executionState, "requested");
	assert.deepEqual(state.toolReceipts.get("stopped-tool")?.input, { command: "pwd" });
});

test("supersedes removes the named assistant envelope", async () => {
	const { createState, applySdkMessage } = await projectionApi();
	const state = createState("/repo");
	applySdkMessage(
		state,
		assistantMessage({ envelopeId: "superseded", modelMessageId: "msg-old", content: [textBlock("retracted")] }),
	);
	applySdkMessage(
		state,
		assistantMessage({
			envelopeId: "replacement",
			modelMessageId: "msg-new",
			content: [textBlock("canonical")],
			supersedes: ["superseded"],
		}),
	);

	assert.equal(state.conversationBlocks.length, 1);
	assert.equal(state.conversationBlocks[0]?.envelopeId, nativeUuid("replacement"));
	assert.equal(textOf(state, 0), "canonical");
});

test("refusal fallback retractions remove named envelopes from the transcript", async () => {
	const { createState, applySdkMessage } = await projectionApi();
	const state = createState("/repo");
	applySdkMessage(state, assistantMessage({
		envelopeId: "refused-envelope",
		modelMessageId: "msg-refused",
		content: [textBlock("refused answer")],
	}));
	applySdkMessage(state, refusalFallbackMessage({
		envelopeId: "fallback-notice",
		retractedMessageIds: ["refused-envelope"],
	}));

	assert.equal(state.conversationBlocks.length, 0);
	assert.equal(state.notices.length, 1);
});

test("replayed envelopes do not add duplicate conversation blocks", async () => {
	const { createState, applySdkMessage } = await projectionApi();
	const state = createState("/repo");
	const message = assistantMessage({ envelopeId: "replayed", modelMessageId: "msg-replayed", content: [textBlock("once")] });

	applySdkMessage(state, message);
	const sizes = [state.conversationBlocks.length, state.seenEnvelopeIds.size];
	applySdkMessage(state, message);

	assert.deepEqual([state.conversationBlocks.length, state.seenEnvelopeIds.size], sizes);
});
