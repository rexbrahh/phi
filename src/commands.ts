export type WorkflowSize = "unrestricted" | "small" | "medium" | "large";

type ArgumentlessKind =
	| "help"
	| "status"
	| "context"
	| "tasks"
	| "workflows"
	| "copy"
	| "sessions"
	| "new"
	| "fork"
	| "rewind"
	| "worktrees"
	| "shell"
	| "reload"
	| "quit";

export type LocalCommand =
	| { readonly kind: "help" }
	| { readonly kind: "status" }
	| { readonly kind: "context" }
	| { readonly kind: "model"; readonly name?: string }
	| { readonly kind: "effort"; readonly level?: string }
	| { readonly kind: "permissions"; readonly mode?: string }
	| { readonly kind: "tasks" }
	| { readonly kind: "workflows" }
	| { readonly kind: "transcript"; readonly query?: string }
	| { readonly kind: "copy" }
	| { readonly kind: "sessions" }
	| { readonly kind: "new" }
	| { readonly kind: "resume"; readonly sessionId: string }
	| { readonly kind: "fork" }
	| { readonly kind: "rewind" }
	| { readonly kind: "worktrees" }
	| { readonly kind: "shell" }
	| { readonly kind: "attach"; readonly path: string }
	| { readonly kind: "mcp"; readonly server?: string }
	| { readonly kind: "reload" }
	| { readonly kind: "ultracode"; readonly enabled?: boolean }
	| { readonly kind: "workflow-size"; readonly size?: WorkflowSize }
	| { readonly kind: "send"; readonly text: string }
	| { readonly kind: "quit" }
	| {
			readonly kind: "invalid";
			readonly input: string;
			readonly message: string;
			readonly usage: string;
		};

function invalid(input: string, message: string, usage: string): LocalCommand {
	return { kind: "invalid", input, message, usage };
}

function argumentless(
	input: string,
	name: string,
	argumentsText: string,
	kind: ArgumentlessKind,
): LocalCommand {
	if (argumentsText.trim().length > 0) {
		return invalid(input, `/${name} does not accept arguments.`, `/phi ${name}`);
	}
	return { kind };
}

/** Parse only the reserved /phi namespace. All other input remains available to native handling. */
export function parseLocalCommand(text: string): LocalCommand | null {
	if (!text.startsWith("/phi")) return null;
	const namespaceBoundary = text[4];
	if (namespaceBoundary !== undefined && !/\s/u.test(namespaceBoundary)) return null;

	const commandLine = text.slice(4).trimStart();
	if (commandLine.length === 0) return { kind: "help" };

	const commandEnd = commandLine.search(/\s/u);
	const name = commandEnd === -1 ? commandLine : commandLine.slice(0, commandEnd);
	const rawAfterName = commandEnd === -1 ? "" : commandLine.slice(commandEnd);
	const argumentsText = rawAfterName.replace(/^\s+/u, "");
	const literalRemainder = /^\s/u.test(rawAfterName) ? rawAfterName.slice(1) : "";

	switch (name) {
		case "help":
			return argumentless(text, name, argumentsText, "help");
		case "status":
			return argumentless(text, name, argumentsText, "status");
		case "context":
			return argumentless(text, name, argumentsText, "context");
		case "model":
			return { kind: "model", ...(argumentsText.length > 0 ? { name: argumentsText } : {}) };
		case "effort":
			return { kind: "effort", ...(argumentsText.length > 0 ? { level: argumentsText } : {}) };
		case "permissions":
			return { kind: "permissions", ...(argumentsText.length > 0 ? { mode: argumentsText } : {}) };
		case "tasks":
			return argumentless(text, name, argumentsText, "tasks");
		case "workflows":
			return argumentless(text, name, argumentsText, "workflows");
		case "transcript":
			return {
				kind: "transcript",
				...(literalRemainder.trim().length > 0 ? { query: literalRemainder } : {}),
			};
		case "copy":
			return argumentless(text, name, argumentsText, "copy");
		case "sessions":
			return argumentless(text, name, argumentsText, "sessions");
		case "new":
			return argumentless(text, name, argumentsText, "new");
		case "resume": {
			const sessionId = argumentsText.trim();
			if (sessionId.length === 0 || /\s/u.test(sessionId)) {
				return invalid(text, "Resume requires one session ID.", "/phi resume <id>");
			}
			return { kind: "resume", sessionId };
		}
		case "fork":
			return argumentless(text, name, argumentsText, "fork");
		case "rewind":
			return argumentless(text, name, argumentsText, "rewind");
		case "worktrees":
			return argumentless(text, name, argumentsText, "worktrees");
		case "shell":
			if (argumentsText.length > 0) {
				return invalid(text, "Shell mode does not accept command text.", "/phi shell");
			}
			return { kind: "shell" };
		case "attach":
			if (literalRemainder.length === 0) {
				return invalid(text, "Attach requires a path.", "/phi attach <path>");
			}
			return { kind: "attach", path: literalRemainder };
		case "mcp":
			return {
				kind: "mcp",
				...(literalRemainder.trim().length > 0 ? { server: literalRemainder } : {}),
			};
		case "reload":
			return argumentless(text, name, argumentsText, "reload");
		case "ultracode": {
			const value = argumentsText.trim();
			if (value.length === 0) return { kind: "ultracode" };
			if (value === "on") return { kind: "ultracode", enabled: true };
			if (value === "off") return { kind: "ultracode", enabled: false };
			return invalid(text, "Ultracode value must be on or off.", "/phi ultracode [on|off]");
		}
		case "workflow-size": {
			const value = argumentsText.trim();
			if (value.length === 0) return { kind: "workflow-size" };
			if (value === "unrestricted" || value === "small" || value === "medium" || value === "large") {
				return { kind: "workflow-size", size: value };
			}
			return invalid(
				text,
				"Workflow size must be unrestricted, small, medium, or large.",
				"/phi workflow-size [unrestricted|small|medium|large]",
			);
		}
		case "send":
			if (literalRemainder.length === 0) {
				return invalid(text, "Send requires text to submit.", "/phi send <text>");
			}
			return { kind: "send", text: literalRemainder };
		case "quit":
			return argumentless(text, name, argumentsText, "quit");
		default:
			return invalid(
				text,
				`Unknown local command: ${name}. Use /phi help to see available commands.`,
				"/phi help",
			);
	}
}
