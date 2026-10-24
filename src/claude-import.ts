import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ensurePhiHome } from "./home.js";

const CUSTOMIZATIONS = ["settings.json", "CLAUDE.md", "skills", "agents", "commands", "hooks", "rules", "output-styles"] as const;
const PLUGIN_ENTRIES = ["cache", "marketplaces", "installed_plugins.json", "known_marketplaces.json"] as const;
const AUTH_FIELDS = new Set(["apiKeyHelper", "awsAuthRefresh", "awsCredentialExport", "forceLoginMethod", "forceLoginOrgUUID"]);
const AUTH_ENV = new Set([
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"CLAUDE_CONFIG_DIR",
	"CLAUDE_CODE_PLUGIN_CACHE_DIR",
]);
const PROVIDER_ENV = new Set([
	"ANTHROPIC_BASE_URL",
	"ANTHROPIC_MODEL",
	"ANTHROPIC_DEFAULT_OPUS_MODEL",
	"ANTHROPIC_DEFAULT_SONNET_MODEL",
	"ANTHROPIC_DEFAULT_HAIKU_MODEL",
	"ANTHROPIC_SMALL_FAST_MODEL",
	"ANTHROPIC_BEDROCK_BASE_URL",
	"ANTHROPIC_VERTEX_BASE_URL",
	"ANTHROPIC_VERTEX_PROJECT_ID",
	"CLOUD_ML_REGION",
	"CLAUDE_CODE_USE_BEDROCK",
	"CLAUDE_CODE_USE_VERTEX",
	"CLAUDE_CODE_USE_FOUNDRY",
	"CLAUDE_CODE_SKIP_BEDROCK_AUTH",
	"CLAUDE_CODE_SKIP_VERTEX_AUTH",
]);
const MARKER = ".claude-import-complete";
const LOOP_ERROR = "Claude Code customizations contain a symbolic link loop";
const IMPORT_ERROR = "Unable to import Claude Code customizations";

export async function importClaudeCustomizations(
	sourceRoot: string,
	phiHome: string,
	globalConfigPath?: string,
): Promise<{ imported: string[]; skipped: string[] }> {
	const sourceBeforeSetup = await lstatIfPresent(sourceRoot);
	const homeBeforeSetup = await lstatIfPresent(phiHome);
	if (sourceBeforeSetup && homeBeforeSetup) {
		try {
			const sourceReal = await realpath(sourceRoot);
			const homeReal = await realpath(phiHome);
			if (sourceReal === homeReal && (await stat(sourceReal)).isDirectory()) return { imported: [], skipped: [] };
		} catch (error) {
			throw safeError(error);
		}
	}
	await ensurePhiHome(phiHome);
	const marker = join(phiHome, MARKER);
	const markerMetadata = await lstatIfPresent(marker);
	if (markerMetadata) {
		if (markerMetadata.isSymbolicLink() || !markerMetadata.isFile()) throw new Error(IMPORT_ERROR);
		await chmod(marker, 0o600).catch(() => { throw new Error(IMPORT_ERROR); });
		return { imported: [], skipped: [] };
	}

	const sourceMetadata = await lstatIfPresent(sourceRoot);
	if (!sourceMetadata) return { imported: [], skipped: [] };
	if (!sourceMetadata.isDirectory() && !sourceMetadata.isSymbolicLink()) throw new Error(IMPORT_ERROR);

	let sourceReal: string;
	let homeReal: string;
	try {
		sourceReal = await realpath(sourceRoot);
		homeReal = await realpath(phiHome);
	} catch (error) {
		throw safeError(error);
	}
	if (sourceReal === homeReal) return { imported: [], skipped: [] };
	try {
		if (!(await stat(sourceReal)).isDirectory()) throw new Error(IMPORT_ERROR);
	} catch (error) {
		throw safeError(error);
	}

	const stage = join(phiHome, `.claude-import-${randomUUID()}.staging`);
	const phiTarget = resolve(phiHome);
	let stageOwned = false;
	try {
		await mkdir(stage, { mode: 0o700 });
		stageOwned = true;
		const roots = [resolve(sourceRoot), sourceReal];
		for (const name of CUSTOMIZATIONS) {
			if (await lstatIfPresent(join(sourceReal, name))) {
				await copyEntry(join(sourceReal, name), join(stage, name), name, phiTarget, roots, new Set());
			}
		}
		let hasPluginEntries = false;
		for (const name of PLUGIN_ENTRIES) {
			const source = join(sourceReal, "plugins", name);
			if (await lstatIfPresent(source)) {
				if (!hasPluginEntries) await mkdir(join(stage, "plugins"), { mode: 0o700 });
				hasPluginEntries = true;
				await copyEntry(source, join(stage, "plugins", name), `plugins/${name}`, phiTarget, roots, new Set());
			}
		}
		if (await lstatIfPresent(join(stage, "plugins"))) {
			await rewritePluginMetadata(join(stage, "plugins"), phiTarget, roots);
		}
		if (globalConfigPath) await stageGlobalMcpServers(globalConfigPath, stage);

		const imported: string[] = [];
		const skipped: string[] = [];
		for (const name of await readdir(stage)) {
			await mergeEntry(join(stage, name), join(phiHome, name), name, imported, skipped);
		}
		await rm(stage, { recursive: true, force: true });
		stageOwned = false;
		const markerFile = await open(marker, "wx", 0o600);
		try {
			await markerFile.chmod(0o600);
			await markerFile.writeFile("1\n", { encoding: "utf8" });
			await markerFile.sync();
		} finally {
			await markerFile.close();
		}
		return { imported, skipped };
	} catch (error) {
		if (stageOwned) await rm(stage, { recursive: true, force: true }).catch(() => {});
		throw safeError(error);
	}
}

