import assert from "node:assert/strict";
import test from "node:test";
import { Editor, TuiMainScreen, stripTerminalSequences } from "@earendil-works/pi-tui";
import type { PendingFormElicitationRequest, PendingPermissionRequest, PendingQuestionRequest } from "../src/interaction-types.js";
import type { InteractionQueue } from "../src/interactions.js";
import { AppDialogController } from "../src/ui/app-dialogs.js";
import { AppExitConfirmationController } from "../src/ui/app-exit-confirmation.js";
import { DialogView } from "../src/ui/dialogs.js";
import { editorTheme } from "../src/ui/theme.js";
import { FakeTerminal } from "./helpers/terminal.js";

const PAGE_UP = "\u001b[5~";
const PAGE_DOWN = "\u001b[6~";

test("permission overlay keeps actions visible, scrolls the full command, and resets and hides without answering", () => {
	const terminal = new FakeTerminal();
	const tui = new TuiMainScreen(terminal);
	const answers: unknown[] = [];
	const queueState = {
		pending: [permissionRequest("long-command", "printf example && ".repeat(700) + "TAIL_SENTINEL")],
		answer: (_id: string, answer: unknown) => { answers.push(answer); return true; },
	};
	const interactions = queueState as unknown as InteractionQueue;
	const editor = new Editor(tui, editorTheme);
	const dialogs = new AppDialogController(tui, editor, interactions, () => {}, () => {}, () => {});
	const render = () => { tui.renderNow(true); return stripTerminalSequences(terminal.output); };

	try {
		dialogs.sync();
		let output = render();
		assert.ok(dialogs.view.render(72).length <= 22);
		assert.match(output, /1 Allow once · d Deny/);
		assert.match(output, /Esc hides/);
		assert.doesNotMatch(output, /TAIL_SENTINEL/);
		for (let page = 0; page < 3; page += 1) {
			dialogs.handleKey(PAGE_DOWN);
			output = render();
		}

		terminal.columns = 60;
		terminal.rows = 18;
		output = render();
		assert.ok(dialogs.view.render(54).length <= 16);
		assert.match(output, /1 Allow once · d Deny/);
		assert.match(output, /Esc hides/);
		for (let page = 0; page < 100 && !output.includes("TAIL_SENTINEL"); page += 1) {
			dialogs.handleKey(PAGE_DOWN);
			output = render();
		}
		assert.match(output, /TAIL_SENTINEL/);

		queueState.pending[0] = permissionRequest("next-command", "NEXT_REQUEST_START " + "echo next && ".repeat(500) + "NEXT_REQUEST_TAIL");
		dialogs.sync();
		output = render();
		assert.match(output, /NEXT_REQUEST_START/);
		assert.doesNotMatch(output, /NEXT_REQUEST_TAIL/);
		assert.match(output, /1 Allow once · d Deny/);
		dialogs.handleKey("\u001b");
		assert.equal(dialogs.visible, false);
		assert.deepEqual(answers, []);
	} finally {
		tui.stop();
	}
});

test("permission keys keep allow-once, suggested, deny, and cancel callbacks unchanged", () => {
	for (const [key, canAlwaysAllow, expected] of [
		["1", false, "allow-once"], ["d", false, "deny"], ["\u0003", false, "cancel"], ["a", true, "allow-suggested"],
	] as const) {
		const answers: unknown[] = [];
		const dialog = new DialogView({ answer: (_id, answer) => answers.push(answer), openUrl() {}, error() {} }, () => 16);
		dialog.setRequest(permissionRequest(`permission-${key}`, "echo reviewed", canAlwaysAllow));
		assert.deepEqual(answers, [], "a default-to-no request must wait for an explicit key");
		dialog.handleKey(key);
		assert.deepEqual(answers, [{ kind: "permission", action: expected }]);
	}
	const answers: unknown[] = [];
	const unavailableSuggestion = new DialogView({ answer: (_id, answer) => answers.push(answer), openUrl() {}, error() {} }, () => 16);
	unavailableSuggestion.setRequest(permissionRequest("no-suggestion", "echo reviewed"));
	unavailableSuggestion.handleKey("a");
	assert.deepEqual(answers, []);
});

