import type { AppController } from "./ui/app.js";
import type { EffortLevel, PermissionMode } from "@anthropic-ai/claude-agent-sdk";

export type WorkflowSize = "unrestricted" | "small" | "medium" | "large";

type ArgumentlessKind =
	| "help"
	| "status"
	| "diagnostics"
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
	| "palette"
	| "questions"
	| "quit";

export type LocalCommand =
	| { readonly kind: "help" }
	| { readonly kind: "status" }
	| { readonly kind: "diagnostics" }
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
	| { readonly kind: "palette" }
	| { readonly kind: "questions" }
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

/** Parse local controls. Other slash commands remain available to native handling. */
export function parseLocalCommand(text: string): LocalCommand | null {
	for (const [alias, kind] of [["/model", "model"], ["/effort", "effort"]] as const) {
		if (!text.startsWith(alias)) continue;
		const boundary = text[alias.length];
		if (boundary !== undefined && !/\s/u.test(boundary)) continue;
		const argument = text.slice(alias.length).replace(/^\s+/u, "");
		return kind === "model"
			? { kind, ...(argument.length > 0 ? { name: argument } : {}) }
			: { kind, ...(argument.length > 0 ? { level: argument } : {}) };
	}
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
		case "diagnostics":
			return argumentless(text, name, argumentsText, "diagnostics");
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
		case "palette":
			return argumentless(text, name, argumentsText, "palette");
		case "questions":
			return argumentless(text, name, argumentsText, "questions");
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

const PERMISSION_MODES: readonly PermissionMode[] = [
	"default",
	"acceptEdits",
	"bypassPermissions",
	"plan",
	"dontAsk",
	"auto",
];

export async function dispatchLocalCommand(command: LocalCommand, app: AppController): Promise<void> {
	if (command.kind === "invalid") {
		app.showNotice(`${command.message} Usage: ${command.usage}. Use /phi help for local commands.`);
		return;
	}
	if (command.kind === "send") {
		app.submitLiteral(command.text);
		return;
	}
	if (command.kind === "quit") {
		app.requestUserExit();
		return;
	}
	if (command.kind === "palette") {
		app.openCommandPalette();
		return;
	}
	if (command.kind === "questions") {
		app.reopenQuestions();
		return;
	}
	if (command.kind === "new" || command.kind === "resume" || command.kind === "fork") {
		await app.replaceSession(command);
		return;
	}
	if (command.kind === "rewind") {
		await app.rewindFiles();
		return;
	}
	if (command.kind === "help") {
		app.showNotice("Local Phi: /model [id], /effort [level] (also /phi model and /phi effort), /phi status, diagnostics, context, permissions [mode], tasks, workflows, transcript [text], copy, sessions, new, resume <id>, fork, rewind, worktrees, shell, attach <path>, mcp [server], reload, palette, questions, ultracode [on|off], workflow-size [unrestricted|small|medium|large], send <text>, quit. In Tasks, x stops the selected task; Ctrl+B backgrounds foreground work. Other SDK slash commands and @ paths pass through unchanged.");
		return;
	}

	try {
		switch (command.kind) {
			case "status":
				app.showNotice(formatStatus(app));
				return;
			case "diagnostics":
				app.showNotice(app.views.transcript.diagnosticsText());
				return;
			case "context": {
				const query = requireQuery(app);
				const usage = await query.getContextUsage({ detail: "summary" });
				app.setReportedModel(usage.model);
				const categories = usage.categories.map((category) => `${category.name}: ${category.tokens.toLocaleString()} tokens`);
				app.showNotice([
					`Context: ${usage.totalTokens.toLocaleString()} / ${usage.maxTokens.toLocaleString()} tokens (${usage.percentage}%).`,
					`SDK-reported model: ${usage.model}.`,
					...categories,
				].join("\n"));
				return;
			}
			case "model":
				if (command.name === undefined) app.openModelPicker();
				else await selectModel(app, command.name);
				return;
			case "effort":
				if (command.level === undefined) app.openEffortPicker();
				else await selectEffort(app, command.level);
				return;
			case "permissions":
				await selectPermissionMode(app, command.mode);
				return;
			case "tasks":
				app.showInspector("tasks");
				return;
			case "workflows":
				app.showInspector("tasks");
				app.showNotice("Native workflow IDs and phases are shown in Tasks. Resume a workflow through the SDK's native Workflow.resumeFromRunId path or a configured workflow command.");
				return;
			case "transcript":
				app.showInspector("history");
				if (command.query) app.searchLoadedHistory(command.query);
				return;
			case "copy":
				await app.copySelectedOutput();
				return;
			case "sessions":
				await showSessions(app);
				return;
			case "worktrees":
				app.showInspector("workspace");
				return;
			case "shell":
				app.openShellMode();
				return;
			case "attach":
				app.loadImage(unquotePath(command.path), `/phi attach ${command.path}`);
				return;
			case "mcp":
				await showOrReconnectMcp(app, command.server);
				return;
			case "reload":
				await reloadNativeCommands(app);
				return;
			case "ultracode":
				await setUltracode(app, command.enabled);
				return;
			case "workflow-size":
				await setWorkflowSize(app, command.size);
				return;
		}
	} catch (error) {
		app.showNotice(`Could not run /phi ${command.kind}: ${errorText(error)}`);
	}
}

function requireQuery(app: AppController) {
	const query = app.query;
	if (!query || !app.ready) throw new Error("The SDK session is not ready.");
	return query;
}

async function selectModel(app: AppController, requested: string): Promise<void> {
	const models = await requireQuery(app).supportedModels();
	const selected = models.find((model) => model.value === requested || model.resolvedModel === requested);
	if (!selected) {
		app.showNotice(`Model ${requested} is not in the SDK's current model list. Use /model to open the picker.`);
		return;
	}
	await requireQuery(app).setModel(selected.value);
	app.setSessionControl("model", selected.value);
	app.showNotice(`Model changed to ${selected.displayName} (${selected.value}).`);
}

async function selectEffort(app: AppController, requested: string): Promise<void> {
	const query = requireQuery(app);
	const models = await query.supportedModels();
	let modelId = app.sessionControls.model ?? app.reportedModel;
	if (!modelId) {
		const usage = await query.getContextUsage({ detail: "summary" });
		modelId = usage.model;
		app.setReportedModel(modelId);
	}
	const model = models.find((candidate) => candidate.value === modelId || candidate.resolvedModel === modelId);
	const levels = model?.supportedEffortLevels ?? [];
	if (!levels.includes(requested as EffortLevel)) {
		app.showNotice(`Effort ${requested} is not supported for ${modelId}. Available levels: ${levels.join(", ") || "none"}.`);
		return;
	}
	await query.applyFlagSettings({ effortLevel: requested as EffortLevel });
	app.setSessionControl("effort", requested as EffortLevel);
	app.showNotice(`Effort changed to ${requested}.`);
}

async function selectPermissionMode(app: AppController, requested: string | undefined): Promise<void> {
	if (!requested) {
		app.showNotice(`Permission modes: ${PERMISSION_MODES.join(", ")}. ${selectionLabel(app, "permissionMode")}`);
		return;
	}
	if (!PERMISSION_MODES.includes(requested as PermissionMode)) {
		app.showNotice(`Unsupported permission mode ${requested}. Available modes: ${PERMISSION_MODES.join(", ")}.`);
		return;
	}
	if (requested === "bypassPermissions" && !app.dangerousPermissionsEnabled) {
		app.showNotice("bypassPermissions requires the explicit --dangerously-skip-permissions launch option.");
		return;
	}
	await requireQuery(app).setPermissionMode(requested as PermissionMode);
	app.setSessionControl("permissionMode", requested as PermissionMode);
	app.showNotice(`Permission-mode selection ${requested} was accepted by the SDK. Effective runtime mode is not reported by this control.`);
}

async function setUltracode(app: AppController, enabled: boolean | undefined): Promise<void> {
	if (enabled === undefined) {
		app.showNotice(`Ultracode selection: ${app.sessionControls.ultracode === undefined ? "not selected in Phi" : app.sessionControls.ultracode ? "on" : "off"}.`);
		return;
	}
	await requireQuery(app).applyFlagSettings({ ultracode: enabled });
	app.setSessionControl("ultracode", enabled);
	app.showNotice(`Ultracode ${enabled ? "on" : "off"} was accepted by the SDK for this session.`);
}

async function setWorkflowSize(app: AppController, size: WorkflowSize | undefined): Promise<void> {
	if (size === undefined) {
		app.showNotice(`Workflow-size selection: ${app.sessionControls.workflowSize ?? "not selected in Phi"}.`);
		return;
	}
	await requireQuery(app).applyFlagSettings({ workflowSizeGuideline: size });
	app.setSessionControl("workflowSize", size);
	app.showNotice(`Workflow size ${size} was accepted by the SDK for this session.`);
}

async function showSessions(app: AppController): Promise<void> {
	const sessions = await app.listProjectSessions({ limit: 20, offset: 0 });
	if (sessions.length === 0) {
		app.showNotice("No SDK sessions were found for this project.");
		return;
	}
	app.showNotice(`Project sessions:\n${sessions.map((session) => `${session.sessionId === app.currentSessionId ? "› " : "  "}${session.sessionId} · ${session.summary || "untitled"}`).join("\n")}\nUse /phi resume <id> to open a session.`);
}

async function showOrReconnectMcp(app: AppController, serverName: string | undefined): Promise<void> {
	const query = requireQuery(app);
	const statuses = await query.mcpServerStatus();
	if (!serverName) {
		app.showMcpStatus(statuses);
		app.showNotice(formatMcpStatuses(statuses));
		return;
	}
	const server = statuses.find((status) => status.name === serverName);
	if (!server) {
		app.showNotice(`MCP server ${serverName} was not reported by the SDK.`);
		return;
	}
	await query.reconnectMcpServer(serverName);
	const updated = await query.mcpServerStatus();
	app.showMcpStatus(updated);
	app.showNotice(formatMcpStatuses(updated));
}

async function reloadNativeCommands(app: AppController): Promise<void> {
	const query = requireQuery(app);
	const plugins = await query.reloadPlugins();
	const skills = await query.reloadSkills();
	const outputStyles = await query.reloadOutputStyles();
	const commands = await query.supportedCommands();
	app.refreshNativeCommands(commands);
	app.showMcpStatus(plugins.mcpServers);
	const result = plugins.error_count > 0
		? `Reload finished with ${plugins.error_count} plugin error(s).`
		: `Reloaded SDK plugins, ${skills.skills.length} skills, and ${outputStyles.available_output_styles.length} output styles.`;
	app.showNotice(result);
}

function formatMcpStatuses(statuses: readonly { name: string; status: string; error?: string }[]): string {
	return statuses.length === 0
		? "The SDK reports no MCP servers."
		: `MCP servers:\n${statuses.map((status) => `${status.name}: ${status.status}${status.error ? ` · ${status.error}` : ""}`).join("\n")}`;
}

function formatStatus(app: AppController): string {
	const activeTasks = [...app.state.tasks.values()].filter((task) => task.status === "running").length;
	const selected = app.sessionControls;
	return [
		`Session: ${app.currentSessionId ?? "opening"}`,
		`Conversation: ${app.state.conversationId ?? "not reported"}`,
		`Working directory: ${app.state.cwd}`,
		`Foreground: ${app.state.effectiveStatus.foreground}; running SDK tasks: ${activeTasks}; background task IDs: ${app.state.liveBackgroundTaskIds.size}.`,
		`Model selected by Phi: ${selected.model ?? "none"}; last SDK-reported model: ${app.reportedModel ?? "not reported"}.`,
		`Effort selected by Phi: ${selected.effort ?? "none"}; permission mode selected by Phi: ${selected.permissionMode ?? "none"}.`,
	].join("\n");
}

function selectionLabel(app: AppController, key: "model" | "effort" | "permissionMode"): string {
	const value = app.sessionControls[key];
	return `${key} selected by Phi: ${value ?? "none"}; last SDK-reported model: ${app.reportedModel ?? "not reported"}.`;
}

function unquotePath(path: string): string {
	if (path.length >= 2 && ((path.startsWith('"') && path.endsWith('"')) || (path.startsWith("'") && path.endsWith("'")))) {
		return path.slice(1, -1);
	}
	return path;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
