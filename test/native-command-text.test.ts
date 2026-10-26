import assert from "node:assert/strict";
import test from "node:test";
import { nativeCommandText } from "../src/ui/native-command-text.js";

test("nativeCommandText presents the screenshot command as a slash command", () => {
	const text = [
		"<command-message>superpowers:subagent-driven-development</command-message>",
		"<command-name>/superpowers:subagent-driven-development</command-name>",
	].join("\n");

	assert.deepEqual(nativeCommandText(text), {
		kind: "command",
		text: "/superpowers:subagent-driven-development",
	});
});

test("nativeCommandText appends native command arguments", () => {
	assert.deepEqual(nativeCommandText([
		"<command-message>review</command-message>",
		"<command-name>/review</command-name>",
		"<command-args>src/ui/app.ts --focused</command-args>",
	].join("\n")), {
		kind: "command",
		text: "/review src/ui/app.ts --focused",
	});
});

test("nativeCommandText presents complete local command output without its envelope", () => {
	assert.deepEqual(nativeCommandText("<local-command-stdout>Set model to `haiku (claude-haiku-5-5)`</local-command-stdout>"), {
		kind: "output",
		text: "Set model to `haiku (claude-haiku-5-5)`",
	});
	assert.deepEqual(nativeCommandText("<local-command-stderr>Could not switch model</local-command-stderr>"), {
		kind: "stderr",
		text: "Could not switch model",
	});
});

test("nativeCommandText leaves ordinary XML and text unrecognized", () => {
	assert.equal(nativeCommandText("<note>ordinary XML</note>"), undefined);
	assert.equal(nativeCommandText("plain user text"), undefined);
	assert.deepEqual(nativeCommandText("<local-command-stdout><note>literal output XML</note></local-command-stdout>"), {
		kind: "output",
		text: "<note>literal output XML</note>",
	});
});

test("nativeCommandText leaves incomplete, nested, mixed, and surrounding content unchanged", () => {
	const incomplete = "<command-message>review</command-message>\n<command-name>/review";
	const nested = "<command-message><note>review</note></command-message>\n<command-name>/review</command-name>";
	const mixed = "<command-message>review</command-message>\n<command-name>/review</command-name>\n<local-command-stdout>done</local-command-stdout>";
	const surrounding = "User note\n<command-message>review</command-message>\n<command-name>/review</command-name>\nKeep this text";
	const nestedOutput = "<local-command-stdout>before <local-command-stderr>nested</local-command-stderr></local-command-stdout>";

	for (const text of [incomplete, nested, mixed, surrounding, nestedOutput]) {
		assert.equal(nativeCommandText(text), undefined);
	}
});

test("nativeCommandText preserves an empty local command output envelope", () => {
	assert.deepEqual(nativeCommandText("<local-command-stdout></local-command-stdout>"), {
		kind: "output",
		text: "",
	});
});