test("question choices stay selected while scrolling and the next question resets to its start", () => {
	const answers: unknown[] = [];
	const dialog = new DialogView({ answer: (_id, answer) => answers.push(answer), openUrl() {}, error() {} }, () => 16);
	const request = questionRequest();
	dialog.setRequest(request);
	dialog.handleKey("1");

	dialog.handleKey(PAGE_DOWN);
	let lines = dialog.render(54);
	assert.match(lines.join("\n"), /Choose numbers, then Enter\./);
	assert.match(lines.join("\n"), /Esc hides/);

	dialog.handleKey(PAGE_UP);
	lines = dialog.render(54);
	assert.match(lines.join("\n"), /\[x\] 1\. Choice 1/);

	dialog.handleKey(PAGE_DOWN);
	dialog.handleKey("\r");
	lines = dialog.render(54);
	assert.match(lines.join("\n"), /NEXT_QUESTION_MARKER/);
	assert.doesNotMatch(lines.join("\n"), /FIRST_QUESTION_MARKER/);

	dialog.handleKey("1");
	assert.deepEqual(answers, [{
		kind: "question",
		answers: {
			FIRST_QUESTION_MARKER: { kind: "choices", labels: ["Choice 1"] },
			NEXT_QUESTION_MARKER: { kind: "choice", label: "Continue" },
		},
	}]);
});

test("form input draft survives scrolling and remains submittable", () => {
	const answers: unknown[] = [];
	const dialog = new DialogView({ answer: (_id, answer) => answers.push(answer), openUrl() {}, error() {} }, () => 16);
	dialog.setRequest(formRequest());

	for (let page = 0; page < 10; page += 1) {
		dialog.handleKey(PAGE_DOWN);
		dialog.render(54);
	}
	for (const character of '{"name":"Rex"}') dialog.handleKey(character);
	for (let left = 0; left < 5; left += 1) dialog.handleKey("\u001b[D");
	dialog.handleKey("A");
	dialog.render(54);
	dialog.handleKey(PAGE_UP);
	dialog.render(54);
	dialog.handleKey(PAGE_DOWN);
	dialog.render(54);
	dialog.handleKey("\r");

	assert.deepEqual(answers, [{
		kind: "elicitation",
		response: { action: "accept", content: { name: "ARex" } },
	}]);
});

test("exit confirmation shows both choices at 80x24 and 60x18", () => {
	for (const [columns, rows] of [[80, 24], [60, 18]] as const) {
		const terminal = new FakeTerminal();
		terminal.columns = columns;
		terminal.rows = rows;
		const tui = new TuiMainScreen(terminal);
		const editor = new Editor(tui, editorTheme);
		const exits: number[] = [];
		const confirmation = new AppExitConfirmationController(tui, editor, () => exits.push(1), () => {});

		try {
			confirmation.show({ draft: true, work: true });
			tui.renderNow(true);
			const output = stripTerminalSequences(terminal.output);
			assert.match(output, /Stop work and exit Phi/);
			assert.match(output, /Keep Phi open/);
			assert.match(output, /Enter confirms/);
			assert.deepEqual(exits, []);
		} finally {
			tui.stop();
		}
	}
});

function permissionRequest(requestId: string, command: string, canAlwaysAllow = false): PendingPermissionRequest {
	const suggestions: PendingPermissionRequest["suggestions"] = canAlwaysAllow
		? [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: command }], behavior: "allow", destination: "session" }]
		: [];
	return {
		kind: "permission", requestId, nativePayload: {} as PendingPermissionRequest["nativePayload"], abort: { aborted: false },
		toolName: "Bash", toolUseID: `tool-${requestId}`, input: { command }, suggestions, canAlwaysAllow,
		defaultToNo: true, suppressAlwaysAllowRule: false,
	};
}

function questionRequest(): PendingQuestionRequest {
	return {
		kind: "question", requestId: "long-question", nativePayload: {} as PendingQuestionRequest["nativePayload"],
		abort: { aborted: false }, toolName: "AskUserQuestion", toolUseID: "tool-long-question", input: {},
		questions: [
			{ question: "FIRST_QUESTION_MARKER", multiSelect: true, options: Array.from({ length: 20 }, (_, i) => ({
				label: `Choice ${i + 1}`, description: `Description ${i + 1} ${"long answer detail ".repeat(4)}`,
			})) },
			{ question: "NEXT_QUESTION_MARKER", options: [{ label: "Continue" }] },
		],
	};
}

function formRequest(): PendingFormElicitationRequest {
	return {
		kind: "elicitation", mode: "form", requestId: "long-form",
		nativePayload: {} as PendingFormElicitationRequest["nativePayload"], abort: { aborted: false },
		request: {} as PendingFormElicitationRequest["request"],
		form: {
			supported: true, title: "Form draft stays available", required: [],
			fields: Array.from({ length: 24 }, (_, i) => ({ name: `field-${i + 1}`, title: `Field ${i + 1}`, type: "string", required: false,
				description: `Field description ${i + 1} ${"readable details ".repeat(3)}` })),
		} as PendingFormElicitationRequest["form"],
	};
}
