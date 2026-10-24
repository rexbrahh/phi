import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { loginPhiAuth, phiAuthSource, preparePhiAuth, type PhiAuthPrompt } from "../src/auth.js";
import { ensurePhiHome, readPhiApiKey, savePhiApiKey } from "../src/home.js";

async function withHome(run: (home: string) => Promise<void>): Promise<void> {
	const parent = await mkdtemp(join(tmpdir(), "phi-auth-test-"));
	try {
		await run(join(parent, ".phi"));
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
}

function assertKeyEqual(actual: string | undefined, expected: string): void {
	assert.ok(actual === expected, "unexpected API key selection");
}

async function assertGenericError(operation: Promise<unknown>, expectedMessage: string): Promise<void> {
	let caught: unknown;
	try {
		await operation;
	} catch (error) {
		caught = error;
	}
	assert.ok(caught instanceof Error, "expected an operation to fail");
	assert.ok(caught.message === expectedMessage, "expected a generic error message");
	assert.ok(!caught.message.includes("synthetic-secret"), "an error exposed a synthetic key");
}

function returningKey(apiKey: string): PhiAuthPrompt {
	return async () => apiKey;
}

test("preparePhiAuth prefers a valid environment key without persisting it or mutating the environment", async () => {
	await withHome(async (home) => {
		const savedKey = "synthetic-secret-saved";
		const environmentKey = "key-without-vendor-prefix";
		await savePhiApiKey(home, savedKey);
		const environment: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: environmentKey, PHI_TEST_FLAG: "preserved" };
		let promptCalled = false;

		const prepared = await preparePhiAuth(home, environment, async () => {
			promptCalled = true;
			return undefined;
		});

		assert.ok(prepared !== undefined);
		assert.notStrictEqual(prepared, environment);
		assertKeyEqual(prepared.ANTHROPIC_API_KEY, environmentKey);
		assert.equal(prepared.PHI_TEST_FLAG, "preserved");
		assertKeyEqual(environment.ANTHROPIC_API_KEY, environmentKey);
		assert.equal(environment.PHI_TEST_FLAG, "preserved");
		assertKeyEqual(await readPhiApiKey(home), savedKey);
		assert.equal(promptCalled, false);
	});
});

test("preparePhiAuth loads saved auth after an invalid environment key and restores private home mode", async () => {
	await withHome(async (home) => {
		const savedKey = "synthetic-secret-saved";
		await savePhiApiKey(home, savedKey);
		await chmod(home, 0o755);
		const environment: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "invalid key" };
		let promptCalled = false;

		const prepared = await preparePhiAuth(home, environment, async () => {
			promptCalled = true;
			return undefined;
		});

		assert.ok(prepared !== undefined);
		assert.notStrictEqual(prepared, environment);
		assertKeyEqual(prepared.ANTHROPIC_API_KEY, savedKey);
		assert.equal(environment.ANTHROPIC_API_KEY, "invalid key");
		assert.equal((await lstat(home)).mode & 0o777, 0o700);
		assert.equal(promptCalled, false);
	});
});

test("preparePhiAuth prompts once on first run and saves the entered key", async () => {
	await withHome(async (home) => {
		const enteredKey = "synthetic-secret-first-run";
		const environment: NodeJS.ProcessEnv = { PHI_TEST_FLAG: "preserved" };
		let promptCalls = 0;

		const prepared = await preparePhiAuth(home, environment, async () => {
			promptCalls += 1;
			return enteredKey;
		});

		assert.ok(prepared !== undefined);
		assert.notStrictEqual(prepared, environment);
		assertKeyEqual(prepared.ANTHROPIC_API_KEY, enteredKey);
		assert.equal(prepared.PHI_TEST_FLAG, "preserved");
		assert.equal(environment.ANTHROPIC_API_KEY, undefined);
		assert.equal(environment.PHI_TEST_FLAG, "preserved");
		assertKeyEqual(await readPhiApiKey(home), enteredKey);
		assert.equal(promptCalls, 1);
	});
});

test("preparePhiAuth cancellation returns undefined without writing auth", async () => {
	await withHome(async (home) => {
		const environment: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "invalid\nkey", PHI_TEST_FLAG: "preserved" };
		const prepared = await preparePhiAuth(home, environment, async () => undefined);

		assert.equal(prepared, undefined);
		assert.equal(environment.ANTHROPIC_API_KEY, "invalid\nkey");
		assert.equal(environment.PHI_TEST_FLAG, "preserved");
		assert.deepEqual(await readdir(home), []);
	});
});

test("loginPhiAuth explicitly replaces saved auth and cancellation preserves it", async () => {
	await withHome(async (home) => {
		const firstKey = "synthetic-secret-before-login";
		const replacementKey = "synthetic-secret-after-login";
		await savePhiApiKey(home, firstKey);
		assert.equal(await loginPhiAuth(home, returningKey(replacementKey)), true);
		assertKeyEqual(await readPhiApiKey(home), replacementKey);

		assert.equal(await loginPhiAuth(home, async () => undefined), false);
		assertKeyEqual(await readPhiApiKey(home), replacementKey);
	});
});

test("phiAuthSource reports environment, saved, and missing credentials", async () => {
	await withHome(async (home) => {
		assert.equal(await phiAuthSource(home, {}), "missing");
		await savePhiApiKey(home, "synthetic-secret-source");
		assert.equal(await phiAuthSource(home, {}), "saved");
		assert.equal(await phiAuthSource(home, { ANTHROPIC_API_KEY: "environment-key" }), "environment");
		assert.equal(await phiAuthSource(home, { ANTHROPIC_API_KEY: "invalid key" }), "saved");
	});
});

test("malformed saved auth errors stay generic and do not expose file contents", async () => {
	await withHome(async (home) => {
		await ensurePhiHome(home);
		const malformed = JSON.stringify({ version: 2, apiKey: "synthetic-secret-malformed" });
		await writeFile(join(home, "auth.json"), malformed, "utf8");
		let promptCalled = false;

		await assertGenericError(preparePhiAuth(home, {}, async () => {
			promptCalled = true;
			return undefined;
		}), "Unable to read Phi API key");
		assert.equal(promptCalled, false);
	});
});

test("prompt failures are generic and never propagate prompt text", async () => {
	await withHome(async (home) => {
		await assertGenericError(loginPhiAuth(home, async () => {
			throw new Error("failed for synthetic-secret-prompt");
		}), "Unable to prompt for Phi API key");
		assert.equal(await readPhiApiKey(home), undefined);
	});
});

test("saved auth contents remain the versioned API key record", async () => {
	await withHome(async (home) => {
		const apiKey = "synthetic-secret-record";
		await savePhiApiKey(home, apiKey);
		const contents = JSON.parse(await readFile(join(home, "auth.json"), "utf8")) as { version: number; apiKey: string };
		assert.equal(contents.version, 1);
		assertKeyEqual(contents.apiKey, apiKey);
	});
});
