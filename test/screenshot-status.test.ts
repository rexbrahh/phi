import assert from "node:assert/strict";
import test from "node:test";
import { Editor, TuiMainScreen } from "@earendil-works/pi-tui";
import { applySdkMessage, createState } from "../src/state.js";
import { MainScreen } from "../src/ui/app-screen.js";
import { createInspectorModel, InspectorView } from "../src/ui/inspectors.js";
import { TranscriptView } from "../src/ui/transcript.js";
import { editorTheme } from "../src/ui/theme.js";
import { assistantMessage, streamEvent, type StreamEvent } from "./helpers/sdk-event-core.js";
import { sdkStatus, sessionStateChanged } from "./helpers/sdk-task-events.js";
import { FakeTerminal } from "./helpers/terminal.js";

test("thinking signatures stay hidden while unknown deltas remain in diagnostics", () => {
	const { state, screen } = createScreen();
	const message = assistantMessage({
		envelopeId: "thinking-frame",
		modelMessageId: "thinking-message",
		content: [],
	}).message;
	const signature = "opaque-thinking-signature";
	const privateThinking = "private thinking text";
	const events: StreamEvent[] = [
		{ type: "message_start", message },
		{
			type: "content_block_start",
			index: 0,
			content_block: { type: "thinking", thinking: "", signature: "" },
		},
		{
			type: "content_block_delta",
			index: 0,
			delta: { type: "thinking_delta", thinking: privateThinking, estimated_tokens: null },
		},
		{
			type: "content_block_delta",
			index: 0,
			delta: { type: "signature_delta", signature },
		},
		{
			type: "content_block_delta",
			index: 0,
			delta: { type: "future_delta", payload: "inspect future event" },
		} as never,
	];

	for (const [index, event] of events.entries()) {
		applySdkMessage(state, streamEvent({ envelopeId: `thinking-stream-${index}`, event }));
	}
	screen.update({ shellMode: false, attachments: [] });

	const rendered = screen.root.render(80).join("\n");
	const diagnostics = screen.transcript.diagnosticsText();
	assert.equal(state.notices.length, 1);
	assert.match(state.notices[0]?.text ?? "", /unknown stream event delta future_delta/);
	assert.match(diagnostics, /unknown stream event delta future_delta/);
	assert.doesNotMatch(rendered, new RegExp(signature));
	assert.doesNotMatch(rendered, new RegExp(privateThinking));
	assert.doesNotMatch(diagnostics, new RegExp(signature));
});

test("idle and waiting labels hide stale SDK phases while running keeps its phase", () => {
	const { state, screen } = createScreen();
	const render = () => {
		screen.update({ shellMode: false, attachments: [] });
		return screen.root.render(80).join("\n");
	};

	applySdkMessage(state, sdkStatus("compacting", "stale-compacting-phase"));
	applySdkMessage(state, sessionStateChanged("idle", "idle-after-compacting"));
	assert.equal(state.effectiveStatus.phase, "compacting");
	assert.match(render(), /idle/);
	assert.doesNotMatch(render(), /compacting/);

	applySdkMessage(state, sdkStatus("requesting", "stale-requesting-phase"));
	applySdkMessage(state, sessionStateChanged("requires_action", "waiting-after-requesting"));
	assert.equal(state.effectiveStatus.phase, "requesting");
	assert.match(render(), /waiting for you/);
	assert.doesNotMatch(render(), /requesting/);

	applySdkMessage(state, sessionStateChanged("running", "running-after-waiting"));
	assert.match(render(), /running · requesting/);
});

function createScreen() {
	const terminal = new FakeTerminal();
	const tui = new TuiMainScreen(terminal);
	tui.stop();
	const state = createState("/repo");
	const screen = new MainScreen(
		tui,
		state,
		new TranscriptView(state),
		new InspectorView(state, createInspectorModel()),
		new Editor(tui, editorTheme),
	);
	return { state, screen };
}
