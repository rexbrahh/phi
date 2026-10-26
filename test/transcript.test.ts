import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { applySdkMessage, createState, type ToolReceipt } from "../src/state.js";
import { TranscriptView } from "../src/ui/transcript.js";
import { assistantMessage, nativeUuid, textBlock, toolResultMessage, toolUseBlock } from "./helpers/sdk-event-core.js";

test("routine SDK hook responses do not crowd the conversation or expose payloads", () => {
	const state = createState("/repo");
	applySdkMessage(state, assistantMessage({
		envelopeId: "notice-flood-answer",
		modelMessageId: "notice-flood-answer",
		content: [textBlock("The answer stays visible.")],
	}));
	for (let index = 0; index < 20; index += 1) {
		applySdkMessage(state, hookResponse(`notice-flood-${index}`, "success", `private hook payload ${index}`));
	}
	applySdkMessage(state, informational("notice-flood-info", "info", "private informational payload"));
	applySdkMessage(state, commandsChanged("notice-flood-commands"));
	applySdkMessage(state, controlRequestProgress("notice-flood-progress"));

	const lines = new TranscriptView(state).render(80);
	const rendered = lines.join("\n");

	assert.ok(lines.length <= 5, `routine hook messages rendered ${lines.length} transcript rows`);
	assert.match(rendered, /The answer stays visible\./);
	assert.doesNotMatch(rendered, /private hook payload|private informational payload|SessionStart|exit_code|hook_id|request_id/);
	assert.equal(state.notices.length, 23, "presentation filtering must preserve raw SDK notices");
	assert.equal(state.notices[0]?.sourceMessage.type, "system");
});

test("failed hook diagnostics remain readable and repeated failures share one row group", () => {
	const state = createState("/repo");
	for (let index = 0; index < 20; index += 1) {
		applySdkMessage(state, hookResponse(`hook-error-${index}`, "error", "private diagnostic payload", "could not load config"));
	}
	applySdkMessage(state, informational("warning-1", "warning", "Project settings contain an invalid option."));

	const lines = new TranscriptView(state).render(80);
	const rendered = lines.join("\n");

	assert.match(rendered, /Hook failed:/);
	assert.match(rendered, /SessionStart · exit 1/);
	assert.match(rendered, /could not load config/);
	assert.match(rendered, /Project settings contain an invalid option\./);
	assert.match(rendered, /×20/);
	assert.doesNotMatch(rendered, /private diagnostic payload|hook_id|session_id|uuid/);
	assert.ok(lines.length <= 8, `repeated hook failures rendered ${lines.length} transcript rows`);
	assert.equal(state.notices.length, 21, "collapsed display must not discard notice history");
});

test("distinct and oversized diagnostics stay compact while complete details remain available", () => {
	const state = createState("/repo");
	for (let index = 0; index < 100; index += 1) {
		applySdkMessage(state, informational(`distinct-${index}`, "warning", `Warning ${index}`));
	}
	applySdkMessage(state, hookResponse("large-error", "error", `Useful failure\n${"detail\n".repeat(10_000)}last detail`));
	const view = new TranscriptView(state);
	for (const width of [60, 80]) {
		const lines = view.render(width);
		assert.ok(lines.length <= 8, `diagnostics occupied ${lines.length} rows`);
		assert.match(lines.join("\n"), /Warning 99|Useful failure/);
		assert.match(lines.join("\n"), /\/phi diagnostics/);
		assert.doesNotMatch(lines.join("\n"), /Warning 0\b|last detail/);
	}
	assert.match(view.diagnosticsText(), /Warning 0\b/);
	assert.match(view.diagnosticsText(), /last detail/);
	assert.equal(state.notices.length, 101);
	applySdkMessage(state, informational("repeat-earliest", "warning", "Warning 0"));
	assert.match(view.render(80).join("\n"), /×2 Warning 0/);
});

function hookResponse(
	label: string,
	outcome: "success" | "error",
	output: string,
	stderr = "",
): SDKMessage {
	return {
		type: "system",
		subtype: "hook_response",
		hook_id: `hook-${label}`,
		hook_name: "SessionStart",
		hook_event: "SessionStart",
		output,
		stdout: "",
		stderr,
		exit_code: outcome === "error" ? 1 : 0,
		outcome,
		uuid: nativeUuid(label),
		session_id: "session-1",
	};
}

function informational(label: string, level: "info" | "warning", content: string): SDKMessage {
	return {
		type: "system",
		subtype: "informational",
		content,
		level,
		uuid: nativeUuid(label),
		session_id: "session-1",
	};
}

function commandsChanged(label: string): SDKMessage {
	return {
		type: "system",
		subtype: "commands_changed",
		commands: [],
		uuid: nativeUuid(label),
		session_id: "session-1",
	};
}

function controlRequestProgress(label: string): SDKMessage {
	return {
		type: "system",
		subtype: "control_request_progress",
		request_id: `request-${label}`,
		status: "started",
		uuid: nativeUuid(label),
		session_id: "session-1",
	};
}

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
