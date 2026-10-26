import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { applySdkMessage, createState } from "../src/state.js";
import { TranscriptView } from "../src/ui/transcript.js";
import { assistantMessage, textBlock, toolResultMessage, toolUseBlock, userTextMessage } from "./helpers/sdk-event-core.js";

test("native command and tool activity leave room for the conversation", () => {
	const state = createState("/repo");
	applySdkMessage(state, userTextMessage({ inputUuid: "native-command", text:
		"<command-message>superpowers:subagent-driven-development</command-message>\n<command-name>/superpowers:subagent-driven-development</command-name>" }));
	for (const [id, description, failed] of [
		["find-plan", "Find plan files, ledgers, and worktrees", false],
		["read-ledger", "Read each ledger", true],
	] as const) {
		applySdkMessage(state, assistantMessage({ envelopeId: id, modelMessageId: id,
			content: [toolUseBlock(id, "Bash", { command: `find . ${"--synthetic-long-argument ".repeat(100)}`, description })] }));
		applySdkMessage(state, toolResultMessage({ envelopeId: `${id}-result`, toolUseId: id,
			text: failed ? "Error: Exit code 1\nCould not read a ledger.\nCheck the path.\nExtra details."
				: "plan-a.md\nplan-b.md\nworktree-a\nworktree-b", error: failed }));
	}
	applySdkMessage(state, userTextMessage({ inputUuid: "model-output", text:
		"<local-command-stdout>Set model to haiku</local-command-stdout>" }));
	applySdkMessage(state, assistantMessage({ envelopeId: "choose-plan", modelMessageId: "choose-plan",
		content: [textBlock("Which plan should I run?\n\n1. `plan-a.md`\n2. `plan-b.md`")] }));
	applySdkMessage(state, userTextMessage({ inputUuid: "reply", text: "Use plan-a.md." }));
	applySdkMessage(state, assistantMessage({ envelopeId: "reply-answer", modelMessageId: "reply-answer",
		content: [textBlock("I will read that plan and start its first task.")] }));
	const original = structuredClone(state.conversationBlocks);
	const view = new TranscriptView(state);
	const lines = view.render(100);
	const text = stripVTControlCharacters(lines.join("\n"));
	assert.match(text, /› \/superpowers:subagent-driven-development/);
	assert.match(text, /Bash · completed · Find plan files, ledgers, and worktrees/);
	assert.match(text, /Bash · failed · Read each ledger/);
	assert.match(text, /Could not read a ledger/);
	assert.match(text, /Set model to haiku/);
	assert.match(text, /● Which plan should I run/);
	assert.doesNotMatch(text, /<command-|<local-command-|You:|Phi:|Tool:|synthetic-long-argument|worktree-b|Extra details/);
	assert.ok(lines.length <= 20, `the screenshot fixture occupied ${lines.length} rows`);
	for (const width of [12, 32, 100]) {
		assert.ok(view.render(width).every((line) => visibleWidth(line) <= width));
	}
	view.toggleToolDetails();
	const expanded = stripVTControlCharacters(view.render(100).join("\n"));
	assert.match(expanded, /synthetic-long-argument/);
	assert.match(expanded, /worktree-b/);
	assert.match(expanded, /Extra details/);
	assert.deepEqual(state.conversationBlocks, original, "display changes must preserve native history");
});

test("internal SDK lifecycle and future events stay in diagnostics", () => {
	const state = createState("/repo");
	applySdkMessage(state, assistantMessage({ envelopeId: "answer", modelMessageId: "answer", content: [textBlock("Ready.")] }));
	for (let index = 0; index < 9; index += 1) {
		applySdkMessage(state, { type: "system", subtype: "command_lifecycle", uuid: `command-${index}`,
			session_id: "session-1" } as unknown as SDKMessage);
	}
	applySdkMessage(state, { type: "future_event", uuid: "future" } as unknown as SDKMessage);
	const view = new TranscriptView(state);
	assert.doesNotMatch(view.render(100).join("\n"), /Notice|command_lifecycle|future_event|diagnostics/);
	assert.match(view.diagnosticsText(), /×9.*command_lifecycle/);
	assert.match(view.diagnosticsText(), /future_event/);
	assert.equal(state.notices.length, 10);
	applySdkMessage(state, { type: "system", subtype: "future_failure", uuid: "error",
		session_id: "session-1", error: "The request could not continue." } as unknown as SDKMessage);
	assert.match(view.render(100).join("\n"), /SDK error: The request could not continue/);
});

test("ordinary XML stays visible, and empty native output adds no blank block", () => {
	const state = createState("/repo");
	applySdkMessage(state, userTextMessage({ inputUuid: "xml", text: "Explain <command-name>/help</command-name>." }));
	const view = new TranscriptView(state);
	const before = view.render(100);
	assert.match(before.join("\n"), /Explain <command-name>\/help<\/command-name>\./);
	applySdkMessage(state, userTextMessage({ inputUuid: "empty", text: "<local-command-stdout></local-command-stdout>" }));
	assert.deepEqual(view.render(100), before);
});

test("native stderr keeps its channel label", () => {
	const state = createState("/repo");
	applySdkMessage(state, userTextMessage({ inputUuid: "stderr", text:
		"<local-command-stderr>Could not switch model</local-command-stderr>" }));
	const text = stripVTControlCharacters(new TranscriptView(state).render(80).join("\n"));
	assert.match(text, /stderr: Could not switch model/);
	assert.doesNotMatch(text, /<local-command/);
});

test("one-column and two-column transcripts retain body text without decorative prefixes", () => {
	const state = createState("/repo");
	applySdkMessage(state, userTextMessage({ inputUuid: "tiny", text: "ABC" }));
	const view = new TranscriptView(state);
	for (const width of [1, 2]) {
		const lines = view.render(width);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		assert.equal(stripVTControlCharacters(lines.join("")).replace(/\s/gu, ""), "ABC");
	}
});
