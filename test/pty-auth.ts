import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { ProcessTerminal } from "@earendil-works/pi-tui";
import { loginPhiAuth, phiAuthSource, preparePhiAuth } from "../src/auth.js";
import { importClaudeCustomizations } from "../src/claude-import.js";
import { runCli, type CliDependencies } from "../src/cli-main.js";
import { deletePhiApiKey, ensurePhiHome, readPhiApiKey, resolvePhiHome } from "../src/home.js";
import { promptForPhiApiKey } from "../src/auth-prompt.js";

type Scenario = "save-restart" | "cancel";

const scenario = process.argv[2] as Scenario | undefined;
const markerPath = process.env.PHI_PTY_MARKERS;
const testKey = "phi_pty_test_saved_secret";
let promptCalls = 0;
let runAppCalls = 0;

function record(event: string, detail: Record<string, unknown> = {}): void {
	if (!markerPath) return;
	appendFileSync(markerPath, `${JSON.stringify({ event, ...detail })}\n`, "utf8");
}

async function waitForRawTerminal(): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!process.stdin.isRaw) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for hidden input terminal mode");
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
	record("terminal-raw", { isRaw: process.stdin.isRaw });
	record("app-ready");
}

async function run(): Promise<void> {
	if ((scenario !== "save-restart" && scenario !== "cancel") || !markerPath || !process.env.PHI_HOME) {
		throw new Error("PTY auth scenario, marker path, and isolated Phi home are required");
	}
	const environment = { ...process.env };
	const userHome = homedir();
	const home = resolvePhiHome(environment, userHome);
	const inheritedKey = environment.ANTHROPIC_API_KEY;
	const dependencies: CliDependencies = {
		environment,
		userHome,
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
		promptForApiKey: async () => {
			promptCalls += 1;
			if (promptCalls !== 1) throw new Error("Saved auth unexpectedly requested another prompt");
			const result = promptForPhiApiKey(new ProcessTerminal());
			await waitForRawTerminal();
			return result;
		},
		importCustomizations: importClaudeCustomizations,
		runApp: async (_launch, appDependencies) => {
			runAppCalls += 1;
			record("run-app", {
				authSource: await phiAuthSource(home, environment),
				apiKeyMatches: appDependencies.environment.ANTHROPIC_API_KEY === testKey,
				parentEnvironmentUnchanged: process.env.ANTHROPIC_API_KEY === inheritedKey,
				backendQueries: 0,
			});
			return 0;
		},
		readVersion: async () => "0.1.0-test",
	};

	const loginCode = await runCli(["auth", "login"], dependencies);
	const savedKey = await readPhiApiKey(home);
	if (scenario === "cancel") {
		record("auth-login-cancelled", {
			code: loginCode,
			authSource: await phiAuthSource(home, environment),
			saved: savedKey !== undefined,
			runAppCalls,
		});
		if (loginCode !== 1 || savedKey !== undefined || runAppCalls !== 0) {
			throw new Error("Auth cancellation did not leave saved auth absent");
		}
		return;
	}

	record("auth-login-saved", {
		code: loginCode,
		apiKeyMatches: savedKey === testKey,
		authSource: await phiAuthSource(home, environment),
	});
	if (loginCode !== 0 || savedKey !== testKey) throw new Error("Auth login did not save the synthetic key");

	const restartCode = await runCli([], dependencies);
	record("auth-restart-complete", {
		code: restartCode,
		promptCalls,
		runAppCalls,
		parentEnvironmentUnchanged: process.env.ANTHROPIC_API_KEY === inheritedKey,
	});
	if (restartCode !== 0 || promptCalls !== 1 || runAppCalls !== 1) {
		throw new Error("Saved auth restart did not reach the injected app exactly once");
	}
}

void run().then(
	() => { process.exitCode = 0; },
	() => {
		record("wrapper-error");
		process.stderr.write("PTY auth wrapper failed.\n");
		process.exitCode = 1;
	},
);
