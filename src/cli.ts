#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { ArgumentError, parseArgs } from "./config.js";
import { runApp } from "./ui/app.js";
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

Use /phi help inside Phi for local UI keys. SDK slash commands and @ mentions pass through unchanged.
`;

async function main(argv: string[]): Promise<number> {
	let launch;
	try {
		launch = parseArgs(argv);
	} catch (error) {
		if (error instanceof ArgumentError) {
			process.stderr.write(`${sanitizeTerminalText(error.message)}\n\n${HELP}`);
			return 2;
		}
		process.stderr.write(`Could not parse arguments: ${sanitizeTerminalText(errorText(error))}\n`);
		return 1;
	}

	if (launch.help) {
		process.stdout.write(HELP);
		return 0;
	}
	if (launch.version) {
		try {
			const packageText = await readFile(new URL("../../package.json", import.meta.url), "utf8");
			const packageInfo = JSON.parse(packageText) as { version?: unknown };
			process.stdout.write(`${typeof packageInfo.version === "string" ? packageInfo.version : "unknown"}\n`);
			return 0;
		} catch (error) {
			process.stderr.write(`Could not read the Phi package version: ${sanitizeTerminalText(errorText(error))}\n`);
			return 1;
		}
	}

	return runApp(launch);
}

void main(process.argv.slice(2)).then(
	(code) => {
		process.exitCode = code;
	},
	(error: unknown) => {
		process.stderr.write(`Phi stopped unexpectedly: ${sanitizeTerminalText(errorText(error))}\n`);
		process.exitCode = 1;
	},
);

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
