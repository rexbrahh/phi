import assert from "node:assert/strict";
import test from "node:test";
import { Markdown, Text, visibleWidth } from "@earendil-works/pi-tui";
import { createState, resetStateForProcess, type ConversationBlock } from "../src/state.js";
import { TranscriptView } from "../src/ui/transcript.js";
import type { ProvisionalBlock, ToolReceipt } from "../src/state.js";

interface RenderCounts {
	text: number;
	markdown: number;
}

function withRenderCounts(run: (counts: RenderCounts) => void): void {
	const originalTextRender = Text.prototype.render;
	const originalMarkdownRender = Markdown.prototype.render;
	const counts: RenderCounts = { text: 0, markdown: 0 };

	Text.prototype.render = function (width: number): string[] {
		counts.text += 1;
		return originalTextRender.call(this, width);
	};
	Markdown.prototype.render = function (width: number): string[] {
		counts.markdown += 1;
		return originalMarkdownRender.call(this, width);
	};

	try {
		run(counts);
	} finally {
		Text.prototype.render = originalTextRender;
		Markdown.prototype.render = originalMarkdownRender;
	}
}

function userBlock(id: string, content: string): ConversationBlock {
	return {
		id,
		envelopeId: `envelope:${id}`,
		messageId: `message:${id}`,
		role: "user",
		content,
		aborted: false,
	};
}

test("unchanged transcript blocks reuse rendered lines and preserve their output", () => {
	const state = createState("/repo");
	state.conversationBlocks.push(userBlock("unchanged", "unchanged text"));
	const view = new TranscriptView(state);

	withRenderCounts((counts) => {
		const first = view.render(80);
		assert.ok(first.some((line) => line.includes("You:")));
		assert.ok(first.some((line) => line.includes("unchanged text")));
		const firstRenderCounts = { ...counts };

		assert.deepEqual(view.render(80), first);
		assert.deepEqual(counts, firstRenderCounts, "an unchanged frame must not render the role or body again");
	});
});

test("changed tool receipts and streamed text refresh cached output", () => {
	const state = createState("/repo");
	state.conversationBlocks.push({
		...userBlock("tool-result", ""),
		content: { type: "tool_result", tool_use_id: "tool-1", content: "source result" },
	});
	const receipt: ToolReceipt = {
		toolUseId: "tool-1",
		toolName: "Read",
		inputComplete: true,
		executionState: "completed",
		sourceEnvelopeIds: [],
		resultPreview: "old receipt",
	};
	state.toolReceipts.set(receipt.toolUseId, receipt);
	const provisional: ProvisionalBlock = {
		id: "stream-1",
		messageId: "message-1",
		index: 0,
		contentType: "text",
		text: "old stream text",
		partialInputJson: "",
		closed: false,
	};
	state.provisionalBlocks.set(provisional.id, provisional);
	const view = new TranscriptView(state);

	const first = view.render(80);
	assert.ok(first.some((line) => line.includes("old receipt")));
	assert.ok(first.some((line) => line.includes("old stream text")));

	receipt.resultPreview = "updated receipt";
	provisional.text = "updated stream text";
	const updated = view.render(80);
	assert.ok(updated.some((line) => line.includes("updated receipt")));
	assert.ok(updated.some((line) => line.includes("updated stream text")));
	assert.ok(!updated.some((line) => line.includes("old receipt")));
	assert.ok(!updated.some((line) => line.includes("old stream text")));
});

test("width changes, invalidation, and reset trigger fresh block rendering", () => {
	const state = createState("/repo");
	state.conversationBlocks.push(userBlock("resized", "abcdefghij"));
	const view = new TranscriptView(state);

	withRenderCounts((counts) => {
		const wide = view.render(80);
		const afterWide = { ...counts };
		assert.deepEqual(view.render(80), wide);
		assert.deepEqual(counts, afterWide, "the same width must reuse rendered lines");

		const narrow = view.render(4);
		assert.notDeepEqual(narrow, wide);
		assert.ok(narrow.every((line) => visibleWidth(line) <= 4));
		const afterNarrow = { ...counts };
		assert.ok(afterNarrow.text > afterWide.text, "a width change must render the block at the new width");
		assert.deepEqual(view.render(4), narrow);
		assert.deepEqual(counts, afterNarrow, "the new width must then reuse rendered lines");

		view.invalidate();
		const invalidated = view.render(4);
		assert.deepEqual(invalidated, narrow);
		assert.ok(counts.text > afterNarrow.text, "invalidation must force fresh component rendering");

		resetStateForProcess(state, "/repo-reset");
		const reset = view.render(80);
		assert.ok(reset.some((line) => line.includes("Waiting for a message")));
		const beforeRestore = { ...counts };
		state.conversationBlocks.push(userBlock("resized", "abcdefghij"));
		assert.deepEqual(view.render(4), narrow);
		assert.ok(counts.text > beforeRestore.text, "a removed block must not retain its rendered lines after reset");
	});
});
