import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { applySdkMessage, createState } from "../src/state.js";
import { sanitizeTerminalText } from "../src/ui/safe-text.js";
import { TranscriptView } from "../src/ui/transcript.js";
import { assistantMessage, textBlock } from "./helpers/sdk-events.js";

test("terminal sanitization removes ANSI, OSC, and disallowed controls", () => {
	assert.equal(
		sanitizeTerminalText("A\u001b[31mR\u001b[0m\u001b]0;owned title\u0007Z\u0001\n\t"),
		"ARZ\n\t",
	);
});

test("transcript rendering keeps Unicode safe at narrow widths", () => {
	const state = createState("/repo");
	applySdkMessage(state, assistantMessage({
		envelopeId: "unicode-output",
		modelMessageId: "unicode-message",
		content: [textBlock("e\u0301 🙂 漢\u001b[2J\u001b]0;owned\u0007 tail")],
	}));
	const view = new TranscriptView(state);

	const lines = view.render(5);
	const rendered = sanitizeTerminalText(lines.join("\n"));
	assert.match(rendered, /e\u0301/);
	assert.match(rendered, /🙂/);
	assert.doesNotMatch(rendered, /owned|\u001b|\u0007/);
	assert.ok(lines.every((line) => visibleWidth(line) <= 5));
});
