import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type {
	EffortLevel,
	Options,
	PermissionMode,
} from "@anthropic-ai/claude-agent-sdk";

export interface LaunchOptions {
	cwd: string;
	resume?: string;
	continue: boolean;
	model?: string;
	effort?: EffortLevel;
	permissionMode?: PermissionMode;
	pluginDirs: string[];
	maxBudgetUsd?: number;
	dangerouslySkipPermissions: boolean;
	help: boolean;
	version: boolean;
}

export class ArgumentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ArgumentError";
	}
}

const EFFORT_LEVELS: ReadonlySet<string> = new Set([
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

const PERMISSION_MODES: ReadonlySet<string> = new Set([
	"default",
	"acceptEdits",
	"bypassPermissions",
	"plan",
	"dontAsk",
	"auto",
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseArgs(argv: string[]): LaunchOptions {
	let cwd = resolve(process.cwd());
	let resume: string | undefined;
	let continueSession = false;
	let model: string | undefined;
	let effort: EffortLevel | undefined;
	let permissionMode: PermissionMode | undefined;
	let maxBudgetUsd: number | undefined;
	const pluginDirs: string[] = [];
	let dangerouslySkipPermissions = false;
	let help = false;
	let version = false;

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === undefined) continue;

		switch (argument) {
			case "--cwd": {
				const value = readValue(argv, index, argument);
				cwd = resolveDirectory(value.value, argument);
				index = value.index;
				break;
			}
			case "--resume": {
				const value = readValue(argv, index, argument);
				if (!UUID_PATTERN.test(value.value)) {
					throw new ArgumentError("--resume must be a UUID");
				}
				resume = value.value;
				index = value.index;
				break;
			}
			case "--continue":
				continueSession = true;
				break;
			case "--model": {
				const value = readValue(argv, index, argument);
				model = requireNonEmpty(value.value, argument);
				index = value.index;
				break;
			}
			case "--effort": {
				const value = readValue(argv, index, argument);
				if (!EFFORT_LEVELS.has(value.value)) {
					throw new ArgumentError(`Unsupported effort level: ${value.value}`);
				}
				effort = value.value as EffortLevel;
				index = value.index;
				break;
			}
			case "--permission-mode": {
				const value = readValue(argv, index, argument);
				if (!PERMISSION_MODES.has(value.value)) {
					throw new ArgumentError(`Unsupported permission mode: ${value.value}`);
				}
				permissionMode = value.value as PermissionMode;
				index = value.index;
				break;
			}
			case "--plugin-dir": {
				const value = readValue(argv, index, argument);
				pluginDirs.push(resolve(requireNonEmpty(value.value, argument)));
				index = value.index;
				break;
			}
			case "--max-budget-usd": {
				const value = readValue(argv, index, argument);
				const budget = Number(value.value);
				if (!Number.isFinite(budget) || budget < 0) {
					throw new ArgumentError("--max-budget-usd must be a finite, non-negative number");
				}
				maxBudgetUsd = budget;
				index = value.index;
				break;
			}
			case "--dangerously-skip-permissions":
				dangerouslySkipPermissions = true;
				break;
			case "--help":
				help = true;
				break;
			case "--version":
				version = true;
				break;
			default:
				if (argument.startsWith("-")) {
					throw new ArgumentError(`Unknown option: ${argument}`);
				}
				throw new ArgumentError(`Unexpected positional argument: ${argument}`);
		}
	}

	if (resume && continueSession) {
		throw new ArgumentError("--resume and --continue are mutually exclusive");
	}
	if (permissionMode === "bypassPermissions" && !dangerouslySkipPermissions) {
		throw new ArgumentError("bypassPermissions requires --dangerously-skip-permissions");
	}

	return {
		cwd,
		...(resume ? { resume } : {}),
		continue: continueSession,
		...(model ? { model } : {}),
		...(effort ? { effort } : {}),
		...(permissionMode ? { permissionMode } : {}),
		pluginDirs,
		...(maxBudgetUsd === undefined ? {} : { maxBudgetUsd }),
		dangerouslySkipPermissions,
		help,
		version,
	};
}

export function buildOptions(
	launch: LaunchOptions,
	callbacks: Pick<Options, "canUseTool" | "onElicitation" | "hooks">,
): Options {
	const startsNewSession = !launch.resume && !launch.continue;

	return {
		...callbacks,
		cwd: launch.cwd,
		...(launch.resume ? { resume: launch.resume } : {}),
		...(launch.continue ? { continue: true } : {}),
		...(launch.model ? { model: launch.model } : {}),
		...(launch.effort ? { effort: launch.effort } : {}),
		...(launch.permissionMode ? { permissionMode: launch.permissionMode } : {}),
		...(launch.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: launch.maxBudgetUsd }),
		plugins: launch.pluginDirs.map((path) => ({ type: "local", path })),
		...(launch.dangerouslySkipPermissions ? { allowDangerouslySkipPermissions: true } : {}),
		...(startsNewSession ? { sessionId: randomUUID() } : {}),
		systemPrompt: { type: "preset", preset: "claude_code" },
		tools: { type: "preset", preset: "claude_code" },
		settingSources: ["user", "project", "local"],
		skills: "all",
		includePartialMessages: true,
		forwardSubagentText: true,
		includeHookEvents: true,
		enableFileCheckpointing: true,
		agentProgressSummaries: false,
		extraArgs: { "replay-user-messages": null },
		env: {
			...process.env,
			CLAUDE_AGENT_SDK_CLIENT_APP: "phi/0.1.0",
		},
	};
}

function readValue(argv: string[], index: number, option: string): { value: string; index: number } {
	const value = argv[index + 1];
	if (value === undefined || value.length === 0) {
		throw new ArgumentError(`${option} requires a value`);
	}
	return { value, index: index + 1 };
}

function requireNonEmpty(value: string, option: string): string {
	if (value.trim().length === 0) throw new ArgumentError(`${option} requires a non-empty value`);
	return value;
}

function resolveDirectory(value: string, option: string): string {
	const candidate = resolve(value);
	try {
		if (!statSync(candidate).isDirectory()) {
			throw new ArgumentError(`${option} must name a directory: ${value}`);
		}
		return realpathSync(candidate);
	} catch (error) {
		if (error instanceof ArgumentError) throw error;
		throw new ArgumentError(`${option} must name an existing directory: ${value}`);
	}
}
