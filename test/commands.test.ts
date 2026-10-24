import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLocalCommand } from "../src/commands.js";

test("passes ordinary text, native commands, and mentions outside the reserved namespace", () => {
	for (const text of [
		"Explain this code",
		"/clear",
		"/model sonnet",
		"@src/main.ts",
		"Please inspect @src/main.ts",
		"/philosophy is ordinary text",
		"text before /phi help",
		" /phi help",
	]) {
		assert.equal(parseLocalCommand(text), null, text);
	}
});

test("parses every command in the Task 7 local command matrix", () => {
	const cases = [
		["/phi", { kind: "help" }],
		["/phi help", { kind: "help" }],
		["/phi status", { kind: "status" }],
		["/phi context", { kind: "context" }],
		["/phi model", { kind: "model" }],
		["/phi effort", { kind: "effort" }],
		["/phi permissions", { kind: "permissions" }],
		["/phi tasks", { kind: "tasks" }],
		["/phi workflows", { kind: "workflows" }],
		["/phi transcript", { kind: "transcript" }],
		["/phi copy", { kind: "copy" }],
		["/phi sessions", { kind: "sessions" }],
		["/phi new", { kind: "new" }],
		["/phi resume session-123", { kind: "resume", sessionId: "session-123" }],
		["/phi fork", { kind: "fork" }],
		["/phi rewind", { kind: "rewind" }],
		["/phi worktrees", { kind: "worktrees" }],
		["/phi shell", { kind: "shell" }],
		["/phi attach ./image file.png", { kind: "attach", path: "./image file.png" }],
		["/phi mcp", { kind: "mcp" }],
		["/phi reload", { kind: "reload" }],
		["/phi palette", { kind: "palette" }],
		["/phi questions", { kind: "questions" }],
		["/phi ultracode", { kind: "ultracode" }],
		["/phi workflow-size", { kind: "workflow-size" }],
		["/phi send text", { kind: "send", text: "text" }],
		["/phi quit", { kind: "quit" }],
	] as const;

	for (const [text, expected] of cases) {
		assert.deepEqual(parseLocalCommand(text), expected, text);
	}
});

test("parses picker-versus-set arguments as literal values", () => {
	assert.deepEqual(parseLocalCommand("/phi model claude-sonnet-4"), {
		kind: "model",
		name: "claude-sonnet-4",
	});
	assert.deepEqual(parseLocalCommand("/phi effort high"), { kind: "effort", level: "high" });
	assert.deepEqual(parseLocalCommand("/phi permissions acceptEdits"), {
		kind: "permissions",
		mode: "acceptEdits",
	});
	assert.deepEqual(parseLocalCommand("/phi mcp Local Server"), {
		kind: "mcp",
		server: "Local Server",
	});
	assert.deepEqual(parseLocalCommand("/phi transcript tool output"), {
		kind: "transcript",
		query: "tool output",
	});
	assert.deepEqual(parseLocalCommand('/phi attach "~/images/$file.png"'), {
		kind: "attach",
		path: '"~/images/$file.png"',
	});
});

test("preserves the send remainder exactly for one literal submission", () => {
	const payload = '  "quoted" $HOME\nsecond line  ';
	assert.deepEqual(parseLocalCommand(`/phi send ${payload}`), { kind: "send", text: payload });
	assert.deepEqual(parseLocalCommand("/phi send"), {
		kind: "invalid",
		input: "/phi send",
		message: "Send requires text to submit.",
		usage: "/phi send <text>",
	});
});

test("validates the fixed workflow-size and ultracode values", () => {
	for (const size of ["unrestricted", "small", "medium", "large"] as const) {
		assert.deepEqual(parseLocalCommand(`/phi workflow-size ${size}`), {
			kind: "workflow-size",
			size,
		});
	}
	assert.deepEqual(parseLocalCommand("/phi ultracode on"), { kind: "ultracode", enabled: true });
	assert.deepEqual(parseLocalCommand("/phi ultracode off"), { kind: "ultracode", enabled: false });

	for (const text of ["/phi workflow-size huge", "/phi workflow-size small extra", "/phi ultracode yes"]) {
		const command = parseLocalCommand(text);
		assert.equal(command?.kind, "invalid", text);
		if (command?.kind === "invalid") {
			assert.ok(command.message.length > 0);
			assert.ok(command.usage.startsWith("/phi "));
		}
	}
});

test("keeps unknown and malformed local commands actionable and local", () => {
	for (const text of ["/phi unknown", "/phi resume", "/phi quit later", "/phi shell echo unsafe"]) {
		const command = parseLocalCommand(text);
		assert.equal(command?.kind, "invalid", text);
		if (command?.kind === "invalid") {
			assert.equal(command.input, text);
			assert.ok(command.message.length > 0);
			assert.ok(command.usage.startsWith("/phi "));
		}
	}
	assert.deepEqual(parseLocalCommand("/phi shell echo unsafe"), {
		kind: "invalid",
		input: "/phi shell echo unsafe",
		message: "Shell mode does not accept command text.",
		usage: "/phi shell",
	});
});
