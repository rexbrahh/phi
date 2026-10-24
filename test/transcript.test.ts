import assert from "node:assert/strict";
import test from "node:test";
import { applySdkMessage, createState } from "../src/state.js";
import { TranscriptView } from "../src/ui/transcript.js";
import { assistantMessage, toolResultMessage, toolUseBlock } from "./helpers/sdk-event-core.js";

test("tool result previews stay visually bounded without dropping native history reachability", () => {
	const state = createState("/repo");
	const call = assistantMessage({
		envelopeId: "transcript-load-call",
		modelMessageId: "transcript-load-model",
		content: [toolUseBlock("transcript-load-tool", "Read", { path: "/repo/file.txt" })],
	});
	const result = toolResultMessage({
		envelopeId: "transcript-load-result",
		toolUseId: "transcript-load-tool",
		text: "R".repeat(37_034),
	});
	applySdkMessage(state, call);
	applySdkMessage(state, result);

	const lines = new TranscriptView(state).render(80);
	const receipt = state.toolReceipts.get("transcript-load-tool");
	assert.ok(lines.length <= 16, `tool preview rendered ${lines.length} lines`);
	assert.ok(lines.some((line) => line.includes("…")), "the clipped preview must be marked");
	assert.equal(state.conversationBlocks.length, 1);
	assert.equal(receipt?.toolUseId, "transcript-load-tool");
	assert.equal(receipt?.resultEnvelopeId, result.uuid);
	assert.equal(receipt?.resultPreview?.length, 8_192);
	assert.ok(receipt?.sourceEnvelopeIds.includes(call.uuid));
});
