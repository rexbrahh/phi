#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { ProcessTerminal } from "@earendil-works/pi-tui";
import { loginPhiAuth, phiAuthSource, preparePhiAuth } from "./auth.js";
import { importClaudeCustomizations } from "./claude-import.js";
import { runCli } from "./cli-main.js";
import { deletePhiApiKey, ensurePhiHome, readPhiApiKey, resolvePhiHome } from "./home.js";
import { promptForPhiApiKey } from "./auth-prompt.js";
import { runApp } from "./ui/app.js";

const environment = { ...process.env };

void runCli(process.argv.slice(2), {
	environment,
	userHome: homedir(),
	isInteractive: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
	stdout: process.stdout,
	stderr: process.stderr,
	resolvePhiHome,
	ensurePhiHome,
	preparePhiAuth,
	loginPhiAuth,
	phiAuthSource,
	readPhiApiKey,
	deletePhiApiKey,
	promptForApiKey: () => promptForPhiApiKey(new ProcessTerminal()),
	importCustomizations: importClaudeCustomizations,
	runApp: (launch, dependencies) => runApp(launch, dependencies),
	readVersion: async () => {
		const packageText = await readFile(new URL("../../package.json", import.meta.url), "utf8");
		const packageInfo = JSON.parse(packageText) as { version?: unknown };
		return typeof packageInfo.version === "string" ? packageInfo.version : "unknown";
	},
}).then(
	(code) => {
		process.exitCode = code;
	},
	() => {
		process.stderr.write("Phi stopped unexpectedly.\n");
		process.exitCode = 1;
	},
);
