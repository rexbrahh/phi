import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const AUTH_FILE = "auth.json";
const DIRECTORY_FLAGS = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0);
const HOME_ERROR = "Unable to prepare Phi home";
const READ_ERROR = "Unable to read Phi API key";
const SAVE_ERROR = "Unable to save Phi API key";
const DELETE_ERROR = "Unable to delete Phi API key";
const INVALID_FILE = "Invalid Phi API key file";

export function resolvePhiHome(env: NodeJS.ProcessEnv = process.env, userHome: string = homedir()): string {
	if (env.PHI_HOME === undefined) return join(userHome, ".phi");
	if (!env.PHI_HOME || !isAbsolute(env.PHI_HOME)) throw new Error("PHI_HOME must be an absolute, nonempty path");
	return env.PHI_HOME;
}

export async function ensurePhiHome(home: string): Promise<void> {
	let directory: FileHandle | undefined;
	try {
		let metadata = await lstatIfPresent(home);
		if (metadata?.isSymbolicLink() || (metadata && !metadata.isDirectory())) throw new Error(HOME_ERROR);
		if (!metadata) await mkdir(home, { recursive: true, mode: 0o700 });
		directory = await open(home, DIRECTORY_FLAGS);
		const opened = await directory.stat();
		metadata = await lstat(home);
		if (!opened.isDirectory() || metadata.isSymbolicLink() || !metadata.isDirectory() || opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
			throw new Error(HOME_ERROR);
		}
		await directory.chmod(0o700);
	} catch {
		throw new Error(HOME_ERROR);
	} finally {
		await directory?.close().catch(() => {});
	}
}

export async function readPhiApiKey(home: string): Promise<string | undefined> {
	let file: FileHandle | undefined;
	try {
		const homeMetadata = await lstatIfPresent(home);
		if (!homeMetadata) return undefined;
		if (homeMetadata.isSymbolicLink() || !homeMetadata.isDirectory() || (homeMetadata.mode & 0o077) !== 0) {
			throw new Error(HOME_ERROR);
		}
		const authPath = join(home, AUTH_FILE);
		if (!(await regularCredentialExists(authPath))) return undefined;
		file = await open(authPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
		const metadata = await file.stat();
		if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) throw new Error(INVALID_FILE);
		const parsed: unknown = JSON.parse(await file.readFile({ encoding: "utf8" }));
		if (!isRecord(parsed) || Object.keys(parsed).length !== 2 || parsed.version !== 1 || typeof parsed.apiKey !== "string") {
			throw new Error(INVALID_FILE);
		}
		if (!isValidApiKey(parsed.apiKey)) throw new Error(INVALID_FILE);
		return parsed.apiKey;
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		throw new Error(READ_ERROR);
	} finally {
		await file?.close().catch(() => {});
	}
}

export async function savePhiApiKey(home: string, apiKey: string): Promise<void> {
	let file: FileHandle | undefined;
	let temporaryPath: string | undefined;
	let temporaryOwned = false;
	let failed = false;
	try {
		if (!isValidApiKey(apiKey)) throw new Error(SAVE_ERROR);
		await ensurePhiHome(home);
		const authPath = join(home, AUTH_FILE);
		await regularCredentialExists(authPath);
		temporaryPath = join(home, `.${AUTH_FILE}.${randomUUID()}.tmp`);
		file = await open(temporaryPath, "wx", 0o600);
		temporaryOwned = true;
		await file.chmod(0o600);
		await file.writeFile(JSON.stringify({ version: 1, apiKey }), { encoding: "utf8" });
		await file.sync();
		await file.close();
		file = undefined;
		await regularCredentialExists(authPath);
		await rename(temporaryPath, authPath);
		temporaryOwned = false;
	} catch {
		failed = true;
	} finally {
		if (file) {
			try {
				await file.close();
			} catch {
				failed = true;
			}
		}
		if (temporaryOwned && temporaryPath) {
			try {
				await unlink(temporaryPath);
			} catch (error) {
				if (errorCode(error) !== "ENOENT") failed = true;
			}
		}
	}
	if (failed) throw new Error(SAVE_ERROR);
}

export async function deletePhiApiKey(home: string): Promise<void> {
	try {
		if (!(await safeHomeExists(home))) return;
		const authPath = join(home, AUTH_FILE);
		if (!(await regularCredentialExists(authPath))) return;
		const file = await open(authPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
		let opened: Stats;
		try {
			opened = await file.stat();
			if (!opened.isFile()) throw new Error(INVALID_FILE);
		} finally {
			await file.close();
		}
		const current = await lstatIfPresent(authPath);
		if (!current) return;
		if (current.isSymbolicLink() || !current.isFile() || current.dev !== opened.dev || current.ino !== opened.ino) {
			throw new Error(INVALID_FILE);
		}
		await unlink(authPath);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return;
		throw new Error(DELETE_ERROR);
	}
}

async function safeHomeExists(home: string): Promise<boolean> {
	const metadata = await lstatIfPresent(home);
	if (!metadata) return false;
	if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error(HOME_ERROR);
	return true;
}

async function regularCredentialExists(path: string): Promise<boolean> {
	const metadata = await lstatIfPresent(path);
	if (!metadata) return false;
	if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(INVALID_FILE);
	return true;
}

async function lstatIfPresent(path: string) {
	try {
		return await lstat(path);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		throw error;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidApiKey(apiKey: unknown): apiKey is string {
	return typeof apiKey === "string" && apiKey.length > 0 && !/[\s\p{Cc}]/u.test(apiKey);
}

function errorCode(error: unknown): string | undefined {
	return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;
}
