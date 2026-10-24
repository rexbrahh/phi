import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readlink, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { importClaudeCustomizations } from "../src/claude-import.js";

const EXCLUDED = ["file-history", "debug", "credentials.json"];
const SHELL_COMMAND = "printf '$HOME is literal here' && echo untouched";

async function withFixture(run: (root: string, source: string, home: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "phi-claude-import-"));
	const source = join(root, "legacy");
	const home = join(root, "phi-home");
	try {
		await mkdir(source);
		await run(root, source, home);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function snapshotTree(root: string): Promise<string> {
	const entries: string[] = [];
	const visit = async (path: string, name: string): Promise<void> => {
		const metadata = await lstat(path);
		const kind = metadata.isSymbolicLink() ? "link" : metadata.isDirectory() ? "directory" : "file";
		entries.push(`${name}\0${kind}\0${metadata.mode & 0o777}`);
		if (metadata.isSymbolicLink()) entries.push(await readlink(path));
		else if (metadata.isDirectory()) {
			for (const child of (await readdir(path)).sort()) await visit(join(path, child), `${name}/${child}`);
		} else if (metadata.isFile()) entries.push((await readFile(path)).toString("base64"));
	};
	await visit(root, ".");
	return entries.join("\n");
}

test("imports named customizations, filters auth and history, and remaps plugin paths", async () => {
	await withFixture(async (root, source, home) => {
		const externalSkill = join(root, "shared-skill");
		await mkdir(externalSkill);
		await writeFile(join(externalSkill, "SKILL.md"), "synthetic skill\n");
		await mkdir(join(source, "skills"));
		await symlink(externalSkill, join(source, "skills", "shared"));
		await mkdir(join(source, "agents"));
		await mkdir(join(source, "commands"));
		await mkdir(join(source, "hooks"));
		await mkdir(join(source, "rules"));
		await mkdir(join(source, "output-styles"));
		await mkdir(join(source, "plugins", "cache", "demo", "bin"), { recursive: true });
		await mkdir(join(source, "plugins", "marketplaces", "local"), { recursive: true });
		await writeFile(join(source, "CLAUDE.md"), "synthetic instructions\n");
		await writeFile(join(source, "agents", "reviewer.md"), "synthetic agent\n");
		await writeFile(join(source, "commands", "review.md"), "synthetic command\n");
		await writeFile(join(source, "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		await writeFile(join(source, "rules", "safe.md"), "synthetic rule\n");
		await writeFile(join(source, "output-styles", "plain.md"), "synthetic style\n");
		const settings = {
			apiKeyHelper: "synthetic-helper-secret",
			awsAuthRefresh: "synthetic-refresh-secret",
			awsCredentialExport: "synthetic-export-secret",
			forceLoginMethod: "claudeai",
			forceLoginOrgUUID: "synthetic-org-id",
			env: {
				ANTHROPIC_API_KEY: "synthetic-api-secret",
				ANTHROPIC_AUTH_TOKEN: "synthetic-token-secret",
				CLAUDE_CODE_OAUTH_TOKEN: "synthetic-oauth-secret",
			CLAUDE_CODE_API_KEY_HELPER_TTL_MS: "3600000",
				CLAUDE_CONFIG_DIR: source,
				CLAUDE_CODE_PLUGIN_CACHE_DIR: join(source, "plugins", "cache"),
				ANTHROPIC_BASE_URL: "https://synthetic.invalid",
			ANTHROPIC_VERTEX_BASE_URL: "https://vertex.synthetic.invalid",
			ANTHROPIC_MODEL: "synthetic-model",
				CLAUDE_CODE_USE_BEDROCK: "1",
				CUSTOM_SETTING: "preserved",
			},
			permissions: { allow: ["Bash(echo safe)"] },
			hooks: { PreToolUse: [{ hooks: [{ type: "command", command: SHELL_COMMAND }] }] },
		};
		const originalSettings = JSON.stringify(settings);
		await writeFile(join(source, "settings.json"), originalSettings);
		await writeFile(join(source, "plugins", "cache", "demo", "bin", "hook"), "#!/bin/sh\nexit 0\n", { mode: 0o751 });
		await writeFile(join(source, "plugins", "cache", "demo", "plugin.json"), JSON.stringify({
			installPath: join(source, "plugins", "cache", "demo"),
			command: `echo ${join(source, "plugins", "cache", "demo")}`,
		}));
		await writeFile(join(source, "plugins", "marketplaces", "local", "marketplace.json"), "{}\n");
		await writeFile(join(source, "plugins", "installed_plugins.json"), JSON.stringify({
			plugins: { "demo@local": [{ installPath: join(source, "plugins", "cache", "demo") }] },
		}));
		await writeFile(join(source, "plugins", "known_marketplaces.json"), JSON.stringify({
			local: { installLocation: join(source, "plugins", "marketplaces", "local") },
		}));
		await writeFile(join(source, "global.json"), JSON.stringify({
			oauthAccount: { secret: "synthetic-account-secret" },
			projects: { "/synthetic/project": { hasTrustDialogAccepted: true } },
			mcpServers: { demo: { command: "synthetic-mcp", env: { TOKEN: "synthetic-mcp-secret" } } },
		}));
		for (const name of EXCLUDED) await writeFile(join(source, name), "must not copy\n");
		await mkdir(join(source, "projects"));
		await writeFile(join(source, "projects", "session.jsonl"), "synthetic session\n");
		await mkdir(join(source, "plugins", "logs"), { recursive: true });
		await writeFile(join(source, "plugins", "logs", "runtime.log"), "synthetic plugin runtime\n");
		const sourceMode = (await lstat(join(source, "hooks", "pre-commit"))).mode & 0o777;
		const sourceSnapshot = await snapshotTree(source);

		const result = await importClaudeCustomizations(source, home, join(source, "global.json"));
		assert.ok(result.imported.includes("settings.json"));
		assert.ok(result.imported.includes("plugins/cache"));
		assert.equal(await readFile(join(home, "skills", "shared", "SKILL.md"), "utf8"), "synthetic skill\n");
		assert.equal((await lstat(join(home, "skills", "shared"))).isSymbolicLink(), false);
		assert.equal(await readFile(join(home, "hooks", "pre-commit"), "utf8"), "#!/bin/sh\nexit 0\n");
		assert.equal((await lstat(join(home, "hooks", "pre-commit"))).mode & 0o111, sourceMode & 0o111);
		assert.equal((await lstat(join(home, "plugins", "cache", "demo", "bin", "hook"))).mode & 0o111, 0o751 & 0o111);

		const copiedSettings = JSON.parse(await readFile(join(home, "settings.json"), "utf8")) as Record<string, unknown>;
		assert.equal("apiKeyHelper" in copiedSettings, false);
		assert.equal("awsAuthRefresh" in copiedSettings, false);
		assert.equal("awsCredentialExport" in copiedSettings, false);
		assert.equal("forceLoginMethod" in copiedSettings, false);
		assert.deepEqual(copiedSettings.env, { CUSTOM_SETTING: "preserved" });
		assert.deepEqual(copiedSettings.permissions, settings.permissions);
		assert.equal(((copiedSettings.hooks as typeof settings.hooks).PreToolUse[0]?.hooks[0]?.command), SHELL_COMMAND);
		assert.equal((await lstat(join(home, "settings.json"))).mode & 0o777, 0o600);

		for (const file of ["plugins/installed_plugins.json", "plugins/known_marketplaces.json"]) {
			const parsed = JSON.parse(await readFile(join(home, file), "utf8")) as Record<string, unknown>;
			const text = JSON.stringify(parsed);
			assert.ok(!text.includes(source));
		}
		const plugin = JSON.parse(await readFile(join(home, "plugins/cache/demo/plugin.json"), "utf8")) as Record<string, string>;
		assert.equal(plugin.installPath, join(home, "plugins", "cache", "demo"));
		assert.equal(plugin.command, `echo ${join(source, "plugins", "cache", "demo")}`);
		const installed = JSON.parse(await readFile(join(home, "plugins/installed_plugins.json"), "utf8")) as {
			plugins: Record<string, Array<{ installPath: string }>>;
		};
		assert.equal(installed.plugins["demo@local"]?.[0]?.installPath, join(home, "plugins", "cache", "demo"));
		const marketplace = JSON.parse(await readFile(join(home, "plugins/known_marketplaces.json"), "utf8")) as {
			local: { installLocation: string };
		};
		assert.equal(marketplace.local.installLocation, join(home, "plugins", "marketplaces", "local"));

		const globalConfig = JSON.parse(await readFile(join(home, ".claude.json"), "utf8")) as Record<string, unknown>;
		assert.deepEqual(globalConfig, { mcpServers: { demo: { command: "synthetic-mcp", env: { TOKEN: "synthetic-mcp-secret" } } } });
		assert.equal((await lstat(join(home, ".claude.json"))).mode & 0o777, 0o600);
		for (const name of EXCLUDED) await assert.rejects(lstat(join(home, name)));
		await assert.rejects(lstat(join(home, "projects")));
		await assert.rejects(lstat(join(home, "plugins", "logs")));
		assert.equal((await lstat(join(source, "skills", "shared"))).isSymbolicLink(), true);
		assert.equal((await lstat(join(source, "hooks", "pre-commit"))).mode & 0o777, sourceMode);
		assert.equal(await readFile(join(source, "settings.json"), "utf8"), originalSettings);
		assert.equal(await snapshotTree(source), sourceSnapshot);
		assert.ok(!JSON.stringify(result).includes("synthetic-"));
	});
});

test("preserves existing Phi targets while importing missing children", async () => {
	await withFixture(async (_root, source, home) => {
		await mkdir(join(source, "skills", "existing"), { recursive: true });
		await writeFile(join(source, "settings.json"), JSON.stringify({ permissions: { allow: ["new"] } }));
		await writeFile(join(source, "skills", "existing", "SKILL.md"), "legacy\n");
		await writeFile(join(source, "skills", "new.md"), "new skill\n");
		await mkdir(join(home, "skills", "existing"), { recursive: true });
		await writeFile(join(home, "settings.json"), "{\"permissions\":{\"allow\":[\"phi\"]}}\n");
		await writeFile(join(home, "skills", "existing", "SKILL.md"), "phi\n");
		const result = await importClaudeCustomizations(source, home);
		assert.deepEqual(JSON.parse(await readFile(join(home, "settings.json"), "utf8")), { permissions: { allow: ["phi"] } });
		assert.equal(await readFile(join(home, "skills", "existing", "SKILL.md"), "utf8"), "phi\n");
		assert.equal(await readFile(join(home, "skills", "new.md"), "utf8"), "new skill\n");
		assert.ok(result.skipped.includes("settings.json"));
		assert.ok(result.skipped.includes("skills/existing/SKILL.md"));
	});
});

test("repeat import is a no-op after the private completion marker exists", async () => {
	await withFixture(async (_root, source, home) => {
		await writeFile(join(source, "CLAUDE.md"), "first\n");
		await importClaudeCustomizations(source, home);
		await writeFile(join(home, "CLAUDE.md"), "local change\n");
		await writeFile(join(source, "CLAUDE.md"), "second\n");
		const repeated = await importClaudeCustomizations(source, home);
		assert.deepEqual(repeated, { imported: [], skipped: [] });
		assert.equal(await readFile(join(home, "CLAUDE.md"), "utf8"), "local change\n");
		assert.equal((await lstat(join(home, ".claude-import-complete"))).mode & 0o777, 0o600);
	});
});

test("absent sources and source equal to destination do not copy or mark completion", async () => {
	await withFixture(async (_root, source, home) => {
		await rm(source, { recursive: true });
		const absent = await importClaudeCustomizations(source, home);
		assert.deepEqual(absent, { imported: [], skipped: [] });
		await assert.rejects(lstat(join(home, ".claude-import-complete")));

		await mkdir(home, { recursive: true });
		await (await import("node:fs/promises")).chmod(home, 0o755);
		await writeFile(join(home, "CLAUDE.md"), "already here\n");
		const sourceMode = (await lstat(home)).mode & 0o777;
		const same = await importClaudeCustomizations(home, home);
		assert.deepEqual(same, { imported: [], skipped: [] });
		assert.equal(await readFile(join(home, "CLAUDE.md"), "utf8"), "already here\n");
		assert.equal((await lstat(home)).mode & 0o777, sourceMode);
		await assert.rejects(lstat(join(home, ".claude-import-complete")));
	});
});

test("preserves an existing global config instead of replacing account or trust state", async () => {
	await withFixture(async (_root, source, home) => {
		await writeFile(join(source, "global.json"), JSON.stringify({ mcpServers: { imported: { command: "synthetic" } } }));
		await mkdir(home, { recursive: true });
		await writeFile(join(home, ".claude.json"), JSON.stringify({ oauthAccount: "phi account", projects: { trusted: true } }));
		await importClaudeCustomizations(source, home, join(source, "global.json"));
		assert.deepEqual(JSON.parse(await readFile(join(home, ".claude.json"), "utf8")), { oauthAccount: "phi account", projects: { trusted: true } });
	});
});

test("reports a symlink loop without exposing content and leaves no marker or staging", async () => {
	await withFixture(async (_root, source, home) => {
		await mkdir(join(source, "skills"));
		await symlink("loop", join(source, "skills", "loop"));
		await assert.rejects(importClaudeCustomizations(source, home), (error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /symbolic link loop/i);
			assert.doesNotMatch(error.message, /synthetic-secret/);
			return true;
		});
		await assert.rejects(lstat(join(home, ".claude-import-complete")));
		assert.deepEqual(await (await import("node:fs/promises")).readdir(home), []);
		assert.equal((await lstat(join(source, "skills", "loop"))).isSymbolicLink(), true);
	});
});

test("invalid settings fail without a marker or secret-bearing errors", async () => {
	await withFixture(async (_root, source, home) => {
		await writeFile(join(source, "settings.json"), "{\"apiKeyHelper\":\"synthetic-secret-value\"");
		await assert.rejects(importClaudeCustomizations(source, home), (error: unknown) => {
			assert.ok(error instanceof Error);
			assert.doesNotMatch(error.message, /synthetic-secret-value/);
			return true;
		});
		await assert.rejects(lstat(join(home, ".claude-import-complete")));
		assert.deepEqual(await (await import("node:fs/promises")).readdir(home), []);
	});
});
