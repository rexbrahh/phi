import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { applySdkMessage, createState } from "../src/state.js";
import { TranscriptView } from "../src/ui/transcript.js";
import {
	assistantMessage,
	inputJsonDelta,
	streamEvent,
	textBlock,
	textDelta,
	textStreamStart,
	toolJsonStart,
	toolResultMessage,
	toolUseBlock,
	userTextMessage,
	type AssistantContent,
} from "./helpers/sdk-event-core.js";

test("compact tool input summaries stay on one width-bounded line", () => {
	const state = createState("/repo");
	const command = `echo first\n${"界🙂".repeat(100)}\u001b[31mred\u001b[0m`;
	applySdkMessage(state, assistantMessage({
		envelopeId: "compact-command",
		modelMessageId: "compact-command",
		content: [toolUseBlock("compact-command-tool", "Bash", { command })],
	}));

	const lines = new TranscriptView(state).render(36);
	const rendered = stripVTControlCharacters(lines.join("\n"));
	assert.match(rendered, /Bash · requested/);
	assert.match(rendered, /echo first/);
	assert.doesNotMatch(rendered, /\u001b/);
	assert.doesNotMatch(lines.join("\n"), /\u001b\[31m/, "tool input cannot inject terminal styling");
	assert.equal(lines.length, 1, "the tool name, state, and input share one row");
	assert.ok(lines.every((line) => visibleWidth(line) <= 36));
});

test("generic oversized tool inputs use a bounded single-line fallback", () => {
	const state = createState("/repo");
	applySdkMessage(state, assistantMessage({
		envelopeId: "compact-generic",
		modelMessageId: "compact-generic",
		content: [toolUseBlock("compact-generic-tool", "CustomTool", { payload: "G".repeat(30_000) })],
	}));

	const lines = new TranscriptView(state).render(28);
	assert.ok(lines.length <= 3, `generic input rendered ${lines.length} rows`);
	assert.ok(lines.every((line) => visibleWidth(line) <= 28));
	assert.ok(lines.join("\n").includes("CustomTool · requested"));
});

test("streaming partial tool JSON stays compact", () => {
	const state = createState("/repo");
	const start = toolJsonStart({ modelMessageId: "stream-tool", toolUseId: "stream-tool", toolName: "Bash" });
	for (const [index, event] of start.entries()) {
		applySdkMessage(state, streamEvent({ envelopeId: `stream-tool-start-${index}`, event }));
	}
	applySdkMessage(state, streamEvent({
		envelopeId: "stream-tool-input",
		event: inputJsonDelta(0, `{"command":"${"partial".repeat(2_000)}`),
	}));

	const lines = new TranscriptView(state).render(32);
	assert.ok(lines.length <= 3, `streaming input rendered ${lines.length} rows`);
	assert.ok(lines.every((line) => visibleWidth(line) <= 32));
	assert.match(lines.join("\n"), /Bash · streaming/);
});

test("tool details reveal retained input and output, then collapse after resize", () => {
	const state = createState("/repo");
	applySdkMessage(state, assistantMessage({
		envelopeId: "details-call",
		modelMessageId: "details-call",
		content: [toolUseBlock("details-tool", "Read", {
			path: "/repo/source.txt",
			content: `input-start${"I".repeat(9_000)}input-outside-retention`,
		})],
	}));
	applySdkMessage(state, toolResultMessage({
		envelopeId: "details-result",
		toolUseId: "details-tool",
		text: `output-start${"O".repeat(9_000)}output-outside-retention`,
	}));
	const receipt = state.toolReceipts.get("details-tool");
	assert.ok(receipt?.resultPreview);
	const retainedOutput = receipt.resultPreview;
	const originalBlocks = structuredClone(state.conversationBlocks);
	const view = new TranscriptView(state);

	const compact = view.render(80).join("\n");
	assert.equal(view.toolDetailsVisible, false);
	assert.match(compact, /Read · completed/);
	assert.doesNotMatch(compact, /Retained output|output-outside-retention/);
	assert.equal(view.toggleToolDetails(), true);
	assert.equal(view.toolDetailsVisible, true);
	const expanded = view.render(80).join("\n");
	assert.match(expanded, /Retained input/);
	assert.match(expanded, /input-start/);
	assert.match(expanded, /Retained output/);
	assert.match(expanded, /output-start/);
	assert.match(expanded, /…/);
	assert.doesNotMatch(expanded, /input-outside-retention|output-outside-retention/);
	assert.equal(receipt.resultPreview, retainedOutput);

	const resized = view.render(32);
	assert.ok(resized.every((line) => visibleWidth(line) <= 32));
	assert.match(resized.join("\n"), /Retained output/);
	assert.equal(view.toggleToolDetails(), false);
	assert.equal(view.toolDetailsVisible, false);
	const collapsed = view.render(32).join("\n");
	assert.doesNotMatch(collapsed, /Retained input|Retained output|input-start/);
	assert.doesNotMatch(collapsed, /output-outside-retention/);
	assert.deepEqual(state.conversationBlocks, originalBlocks, "presentation toggles must not modify conversation state");
});

test("failed tool results remain visible in compact and expanded modes", () => {
	const state = createState("/repo");
	applySdkMessage(state, assistantMessage({
		envelopeId: "details-failure-call",
		modelMessageId: "details-failure-call",
		content: [toolUseBlock("details-failure-tool", "Bash", { command: "run failing command" })],
	}));
	applySdkMessage(state, toolResultMessage({
		envelopeId: "details-failure-result",
		toolUseId: "details-failure-tool",
		text: "permission denied while opening file",
		error: true,
	}));
	const view = new TranscriptView(state);

	assert.match(view.render(80).join("\n"), /Bash · failed/);
	assert.match(view.render(80).join("\n"), /permission denied/);
	view.toggleToolDetails();
	assert.match(view.render(80).join("\n"), /Retained output/);
	assert.match(view.render(80).join("\n"), /permission denied/);
});

test("latest assistant text joins main-message text blocks and excludes non-answer content", () => {
	const state = createState("/repo");
	applySdkMessage(state, assistantMessage({
		envelopeId: "copy-earlier",
		modelMessageId: "copy-earlier",
		content: [textBlock("earlier answer")],
	}));
	const thinking = { type: "thinking", thinking: "private reasoning", signature: "sig" } as AssistantContent;
	const redacted = { type: "redacted_thinking", data: "private" } as AssistantContent;
	applySdkMessage(state, assistantMessage({
		envelopeId: "copy-latest",
		modelMessageId: "copy-latest",
		content: [
			textBlock("answer first block"),
			thinking,
			toolUseBlock("copy-tool", "Read", { path: "/repo/file" }),
			redacted,
			textBlock("answer second block"),
		],
	}));
	applySdkMessage(state, toolResultMessage({
		envelopeId: "copy-tool-result",
		toolUseId: "copy-tool",
		text: "tool result that is not the answer",
	}));
	applySdkMessage(state, userTextMessage({ inputUuid: "copy-user", text: "a later user message" }));
	applySdkMessage(state, assistantMessage({
		envelopeId: "copy-child",
		modelMessageId: "copy-child",
		content: [textBlock("child-only answer")],
		agentId: "child-agent",
	}));
	applySdkMessage(state, assistantMessage({
		envelopeId: "copy-aborted",
		modelMessageId: "copy-aborted",
		content: [textBlock("aborted answer")],
		aborted: true,
	}));
	for (const [index, event] of textStreamStart("copy-stream").entries()) {
		applySdkMessage(state, streamEvent({ envelopeId: `copy-stream-start-${index}`, event }));
	}
	applySdkMessage(state, streamEvent({ envelopeId: "copy-stream-delta", event: textDelta(0, "incomplete streaming answer") }));

	assert.equal(new TranscriptView(state).latestAssistantText(), "answer first block\nanswer second block");
});
