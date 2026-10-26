import assert from "node:assert/strict";
import test from "node:test";
import { Editor, TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
import { createState } from "../src/state.js";
import { MainScreen } from "../src/ui/app-screen.js";
import { createInspectorModel, InspectorView } from "../src/ui/inspectors.js";
import { TranscriptView } from "../src/ui/transcript.js";
import { editorTheme } from "../src/ui/theme.js";
import { FakeTerminal } from "./helpers/terminal.js";

test("idle screen fits eight rows with selected model and effort", () => {
	const { screen } = createScreen();
	screen.update({
		model: "claude-sonnet-4-5",
		effort: "high",
		shellMode: false,
		attachments: [],
	});

	const lines = screen.root.render(80);
	const rendered = lines.join("\n");

	assert.ok(lines.length <= 8, `idle chrome rendered ${lines.length} rows`);
	assert.match(rendered, /model claude-sonnet-4-5/);
	assert.match(rendered, /effort high/);
	assert.match(rendered, /Ctrl\+Shift\+P commands/);
	assert.ok(lines.every((line) => visibleWidth(line) <= 80));
});

test("main screen stays within narrow widths", () => {
	const { screen } = createScreen();
	screen.update({
		model: "claude-sonnet-4-5",
		effort: "high",
		shellMode: false,
		attachments: [],
	});

	for (const width of [8, 12, 20, 32]) {
		const lines = screen.root.render(width);
		assert.ok(lines.every((line) => visibleWidth(line) <= width), `screen exceeded ${width} columns`);
	}
});

test("long app errors keep their full details readable", () => {
	const { screen } = createScreen();
	screen.update({
		notice: "Request failed: the saved session could not be resumed.\nDetails: the transcript file is unavailable.",
		shellMode: false,
		attachments: [],
	});

	const rendered = screen.root.render(80).join("\n");

	assert.match(rendered, /Request failed: the saved session could not be resumed\./);
	assert.match(rendered, /Details: the transcript file is unavailable\./);
});

function createScreen(): { screen: MainScreen } {
	const terminal = new FakeTerminal();
	terminal.columns = 80;
	terminal.rows = 24;
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
	return { screen };
}
