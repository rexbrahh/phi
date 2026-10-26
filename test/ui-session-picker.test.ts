import assert from "node:assert/strict";
import test from "node:test";
import { Editor, TuiMainScreen, stripTerminalSequences } from "@earendil-works/pi-tui";
import type { SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import { AppSessionPickerController } from "../src/ui/app-session-picker.js";
import { editorTheme } from "../src/ui/theme.js";
import { FakeTerminal } from "./helpers/terminal.js";

function fixture() {
	const terminal = new FakeTerminal(), tui = new TuiMainScreen(terminal);
	const editor = new Editor(tui, editorTheme);
	const selected: string[] = [];
	let changes = 0;
	const picker = new AppSessionPickerController(tui, editor, (id) => selected.push(id), () => { changes += 1; });
	return { terminal, tui, editor, selected, picker, changes: () => changes, render: () => { tui.renderNow(true); return stripTerminalSequences(terminal.output); } };
}
function session(index: number): SDKSessionInfo {
	return { sessionId: `session-${index}`, summary: `Summary ${index}`, customTitle: `Title ${index}${index === 24 ? "\u0007" : ""}`, lastModified: 1_700_000_000_000 + index, gitBranch: `branch-${index}` };
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("filters more than twenty sessions by ID and selects the exact loaded session", async () => {
	const f = fixture();
	try {
		const sessions = Array.from({ length: 25 }, (_, index) => session(index));
		f.picker.show(async () => sessions, "session-24");
		assert.equal(f.picker.visible, true);
		assert.match(f.render(), /Loading sessions/);
		await settle();
		f.picker.handleInput("session-24");
		const output = f.render();
		assert.match(output, /Current/);
		assert.match(output, /Title 24/); assert.equal(f.terminal.output.includes("Title 24\u0007"), false);
		assert.match(output, /branch-24/);
		f.picker.handleInput("\r");
		assert.deepEqual(f.selected, ["session-24"]);
		assert.equal(f.picker.visible, true); f.picker.setMessage("Switch blocked"); assert.match(f.render(), /Switch blocked/);
	} finally { f.tui.stop(); }
});

test("longer localized timestamps do not clip the branch name", async (t) => {
	t.mock.method(Date.prototype, "toLocaleString", () => "11/14/2023, 10:13:20 PM");
	const f = fixture();
	try {
		f.picker.show(async () => [session(24)], "session-24");
		await settle();
		assert.match(f.render(), /branch-24/);
		f.picker.handleInput("\r");
		assert.deepEqual(f.selected, ["session-24"]);
	} finally { f.tui.stop(); }
});

test("cancel keeps the composer draft and restores editor focus", () => {
	const f = fixture();
	try {
		f.editor.setText("unsent draft");
		f.editor.focused = true;
		f.picker.show(async () => []);
		f.picker.handleInput("\u001b");
		assert.equal(f.picker.visible, false);
		assert.equal(f.editor.getText(), "unsent draft");
		assert.equal(f.editor.focused, true);
	} finally { f.tui.stop(); }
});

test("empty and failed loads are shown inline", async () => {
	const f = fixture();
	try {
		f.picker.show(async () => []);
		await settle();
		assert.match(f.render(), /No sessions found/);
		f.picker.show(async () => { throw new Error("metadata\u0007 unavailable"); });
		await settle();
		assert.match(f.render(), /metadata unavailable/);
	} finally { f.tui.stop(); }
});

test("hidden and superseded loads cannot update the picker", async () => {
	const f = fixture();
	try {
		const closed = deferred<SDKSessionInfo[]>();
		f.picker.show(() => closed.promise);
		f.picker.hide();
		const afterClose = f.changes();
		closed.resolve([session(1)]);
		await settle();
		assert.equal(f.picker.visible, false);
		assert.equal(f.changes(), afterClose);
		const old = deferred<SDKSessionInfo[]>();
		const current = deferred<SDKSessionInfo[]>();
		f.picker.show(() => old.promise);
		f.picker.show(() => current.promise);
		const afterReshow = f.changes();
		old.reject(new Error("stale failure"));
		await settle();
		assert.equal(f.changes(), afterReshow);
		assert.doesNotMatch(f.render(), /stale failure/);
		current.resolve([session(2)]);
		await settle();
		assert.match(f.render(), /Title 2/);
	} finally { f.tui.stop(); }
});

test("resize preserves the search filter and selected session", async () => {
	const f = fixture();
	try {
		f.picker.show(async () => Array.from({ length: 25 }, (_, index) => session(index)));
		await settle();
		f.picker.handleInput("Summary");
		for (let index = 0; index < 7; index += 1) f.picker.handleInput("\u001b[B");
		f.render();
		f.terminal.columns = 60; f.terminal.rows = 18;
		const output = f.render();
		assert.match(output, /Summary/);
		f.picker.handleInput("\r"); assert.deepEqual(f.selected, ["session-7"]);
	} finally { f.tui.stop(); }
});