async function copyEntry(
	source: string,
	target: string,
	relativePath: string,
	phiHome: string,
	sourceRoots: string[],
	activeDirectories: Set<string>,
): Promise<void> {
	let realSource: string;
	try {
		realSource = await realpath(source);
	} catch (error) {
		throw safeError(error);
	}
	let metadata;
	try {
		metadata = await stat(realSource);
	} catch (error) {
		throw safeError(error);
	}
	if (metadata.isDirectory()) {
		if (activeDirectories.has(realSource)) throw new Error(LOOP_ERROR);
		activeDirectories.add(realSource);
		await mkdir(target, { mode: 0o700 });
		try {
			for (const child of await readdir(realSource)) {
				await copyEntry(join(realSource, child), join(target, child), `${relativePath}/${child}`, phiHome, sourceRoots, activeDirectories);
			}
		} finally {
			activeDirectories.delete(realSource);
		}
		return;
	}
	if (!metadata.isFile()) throw new Error(IMPORT_ERROR);

	let contents: Uint8Array = await readFile(realSource);
	if (relativePath === "settings.json") contents = filterSettingsContent(contents);
	const file = await open(target, "wx", isPrivateJson(relativePath) ? 0o600 : metadata.mode & 0o777);
	try {
		await file.chmod(isPrivateJson(relativePath) ? 0o600 : metadata.mode & 0o777);
		await file.writeFile(contents);
	} finally {
		await file.close();
	}
}

function filterSettingsContent(contents: Uint8Array): Uint8Array {
	const settings: unknown = JSON.parse(Buffer.from(contents).toString("utf8"));
	if (!isRecord(settings)) throw new Error(IMPORT_ERROR);
	const filtered = Object.fromEntries(Object.entries(settings).filter(([key]) => !AUTH_FIELDS.has(key)));
	if (isRecord(filtered.env)) {
		filtered.env = Object.fromEntries(Object.entries(filtered.env).filter(([key]) => !AUTH_ENV.has(key) && !PROVIDER_ENV.has(key)));
	}
	return Buffer.from(`${JSON.stringify(filtered, null, 2)}\n`, "utf8");
}

async function rewritePluginMetadata(directory: string, phiHome: string, sourceRoots: string[]): Promise<void> {
	for (const name of await readdir(directory)) {
		const path = join(directory, name);
		const metadata = await lstat(path);
		if (metadata.isDirectory()) {
			await rewritePluginMetadata(path, phiHome, sourceRoots);
			continue;
		}
		if (!metadata.isFile() || !name.endsWith(".json")) continue;
		const knownRegistry = name === "installed_plugins.json" || name === "known_marketplaces.json";
		let value: unknown;
		try {
			value = JSON.parse(await readFile(path, "utf8"));
		} catch {
			if (knownRegistry) throw new Error(IMPORT_ERROR);
			continue;
		}
		const rewritten = remapMetadata(value, phiHome, sourceRoots);
		if (rewritten.changed) {
			await writeFile(path, `${JSON.stringify(rewritten.value, null, 2)}\n`, { mode: 0o600 });
			await chmod(path, 0o600);
		}
	}
}

