import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { loginPhiAuth, phiAuthSource, preparePhiAuth } from "../src/auth.js";
import { runCli, type CliDependencies } from "../src/cli-main.js";
import { importClaudeCustomizations } from "../src/claude-import.js";
import { buildOptions } from "../src/config.js";
import { deletePhiApiKey, ensurePhiHome, readPhiApiKey, resolvePhiHome, savePhiApiKey } from "../src/home.js";

interface CliHarness {
	dependencies: CliDependencies;
	stdout: string[];
	stderr: string[];
}

async function withRoots(run: (parent: string, harness: CliHarness) => Promise<void>): Promise<void> {
	const parent = await mkdtemp(join(tmpdir(), "phi-cli-auth-test-"));
	try {
		const userHome = join(parent, "user-home");
		await mkdir(userHome, { recursive: true });
		const stdout: string[] = [];
		const stderr: string[] = [];
		const dependencies: CliDependencies = {
			environment: { HOME: userHome, PHI_HOME: join(parent, "phi-home") },
			userHome,
			isInteractive: () => true,
			stdout: { write: (text) => { stdout.push(text); } },
			stderr: { write: (text) => { stderr.push(text); } },
			resolvePhiHome,
			ensurePhiHome,
			preparePhiAuth,
			loginPhiAuth,
			phiAuthSource,
			readPhiApiKey,
			deletePhiApiKey,
			promptForApiKey: async () => undefined,
			importCustomizations: async () => ({ imported: [], skipped: [] }),
			runApp: async () => 0,
			readVersion: async () => "0.1.0-test",
		};
		await run(parent, { dependencies, stdout, stderr });
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
}

function combined(parts: string[]): string {
	return parts.join("");
}

test("first interactive launch saves a hidden prompt result before runApp receives it", async () => {
	await withRoots(async (parent, harness) => {
		const { dependencies, stdout, stderr } = harness;
		const events: string[] = [];
		const secret = "phi_test_first_run_secret";
		const home = resolvePhiHome(dependencies.environment, dependencies.userHome);
		const env = dependencies.environment;
		env.CLAUDE_CONFIG_DIR = join(parent, "legacy-config");
		dependencies.ensurePhiHome = async (path) => {
			events.push("ensure-home");
			await ensurePhiHome(path);
		};
		dependencies.importCustomizations = async (sourceRoot, destination, globalPath) => {
			events.push("import-customizations");
			assert.equal(sourceRoot, env.CLAUDE_CONFIG_DIR);
			assert.equal(destination, home);
			assert.equal(globalPath, join(env.CLAUDE_CONFIG_DIR as string, ".claude.json"));
			assert.equal((await lstat(destination)).isDirectory(), true);
			return { imported: [], skipped: [] };
		};
		dependencies.promptForApiKey = async () => {
			events.push("prompt");
			return secret;
		};
		dependencies.runApp = async (launch, appDependencies) => {
			events.push("run-app");
			assert.equal(launch.home, home);
			assert.equal(await readPhiApiKey(home), secret);
			assert.equal(appDependencies.environment.ANTHROPIC_API_KEY, secret);
			return 0;
		};

		assert.equal(await runCli([], dependencies), 0);
		assert.deepEqual(events, ["ensure-home", "import-customizations", "prompt", "run-app"]);
		assert.equal(combined(stdout).includes(secret), false);
		assert.equal(combined(stderr).includes(secret), false);
		assert.equal(dependencies.environment.ANTHROPIC_API_KEY, undefined);
	});
});

test("cancelled first-run auth exits without calling runApp", async () => {
	await withRoots(async (_parent, { dependencies, stdout, stderr }) => {
		let runAppCalls = 0;
		dependencies.promptForApiKey = async () => undefined;
		dependencies.runApp = async () => {
			runAppCalls += 1;
			return 0;
		};

		assert.equal(await runCli([], dependencies), 0);
		assert.equal(runAppCalls, 0);
		assert.equal(combined(stderr).includes("Phi stopped"), false);
		assert.equal(combined(stdout), "");
	});
});

test("restart uses the saved key without prompting again", async () => {
	await withRoots(async (_parent, { dependencies }) => {
		const secret = "phi_test_saved_key";
		let promptCalls = 0;
		const received: Array<string | undefined> = [];
		dependencies.promptForApiKey = async () => {
			promptCalls += 1;
			return secret;
		};
		dependencies.runApp = async (_launch, appDependencies) => {
			received.push(appDependencies.environment.ANTHROPIC_API_KEY);
			return 0;
		};

		assert.equal(await runCli([], dependencies), 0);
		dependencies.promptForApiKey = async () => {
			promptCalls += 1;
			throw new Error("saved auth should not prompt");
		};
		assert.equal(await runCli([], dependencies), 0);
		assert.equal(promptCalls, 1);
		assert.deepEqual(received, [secret, secret]);
	});
});

test("environment auth overrides saved auth without rewriting it", async () => {
	await withRoots(async (_parent, { dependencies }) => {
		const home = resolvePhiHome(dependencies.environment, dependencies.userHome);
		const savedKey = "phi_test_saved_original";
		const environmentKey = "phi_test_environment_override";
		await savePhiApiKey(home, savedKey);
		dependencies.environment.ANTHROPIC_API_KEY = environmentKey;
		let received: string | undefined;
		dependencies.runApp = async (_launch, appDependencies) => {
			received = appDependencies.environment.ANTHROPIC_API_KEY;
			return 0;
		};

		assert.equal(await runCli([], dependencies), 0);
		assert.equal(received, environmentKey);
		assert.equal(await readPhiApiKey(home), savedKey);
		assert.equal(dependencies.environment.ANTHROPIC_API_KEY, environmentKey);
	});
});

test("help, version, and non-TTY refusal do not create a Phi home", async () => {
	await withRoots(async (_parent, { dependencies, stdout, stderr }) => {
		const home = resolvePhiHome(dependencies.environment, dependencies.userHome);
		let imports = 0;
		let prompts = 0;
		let runAppCalls = 0;
		dependencies.importCustomizations = async () => {
			imports += 1;
			return { imported: [], skipped: [] };
		};
		dependencies.promptForApiKey = async () => {
			prompts += 1;
			return "phi_test_unused";
		};
		dependencies.runApp = async () => {
			runAppCalls += 1;
			return 0;
		};

		assert.equal(await runCli(["--help"], dependencies), 0);
		assert.equal(await runCli(["--version"], dependencies), 0);
		dependencies.isInteractive = () => false;
		assert.equal(await runCli([], dependencies), 2);
		await assert.rejects(lstat(home), { code: "ENOENT" });
		assert.equal(imports, 0);
		assert.equal(prompts, 0);
		assert.equal(runAppCalls, 0);
		assert.match(combined(stdout), /phi auth --help/u);
		assert.match(combined(stdout), /0\.1\.0-test/u);
		assert.match(combined(stderr), /interactive terminal/u);
	});
});

test("auth help and non-TTY login do not create a Phi home", async () => {
	await withRoots(async (_parent, { dependencies, stdout, stderr }) => {
		const home = resolvePhiHome(dependencies.environment, dependencies.userHome);
		let prompts = 0;
		dependencies.promptForApiKey = async () => {
			prompts += 1;
			return "phi_test_unused";
		};
		dependencies.isInteractive = () => false;

		assert.equal(await runCli(["auth", "--help"], dependencies), 0);
		assert.equal(await runCli(["auth", "status"], dependencies), 0);
		assert.equal(await runCli(["auth", "login"], dependencies), 2);
		await assert.rejects(lstat(home), { code: "ENOENT" });
		assert.equal(prompts, 0);
		assert.match(combined(stdout), /Usage: phi auth/u);
		assert.match(combined(stdout), /Source: missing/u);
		assert.match(combined(stderr), /requires an interactive terminal/u);
	});
});

test("auth login, status, and logout never print synthetic secrets", async () => {
	await withRoots(async (_parent, harness) => {
		const { dependencies, stdout, stderr } = harness;
		const home = resolvePhiHome(dependencies.environment, dependencies.userHome);
		const authSecret = "phi_test_auth_command_saved_secret";
		const environmentSecret = "phi_test_auth_command_environment_secret";
		dependencies.promptForApiKey = async () => authSecret;
		assert.equal(await runCli(["auth", "login"], dependencies), 0);
		assert.equal(await runCli(["auth", "status"], dependencies), 0);
		dependencies.environment.ANTHROPIC_API_KEY = environmentSecret;
		assert.equal(await runCli(["auth", "status"], dependencies), 0);

		const historyPath = join(home, "history.jsonl");
		await writeFile(historyPath, "retained history\n");
		assert.equal(await runCli(["auth", "logout"], dependencies), 0);
		assert.equal(await readPhiApiKey(home), undefined);
		assert.equal(await readFile(historyPath, "utf8"), "retained history\n");
		assert.equal(dependencies.environment.ANTHROPIC_API_KEY, environmentSecret);
		const output = combined(stdout);
		const errors = combined(stderr);
		assert.equal(output.includes(authSecret), false);
		assert.equal(output.includes(environmentSecret), false);
		assert.equal(errors.includes(authSecret), false);
		assert.equal(errors.includes(environmentSecret), false);
		assert.match(output, /Source: saved/u);
		assert.match(output, /Source: environment/u);
		assert.match(output, /Path: .*auth\.json/u);
		assert.match(output, /overrides any saved Phi auth/u);
		assert.match(output, /remains active/u);
	});
});

test("legacy import paths follow CLAUDE_CONFIG_DIR and default to the user home", async () => {
	await withRoots(async (_parent, { dependencies }) => {
		const calls: Array<[string, string, string | undefined]> = [];
		dependencies.importCustomizations = async (source, destination, globalConfig) => {
			calls.push([source, destination, globalConfig]);
			return { imported: [], skipped: [] };
		};
		dependencies.promptForApiKey = async () => "phi_test_import_path";
		dependencies.runApp = async () => 0;

		const explicitSource = join(dependencies.userHome, "custom-claude-config");
		dependencies.environment.CLAUDE_CONFIG_DIR = explicitSource;
		assert.equal(await runCli([], dependencies), 0);
		delete dependencies.environment.CLAUDE_CONFIG_DIR;
		assert.equal(await runCli([], dependencies), 0);
		dependencies.environment.CLAUDE_CONFIG_DIR = "";
		assert.equal(await runCli([], dependencies), 0);

		const home = resolvePhiHome(dependencies.environment, dependencies.userHome);
		assert.deepEqual(calls, [
			[explicitSource, home, join(explicitSource, ".claude.json")],
			[join(dependencies.userHome, ".claude"), home, join(dependencies.userHome, ".claude.json")],
			[join(dependencies.userHome, ".claude"), home, join(dependencies.userHome, ".claude.json")],
		]);
	});
});

test("real importer and saved auth share Phi plugin and runtime roots without mutating the parent environment", async () => {
	await withRoots(async (parent, { dependencies }) => {
		const source = join(parent, "legacy-claude");
		const home = resolvePhiHome(dependencies.environment, dependencies.userHome);
		const legacyKey = "legacy_auth_must_not_be_imported";
		const syntheticKey = "phi_test_full_home_restart_key";
		const pluginSource = join(source, "plugins", "cache", "demo");
		const marketplaceSource = join(source, "plugins", "marketplaces", "local");
		const parentApiKey = process.env.ANTHROPIC_API_KEY;
		const parentConfigRoot = process.env.CLAUDE_CONFIG_DIR;
		await mkdir(pluginSource, { recursive: true });
		await mkdir(marketplaceSource, { recursive: true });
		await mkdir(join(source, "projects"), { recursive: true });
		await mkdir(join(source, "file-history"), { recursive: true });
		await writeFile(join(source, "settings.json"), JSON.stringify({
			apiKeyHelper: "printf legacy-helper",
			env: {
				ANTHROPIC_API_KEY: legacyKey,
				CLAUDE_CONFIG_DIR: source,
				ANTHROPIC_BASE_URL: "https://legacy.invalid",
				PHI_IMPORTED_SETTING: "preserved",
			},
			hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "printf untouched-hook" }] }] },
		}));
		await writeFile(join(source, "credentials.json"), JSON.stringify({ apiKey: legacyKey }));
		await writeFile(join(source, "projects", "old-session.jsonl"), "legacy conversation history\n");
		await writeFile(join(source, "file-history", "old-entry"), "legacy file history\n");
		await writeFile(join(source, ".claude.json"), JSON.stringify({
			oauthAccount: { token: legacyKey },
			projects: { "/legacy/project": { trusted: true } },
			mcpServers: { fixture: { command: "synthetic-mcp" } },
		}));
		await writeFile(join(source, "plugins", "installed_plugins.json"), JSON.stringify({
			plugins: { "demo@local": [{ installPath: pluginSource }] },
		}));
		await writeFile(join(source, "plugins", "known_marketplaces.json"), JSON.stringify({
			local: { installLocation: marketplaceSource },
		}));
		dependencies.environment.CLAUDE_CONFIG_DIR = source;
		dependencies.importCustomizations = async (sourceRoot, destination, globalConfigPath) =>
			importClaudeCustomizations(sourceRoot, destination, globalConfigPath);

		let promptCalls = 0;
		const runtimeRoots: string[] = [];
		dependencies.promptForApiKey = async () => {
			promptCalls += 1;
			if (promptCalls > 1) throw new Error("saved restart unexpectedly prompted");
			return syntheticKey;
		};
		dependencies.runApp = async (launch, appDependencies) => {
			assert.equal(launch.home, home);
			assert.notEqual(appDependencies.environment, dependencies.environment);
			assert.notEqual(appDependencies.environment, process.env);
			assert.equal(appDependencies.environment.ANTHROPIC_API_KEY, syntheticKey);
			const callbacks = {
				canUseTool: async () => ({ behavior: "deny" as const, message: "offline test" }),
				onElicitation: async () => ({ action: "decline" as const }),
				hooks: {},
			};
			const options = buildOptions(launch, callbacks, appDependencies.environment);
			assert.equal(options.env?.ANTHROPIC_API_KEY, syntheticKey);
			assert.equal(options.env?.CLAUDE_CONFIG_DIR, home);
			assert.equal(options.env?.CLAUDE_CODE_PLUGIN_CACHE_DIR, join(home, "plugins"));
			runtimeRoots.push(options.env?.CLAUDE_CODE_PLUGIN_CACHE_DIR ?? "");
			return 0;
		};

		assert.equal(await runCli([], dependencies), 0);
		assert.equal(await readPhiApiKey(home), syntheticKey);
		dependencies.promptForApiKey = async () => {
			promptCalls += 1;
			throw new Error("saved restart unexpectedly prompted");
		};
		assert.equal(await runCli([], dependencies), 0);
		assert.equal(promptCalls, 1);
		assert.deepEqual(runtimeRoots, [join(home, "plugins"), join(home, "plugins")]);
		assert.equal(await readPhiApiKey(home), syntheticKey);

		const installed = JSON.parse(await readFile(join(home, "plugins", "installed_plugins.json"), "utf8")) as {
			plugins: Record<string, Array<{ installPath: string }>>;
		};
		const marketplace = JSON.parse(await readFile(join(home, "plugins", "known_marketplaces.json"), "utf8")) as {
			local: { installLocation: string };
		};
		const pluginRoot = join(home, "plugins");
		assert.equal(installed.plugins["demo@local"]?.[0]?.installPath, join(pluginRoot, "cache", "demo"));
		assert.equal(marketplace.local.installLocation, join(pluginRoot, "marketplaces", "local"));
		assert.equal(runtimeRoots[0], pluginRoot);
		assert.deepEqual(JSON.parse(await readFile(join(home, "settings.json"), "utf8")), {
			env: { PHI_IMPORTED_SETTING: "preserved" },
			hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "printf untouched-hook" }] }] },
		});
		assert.deepEqual(JSON.parse(await readFile(join(home, ".claude.json"), "utf8")), {
			mcpServers: { fixture: { command: "synthetic-mcp" } },
		});
		for (const excluded of ["credentials.json", "projects", "file-history"]) {
			await assert.rejects(lstat(join(home, excluded)), { code: "ENOENT" });
		}
		assert.equal(dependencies.environment.ANTHROPIC_API_KEY, undefined);
		assert.equal(dependencies.environment.CLAUDE_CONFIG_DIR, source);
		assert.equal(process.env.ANTHROPIC_API_KEY, parentApiKey);
		assert.equal(process.env.CLAUDE_CONFIG_DIR, parentConfigRoot);
	});
});
