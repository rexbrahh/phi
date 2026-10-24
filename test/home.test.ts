import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { deletePhiApiKey, ensurePhiHome, readPhiApiKey, resolvePhiHome, savePhiApiKey } from "../src/home.js";

async function withHome(run: (home: string) => Promise<void>): Promise<void> {
	const parent = await mkdtemp(join(tmpdir(), "phi-home-test-"));
	try {
		await run(join(parent, ".phi"));
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
}

async function assertGenericError(operation: Promise<unknown>, secret?: string): Promise<void> {
	await assert.rejects(operation, (error: unknown) => {
		assert.ok(error instanceof Error);
		assert.doesNotMatch(error.message, /synthetic-secret/);
		if (secret) assert.doesNotMatch(error.message, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		return true;
	});
}

test("resolvePhiHome uses the user home or an absolute PHI_HOME override", () => {
	assert.equal(resolvePhiHome({}, "/home/person"), join("/home/person", ".phi"));
	assert.equal(resolvePhiHome({ PHI_HOME: "/private/phi" }, "/home/person"), "/private/phi");
	assert.throws(() => resolvePhiHome({ PHI_HOME: "" }, "/home/person"));
	assert.throws(() => resolvePhiHome({ PHI_HOME: "relative/path" }, "/home/person"));
});

test("ensurePhiHome creates a private directory and rejects files and symlinks", async () => {
	await withHome(async (home) => {
		await ensurePhiHome(home);
		assert.equal((await lstat(home)).mode & 0o777, 0o700);
		await chmod(home, 0o755);
		await ensurePhiHome(home);
		assert.equal((await lstat(home)).mode & 0o777, 0o700);
		await rm(home, { recursive: true });

		await writeFile(home, "not a directory");
		await assertGenericError(ensurePhiHome(home));
		await rm(home);

		const outside = `${home}.outside`;
		await mkdir(outside);
		await chmod(outside, 0o755);
		await symlink(outside, home);
		await assertGenericError(ensurePhiHome(home));
		assert.equal((await lstat(outside)).mode & 0o777, 0o755);
	});
});

test("Phi API keys round-trip privately, overwrite atomically, and reject invalid keys", async () => {
	await withHome(async (home) => {
		assert.equal(await readPhiApiKey(home), undefined);
		const first = "synthetic-secret-first";
		await savePhiApiKey(home, first);
		const authPath = join(home, "auth.json");
		assert.equal(await readPhiApiKey(home), first);
		assert.deepEqual(JSON.parse(await readFile(authPath, "utf8")), { version: 1, apiKey: first });
		assert.equal((await lstat(authPath)).mode & 0o777, 0o600);

		await savePhiApiKey(home, "synthetic-secret-second");
		assert.equal(await readPhiApiKey(home), "synthetic-secret-second");
		assert.deepEqual(await readdir(home), ["auth.json"]);
		for (const invalid of ["", "bad key", "bad\nkey", "bad\tkey", "bad\0key"]) {
			await assertGenericError(savePhiApiKey(home, invalid), invalid);
			assert.equal(await readPhiApiKey(home), "synthetic-secret-second");
		}
	});
});

test("readPhiApiKey rejects a group or others readable home without changing its mode", async () => {
	await withHome(async (home) => {
		const secret = "synthetic-secret-wide-home";
		await savePhiApiKey(home, secret);
		await chmod(home, 0o755);

		await assertGenericError(readPhiApiKey(home), secret);
		assert.equal((await lstat(home)).mode & 0o777, 0o755);
	});
});

test("readPhiApiKey rejects a group or others readable credential without changing its mode", async () => {
	await withHome(async (home) => {
		const secret = "synthetic-secret-wide-file";
		await savePhiApiKey(home, secret);
		const authPath = join(home, "auth.json");
		await chmod(authPath, 0o644);

		await assertGenericError(readPhiApiKey(home), secret);
		assert.equal((await lstat(authPath)).mode & 0o777, 0o644);
	});
});

test("readPhiApiKey rejects corrupt or invalid schemas without exposing their contents", async () => {
	await withHome(async (home) => {
		await ensurePhiHome(home);
		const authPath = join(home, "auth.json");
		const invalidFiles = [
			"synthetic-secret-corrupt-json",
			JSON.stringify({ version: 2, apiKey: "synthetic-secret-wrong-version" }),
			JSON.stringify({ version: 1, apiKey: "" }),
			JSON.stringify({ version: 1, apiKey: "synthetic-secret-with space" }),
			JSON.stringify({ version: 1, apiKey: "synthetic-secret-newline\nkey" }),
			JSON.stringify({ version: 1, apiKey: "synthetic-secret-extra-field", extra: true }),
		];
		for (const contents of invalidFiles) {
			await writeFile(authPath, contents);
			await assertGenericError(readPhiApiKey(home));
		}
	});
});

test("credential operations reject symlinks and nonregular auth files", async () => {
	await withHome(async (home) => {
		await ensurePhiHome(home);
		const authPath = join(home, "auth.json");
		const outside = join(home, "outside.json");
		await writeFile(outside, JSON.stringify({ version: 1, apiKey: "synthetic-secret-outside" }));
		await symlink(outside, authPath);
		await assertGenericError(readPhiApiKey(home));
		await assertGenericError(savePhiApiKey(home, "synthetic-secret-new"));
		await assertGenericError(deletePhiApiKey(home));
		assert.equal(await readFile(outside, "utf8"), JSON.stringify({ version: 1, apiKey: "synthetic-secret-outside" }));
		await rm(authPath);

		await mkdir(authPath);
		await assertGenericError(readPhiApiKey(home));
		await assertGenericError(savePhiApiKey(home, "synthetic-secret-new"));
		await assertGenericError(deletePhiApiKey(home));
		assert.deepEqual(await readdir(home), ["auth.json", "outside.json"]);
	});
});

test("deletePhiApiKey removes only auth.json and preserves unrelated state", async () => {
	await withHome(async (home) => {
		await savePhiApiKey(home, "synthetic-secret-delete");
		const sessionPath = join(home, "sessions");
		await mkdir(sessionPath);
		await writeFile(join(sessionPath, "history.jsonl"), "synthetic history\n");
		await deletePhiApiKey(home);
		await deletePhiApiKey(home);
		assert.deepEqual(await readdir(home), ["sessions"]);
		assert.equal(await readFile(join(sessionPath, "history.jsonl"), "utf8"), "synthetic history\n");
	});
});
