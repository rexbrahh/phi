import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { applySdkMessage, createState, type ToolReceipt } from "../src/state.js";
import { TranscriptView } from "../src/ui/transcript.js";
import { assistantMessage, toolResultMessage, toolUseBlock } from "./helpers/sdk-event-core.js";

test("tool result preview cache keeps one width per receipt, refreshes output, and preserves SDK linkage", () => {
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

	const view = new TranscriptView(state);
	const wideLines = view.render(80);
	const receipt = state.toolReceipts.get("transcript-load-tool");
	assert.ok(receipt);
	assert.ok(wideLines.length <= 16, `wide tool preview rendered ${wideLines.length} lines`);
	assert.ok(wideLines.some((line) => line.includes("…")), "the wide clipped preview must be marked");
	const widePreviewLines = wideLines.filter((line) => line.includes("R".repeat(20)));
	assert.deepEqual(widePreviewLines.map((line) => (line.match(/R+/)?.[0] ?? "").length), [78, 78, 78]);
	assert.ok(widePreviewLines.every((line) => visibleWidth(line) <= 80));
	assert.equal(receipt.resultEnvelopeId, result.uuid);
	assert.equal(receipt.resultPreview?.length, 8_192);

	const narrowLines = view.render(32);
	assert.ok(narrowLines.length <= 16, `narrow tool preview rendered ${narrowLines.length} lines`);
	assert.ok(narrowLines.some((line) => line.includes("…")), "the narrow clipped preview must be marked");
	const previewCache = (view as unknown as {
		toolResultPreviews: WeakMap<ToolReceipt, { width: number }>;
	}).toolResultPreviews;
	assert.equal(previewCache.get(receipt)?.width, 32, "a receipt retains only the current preview width");

	const updated = toolResultMessage({
		envelopeId: "transcript-load-result-update",
		toolUseId: "transcript-load-tool",
		text: "updated output",
	});
	applySdkMessage(state, updated);
	const updatedLines = view.render(32);
	assert.ok(updatedLines.some((line) => line.includes("updated output")), "the preview must reflect an updated receipt");
	assert.ok(!updatedLines.some((line) => line.includes("RRRR")), "the prior preview must not be reused after an update");
	assert.equal(previewCache.get(receipt)?.width, 32, "updating a receipt must not add another width entry");

	assert.equal(state.conversationBlocks.length, 1);
	assert.equal(receipt?.toolUseId, "transcript-load-tool");
	assert.equal(receipt?.resultEnvelopeId, updated.uuid);
	assert.equal(receipt?.resultPreview, "updated output");
	assert.ok(receipt?.sourceEnvelopeIds.includes(call.uuid));
});
