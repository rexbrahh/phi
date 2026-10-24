import { join } from "node:path";
import { ArgumentError, parseArgs, type LaunchOptions } from "./config.js";
import type { loginPhiAuth, phiAuthSource, preparePhiAuth } from "./auth.js";
import type { importClaudeCustomizations } from "./claude-import.js";
import type { deletePhiApiKey, ensurePhiHome, readPhiApiKey, resolvePhiHome } from "./home.js";
import { sanitizeTerminalText } from "./ui/safe-text.js";

const HELP = `Phi — a local coding terminal powered by the Claude Agent SDK

Usage: phi [options]

Options:
  --cwd <path>                  Start in a directory
  --resume <session-id>         Resume a session by UUID
  --continue                    Resume the newest session in the launch directory
  --model <name>                Select a model
  --effort <level>              Select low, medium, high, xhigh, or max effort
  --permission-mode <mode>      Select a supported permission mode
  --plugin-dir <path>           Load a local plugin directory (repeatable)
  --max-budget-usd <amount>     Set a maximum model budget
  --dangerously-skip-permissions Allow the bypass permission mode
  --help                        Show this help
  --version                     Show the installed version

Use /phi help inside Phi for local UI keys. Use "phi auth --help" for saved API key commands.
SDK slash commands and @ mentions pass through unchanged.
`;

const AUTH_HELP = `Usage: phi auth <login|status|logout>

Commands:
  login   Prompt for and save or replace the Phi API key (requires a TTY)
  status  Show the active authentication source and Phi auth path
  logout  Delete only the saved Phi API key

API keys are entered through hidden input. There is no API key command-line flag.
`;

export interface CliDependencies {
	environment: NodeJS.ProcessEnv;
	userHome: string;
	isInteractive(): boolean;
	stdout: { write(text: string): unknown };
	stderr: { write(text: string): unknown };
	resolvePhiHome: typeof resolvePhiHome;
	ensurePhiHome: typeof ensurePhiHome;
	preparePhiAuth: typeof preparePhiAuth;
	loginPhiAuth: typeof loginPhiAuth;
	phiAuthSource: typeof phiAuthSource;
	readPhiApiKey: typeof readPhiApiKey;
	deletePhiApiKey: typeof deletePhiApiKey;
	promptForApiKey: () => Promise<string | undefined>;
	importCustomizations: typeof importClaudeCustomizations;
	runApp(
		launch: LaunchOptions,
		dependencies: { environment: NodeJS.ProcessEnv },
	): Promise<number>;
	readVersion(): Promise<string>;
}

export async function runCli(argv: string[], dependencies: CliDependencies): Promise<number> {
	const secrets = new Set<string>();
	const inheritedKey = dependencies.environment.ANTHROPIC_API_KEY;
	if (inheritedKey) secrets.add(inheritedKey);

	try {
		if (argv[0] === "auth") return await runAuth(argv.slice(1), dependencies, secrets);

		let launch: LaunchOptions;
		try {
			launch = parseArgs(argv, dependencies.environment);
		} catch (error) {
			if (error instanceof ArgumentError) {
				dependencies.stderr.write(`${safeArgumentError(error, argv, secrets)}\n\n${HELP}`);
				return 2;
			}
			dependencies.stderr.write(`Could not parse arguments: ${safeText(errorText(error), secrets)}\n`);
			return 1;
		}

		if (launch.help) {
			dependencies.stdout.write(HELP);
			return 0;
		}
		if (launch.version) {
			try {
				dependencies.stdout.write(`${await dependencies.readVersion()}\n`);
				return 0;
			} catch (error) {
				dependencies.stderr.write(`Could not read the Phi package version: ${safeText(errorText(error), secrets)}\n`);
				return 1;
			}
		}

		if (!dependencies.isInteractive()) {
			dependencies.stderr.write("Phi requires an interactive terminal.\n");
			return 2;
		}

		const home = launch.home;
		await dependencies.ensurePhiHome(home);

		const explicitSource = dependencies.environment.CLAUDE_CONFIG_DIR;
		const sourceRoot = explicitSource === undefined ? join(dependencies.userHome, ".claude") : explicitSource;
		const globalConfigPath = explicitSource === undefined
			? join(dependencies.userHome, ".claude.json")
			: join(explicitSource, ".claude.json");
		await dependencies.importCustomizations(sourceRoot, home, globalConfigPath);

		const environment = await dependencies.preparePhiAuth(home, dependencies.environment, dependencies.promptForApiKey);
		if (!environment) return 0;
		const selectedKey = environment.ANTHROPIC_API_KEY;
		if (selectedKey) secrets.add(selectedKey);

		return await dependencies.runApp(launch, { environment });
	} catch (error) {
		dependencies.stderr.write(`Phi stopped unexpectedly: ${safeText(errorText(error), secrets)}\n`);
		return 1;
	}
}