function remapMetadata(value: unknown, phiHome: string, sourceRoots: string[]): { value: unknown; changed: boolean } {
	if (Array.isArray(value)) {
		let changed = false;
		const items = value.map((item) => {
			const result = remapMetadata(item, phiHome, sourceRoots);
			changed ||= result.changed;
			return result.value;
		});
		return { value: items, changed };
	}
	if (!isRecord(value)) return { value, changed: false };
	let changed = false;
	const entries = Object.entries(value).map(([key, item]) => {
		if ((key === "installPath" || key === "installLocation") && typeof item === "string") {
			const mapped = mapSourcePath(item, sourceRoots, phiHome);
			if (mapped !== item) {
				changed = true;
				return [key, mapped] as const;
			}
		}
		const result = remapMetadata(item, phiHome, sourceRoots);
		changed ||= result.changed;
		return [key, result.value] as const;
	});
	return { value: Object.fromEntries(entries), changed };
}

function mapSourcePath(value: string, sourceRoots: string[], phiHome: string): string {
	if (!isAbsolute(value)) return value;
	const candidate = resolve(value);
	for (const sourceRoot of sourceRoots) {
		const pathFromRoot = relative(sourceRoot, candidate);
		if (pathFromRoot === "" || (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))) {
			return pathFromRoot ? join(phiHome, pathFromRoot) : phiHome;
		}
	}
	return value;
}

async function stageGlobalMcpServers(globalConfigPath: string, stage: string): Promise<void> {
	let contents: string;
	try {
		contents = await readFile(globalConfigPath, "utf8");
	} catch (error) {
		if (errorCode(error) === "ENOENT") return;
		throw safeError(error);
	}
	let globalConfig: unknown;
	try {
		globalConfig = JSON.parse(contents);
	} catch {
		throw new Error(IMPORT_ERROR);
	}
	if (!isRecord(globalConfig) || !isRecord(globalConfig.mcpServers)) return;
	const destination = join(stage, ".claude.json");
	const file = await open(destination, "wx", 0o600);
	try {
		await file.chmod(0o600);
		await file.writeFile(`${JSON.stringify({ mcpServers: globalConfig.mcpServers }, null, 2)}\n`, { encoding: "utf8" });
	} finally {
		await file.close();
	}
}

async function mergeEntry(source: string, target: string, relativePath: string, imported: string[], skipped: string[]): Promise<void> {
	const sourceMetadata = await lstat(source);
	const targetMetadata = await lstatIfPresent(target);
	if (targetMetadata) {
		if (targetMetadata.isSymbolicLink() || sourceMetadata.isDirectory() !== targetMetadata.isDirectory()) {
			skipped.push(relativePath);
			return;
		}
		if (!sourceMetadata.isDirectory()) {
			skipped.push(relativePath);
			return;
		}
		for (const child of await readdir(source)) {
			await mergeEntry(join(source, child), join(target, child), `${relativePath}/${child}`, imported, skipped);
		}
		return;
	}
	if (sourceMetadata.isDirectory()) {
		await mkdir(target, { mode: 0o700 });
		imported.push(relativePath);
		for (const child of await readdir(source)) {
			await mergeEntry(join(source, child), join(target, child), `${relativePath}/${child}`, imported, skipped);
		}
		return;
	}
	const mode = isPrivateJson(relativePath) ? 0o600 : sourceMetadata.mode & 0o777;
	const file = await open(target, "wx", mode);
	try {
		await file.chmod(mode);
		await file.writeFile(await readFile(source));
	} finally {
		await file.close();
	}
	imported.push(relativePath);
}

function isPrivateJson(path: string): boolean {
	return basename(path).endsWith(".json");
}

async function lstatIfPresent(path: string) {
	try {
		return await lstat(path);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		throw safeError(error);
	}
}

function safeError(error: unknown): Error {
	if (error instanceof Error && error.message === LOOP_ERROR) return new Error(LOOP_ERROR);
	if (errorCode(error) === "ELOOP") return new Error(LOOP_ERROR);
	return new Error(IMPORT_ERROR);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
	return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;
}