async function runAuth(
	argv: string[],
	dependencies: CliDependencies,
	secrets: ReadonlySet<string>,
): Promise<number> {
	if (argv.includes("--help") || argv[0] === "help" || argv.length === 0) {
		dependencies.stdout.write(AUTH_HELP);
		return 0;
	}

	const command = argv[0];
	if (command !== "login" && command !== "status" && command !== "logout") {
		dependencies.stderr.write(`Unknown auth command.\n\n${AUTH_HELP}`);
		return 2;
	}
	if (argv.length !== 1) {
		dependencies.stderr.write(`phi auth ${command} does not accept arguments.\n\n${AUTH_HELP}`);
		return 2;
	}

	if (command === "login" && !dependencies.isInteractive()) {
		dependencies.stderr.write("phi auth login requires an interactive terminal.\n");
		return 2;
	}

	const home = dependencies.resolvePhiHome(dependencies.environment, dependencies.userHome);
	const authPath = join(home, "auth.json");
	if (command === "login") {
		const saved = await dependencies.loginPhiAuth(home, dependencies.promptForApiKey);
		if (!saved) {
			dependencies.stdout.write("Login cancelled.\n");
			return 1;
		}
		dependencies.stdout.write(`Saved Phi auth: ${safeText(authPath, secrets)}\n`);
		if (await dependencies.phiAuthSource(home, dependencies.environment) === "environment") {
			dependencies.stdout.write("ANTHROPIC_API_KEY overrides saved Phi auth for coding launches.\n");
		}
		return 0;
	}

	if (command === "status") {
		const source = await dependencies.phiAuthSource(home, dependencies.environment);
		dependencies.stdout.write(`Source: ${source}\nPath: ${safeText(authPath, secrets)}\n`);
		if (source === "environment") {
			dependencies.stdout.write("ANTHROPIC_API_KEY overrides any saved Phi auth.\n");
		}
		return 0;
	}

	await dependencies.deletePhiApiKey(home);
	dependencies.stdout.write(`Deleted saved Phi auth if present: ${safeText(authPath, secrets)}\n`);
	if (await dependencies.phiAuthSource(home, dependencies.environment) === "environment") {
		dependencies.stdout.write("ANTHROPIC_API_KEY remains active and was not changed.\n");
	}
	return 0;
}

function safeArgumentError(error: ArgumentError, argv: string[], secrets: ReadonlySet<string>): string {
	if (error.message.startsWith("Unknown option:")) return "Unknown option.";
	if (error.message.startsWith("Unexpected positional argument:")) return "Unexpected positional argument.";
	let message = error.message;
	for (const argument of argv) {
		if (argument.startsWith("--") && argument.includes("=")) {
			const value = argument.slice(argument.indexOf("=") + 1);
			if (value) message = redactArgumentValue(message, value);
		} else if (argument.length > 0 && !argument.startsWith("-")) {
			message = redactArgumentValue(message, argument);
		}
	}
	return safeText(message, secrets);
}

function redactArgumentValue(message: string, value: string): string {
	const escaped = value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
	return message.replace(new RegExp(`(?<!\\S)${escaped}(?!\\S)`, "gu"), "[redacted]");
}

function safeText(value: string, secrets: ReadonlySet<string>): string {
	let safe = value;
	for (const secret of secrets) {
		if (secret) safe = safe.split(secret).join("[redacted]");
	}
	return sanitizeTerminalText(safe);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
