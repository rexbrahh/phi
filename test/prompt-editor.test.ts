import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { editPrompt } from "../src/prompt-editor.js";

async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "phi prompt editor test "));
	const temporary = join(root, "temporary files");
	const cwd = join(root, "project directory");
	await Promise.all([mkdir(temporary), mkdir(cwd)]);
	t.after(() => rm(root, { recursive: true, force: true }));
	return { root, temporary, cwd };
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function environment(temporary: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return { ...process.env, TMPDIR: temporary, ...extra };
}

test("a denied group signal reports failure and keeps the recovery draft", async (t) => {
	const paths = await fixture(t);
	const editor = join(paths.root, "held editor.mjs");
	const marker = join(paths.root, "started");
	await writeFile(editor, 'import { writeFileSync } from "node:fs"; writeFileSync(process.env.MARKER_FILE, "ready"); setInterval(() => {}, 1000);');
	const originalKill = process.kill.bind(process);
	let ownedGroup: number | undefined;
	const mockedKill = t.mock.method(process, "kill", (pid: number, signal?: NodeJS.Signals | number) => {
		if (pid < 0 && signal === "SIGTERM") {
			ownedGroup = -pid;
			throw Object.assign(new Error("denied"), { code: "EPERM" });
		}
		return originalKill(pid, signal);
	});
	const controller = new AbortController();
	const pending = editPrompt("retain this", paths.cwd, environment(paths.temporary, {
		VISUAL: [shellQuote(process.execPath), shellQuote(editor)].join(" "), MARKER_FILE: marker,
	}), controller.signal);
	try {
		const deadline = Date.now() + 5000;
		while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolveWait) => setTimeout(resolveWait, 10));
		assert.ok(existsSync(marker));
		controller.abort();
		await assert.rejects(pending, /Could not stop the prompt editor process group; draft retained at/);
		const [directory] = await readdir(paths.temporary);
		assert.equal(await readFile(join(paths.temporary, directory, "prompt"), "utf8"), "retain this");
	} finally {
		mockedKill.mock.restore();
		controller.abort();
		if (ownedGroup) {
			try { originalKill(-ownedGroup, "SIGKILL"); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
		}
		await pending.catch(() => undefined);
	}
});

test("abort settles when an unreaped editor group stays visible to signal probes", async (t) => {
	const paths = await fixture(t);
	const editor = join(paths.root, "held editor.mjs");
	const marker = join(paths.root, "started");
	await writeFile(editor, 'import { writeFileSync } from "node:fs"; writeFileSync(process.env.MARKER_FILE, "ready"); setInterval(() => {}, 1000);');
	const originalKill = process.kill.bind(process);
	let ownedGroup: number | undefined;
	let forceStops = 0;
	const mockedKill = t.mock.method(process, "kill", (pid: number, signal?: NodeJS.Signals | number) => {
		if (pid < 0 && signal === "SIGTERM") ownedGroup = pid;
		if (pid === ownedGroup && signal === 0) return true;
		if (pid === ownedGroup && signal === "SIGKILL") { forceStops += 1; return true; }
		return originalKill(pid, signal);
	});
	const controller = new AbortController();
	const pending = editPrompt("recover this", paths.cwd, environment(paths.temporary, {
		VISUAL: [shellQuote(process.execPath), shellQuote(editor)].join(" "), MARKER_FILE: marker,
	}), controller.signal);
	let timeout: NodeJS.Timeout | undefined;
	try {
		const deadline = Date.now() + 5_000;
		while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolveWait) => setTimeout(resolveWait, 10));
		assert.ok(existsSync(marker));
		controller.abort();
		await assert.rejects(Promise.race([
			pending,
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(() => reject(new Error("Editor abort remained pending")), 4_000);
			}),
		]), /Could not confirm prompt editor process group exit; draft retained at/);
		assert.equal(forceStops, 1, "the force-stop grace period must run before the wait expires");
		const [directory] = await readdir(paths.temporary);
		assert.equal(await readFile(join(paths.temporary, directory, "prompt"), "utf8"), "recover this");
	} finally {
		if (timeout) clearTimeout(timeout);
		mockedKill.mock.restore();
		controller.abort();
		if (ownedGroup) {
			try { originalKill(ownedGroup, "SIGKILL"); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
		}
		await pending.catch(() => undefined);
	}
});

test("round-trips UTF-8 through a blocking editor with private temp files", async (t) => {
	const paths = await fixture(t);
	const editor = join(paths.root, "fake editor.mjs");
	const metadataFile = join(paths.root, "editor metadata.json");
	const edited = "Résumé 🧪\nsecond line\nlast line";
	await writeFile(editor, `
import { statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";
const [flag, file] = process.argv.slice(2);
await writeFile(process.env.METADATA_FILE, JSON.stringify({
  flag, file, cwd: process.cwd(), fileMode: statSync(file).mode & 0o777,
  directoryMode: statSync(dirname(file)).mode & 0o777,
  gitOverrides: [process.env.GIT_INDEX_FILE, process.env.GIT_DIR, process.env.GIT_WORK_TREE],
  sshAgent: process.env.SSH_AUTH_SOCK,
}));
await writeFile(file, process.env.EDITOR_OUTPUT, "utf8");
`);
	const result = await editPrompt("original λ\nmultiline\n", paths.cwd, environment(paths.temporary, {
		VISUAL: `${shellQuote(process.execPath)} ${shellQuote(editor)} --wait`,
		EDITOR: "missing-lower-priority-editor",
		METADATA_FILE: metadataFile,
		EDITOR_OUTPUT: edited,
		GIT_INDEX_FILE: "/another/index", GIT_DIR: "/another/git", GIT_WORK_TREE: "/another/tree",
		SSH_AUTH_SOCK: "/preserved/agent",
	}), new AbortController().signal);

	assert.equal(result, edited);
	const metadata = JSON.parse(await readFile(metadataFile, "utf8")) as {
		flag: string; file: string; cwd: string; fileMode: number; directoryMode: number;
		gitOverrides: null[]; sshAgent: string;
	};
	assert.equal(metadata.flag, "--wait");
	assert.equal(metadata.cwd, await realpath(paths.cwd));
	assert.ok(metadata.file.includes(" "));
	assert.equal(metadata.fileMode, 0o600);
	assert.equal(metadata.directoryMode, 0o700);
	assert.deepEqual(metadata.gitOverrides, [null, null, null]);
	assert.equal(metadata.sshAgent, "/preserved/agent");
	assert.deepEqual(await readdir(paths.temporary), []);
});

test("rejects a missing configured editor and keeps its private draft", async (t) => {
	const paths = await fixture(t);
	const draft = "keep this draft\n";
	const error = await editPrompt(draft, paths.cwd, environment(paths.temporary, {
		VISUAL: "",
		EDITOR: "phi-editor-that-does-not-exist",
	}), new AbortController().signal).then(
		() => assert.fail("missing editor unexpectedly succeeded"),
		(reason: unknown) => reason as Error,
	);
	assert.match(error.message, /status 127/u);
	assert.match(error.message, /draft retained at/u);
	const [directory] = await readdir(paths.temporary);
	assert.equal(await readFile(join(paths.temporary, directory, "prompt"), "utf8"), draft);
	assert.equal(draft, "keep this draft\n");
});

test("retains output from a nonzero editor exit", async (t) => {
	const paths = await fixture(t);
	const editor = join(paths.root, "failed editor.mjs");
	await writeFile(editor, `
import { writeFile } from "node:fs/promises";
await writeFile(process.argv[2], "partial edit\\n");
process.exitCode = 23;
`);
	const draft = "caller draft";
	const error = await editPrompt(draft, paths.cwd, environment(paths.temporary, {
		VISUAL: "",
		EDITOR: `${shellQuote(process.execPath)} ${shellQuote(editor)}`,
	}), new AbortController().signal).then(
		() => assert.fail("nonzero editor unexpectedly succeeded"),
		(reason: unknown) => reason as Error,
	);
	assert.match(error.message, /status 23/u);
	const [directory] = await readdir(paths.temporary);
	assert.equal(await readFile(join(paths.temporary, directory, "prompt"), "utf8"), "partial edit\n");
	assert.equal(draft, "caller draft");
});

test("cleans up after a shell spawn failure and does not launch when pre-aborted", async (t) => {
	const paths = await fixture(t);
	const draft = "unchanged";
	await assert.rejects(
		editPrompt(draft, join(paths.root, "missing cwd"), environment(paths.temporary), new AbortController().signal),
		(error: Error & { cause?: NodeJS.ErrnoException }) => error.message.includes("Unable to start") && error.cause?.code === "ENOENT",
	);
	assert.deepEqual(await readdir(paths.temporary), []);

	const editor = join(paths.root, "marker editor.mjs");
	const marker = join(paths.root, "editor started");
	await writeFile(editor, `
import { writeFile } from "node:fs/promises";
await writeFile(process.env.MARKER_FILE, "started");
`);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(editPrompt(draft, paths.cwd, environment(paths.temporary, {
		VISUAL: "",
		EDITOR: `${shellQuote(process.execPath)} ${shellQuote(editor)}`,
		MARKER_FILE: marker,
	}), controller.signal), /aborted/u);
	assert.equal(existsSync(marker), false);
	assert.deepEqual(await readdir(paths.temporary), []);
	assert.equal(draft, "unchanged");
});

test("aborts and reaps a live editor, preserving its draft", async (t) => {
	const paths = await fixture(t);
	const editor = join(paths.root, "stubborn editor.mjs");
	const pidFile = join(paths.root, "editor pid");
	const writesFile = join(paths.root, "helper writes");
	let editorPid: number | undefined;
	let helperPid: number | undefined;
	t.after(() => {
		for (const pid of [editorPid, helperPid]) {
			if (pid === undefined) continue;
			try {
				process.kill(pid, "SIGKILL");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
			}
		}
	});
	await writeFile(editor, `
import { appendFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
if (process.argv[2] === "--helper") {
  process.on("SIGTERM", () => {});
  const write = () => appendFileSync(process.env.WRITES_FILE, "write\\n", "utf8");
  write();
  setInterval(write, 20);
  await new Promise(() => {});
} else {
  const helper = spawn(process.execPath, [process.argv[1], "--helper"], { stdio: "inherit" });
  process.on("SIGTERM", () => {});
  writeFileSync(process.env.PID_FILE, JSON.stringify({ editor: process.pid, helper: helper.pid }));
  await new Promise(() => {});
}
`);
	const controller = new AbortController();
	const pending = editPrompt("recover this\n", paths.cwd, environment(paths.temporary, {
		VISUAL: "",
		EDITOR: `${shellQuote(process.execPath)} ${shellQuote(editor)}`,
		PID_FILE: pidFile,
		WRITES_FILE: writesFile,
	}), controller.signal);
	try {
		const deadline = Date.now() + 5_000;
		while (!existsSync(pidFile) && Date.now() < deadline) await new Promise((resolveWait) => setTimeout(resolveWait, 10));
		assert.ok(existsSync(pidFile), "fake editor did not start");
		const pids = JSON.parse(await readFile(pidFile, "utf8")) as { editor: number; helper: number };
		const editorProcess = pids.editor;
		const helperProcess = pids.helper;
		editorPid = editorProcess;
		helperPid = helperProcess;
		const writeDeadline = Date.now() + 5_000;
		while (!existsSync(writesFile) && Date.now() < writeDeadline) await new Promise((resolveWait) => setTimeout(resolveWait, 10));
		assert.ok(existsSync(writesFile), "fake editor helper did not start writing");
		controller.abort();
		await assert.rejects(pending, /aborted; draft retained at/u);
		assert.throws(() => process.kill(editorProcess, 0), { code: "ESRCH" }, "editor process remained live after abort");
		assert.throws(() => process.kill(helperProcess, 0), { code: "ESRCH" }, "editor helper remained live after abort");
		const writesAtExit = await readFile(writesFile, "utf8");
		await new Promise((resolveWait) => setTimeout(resolveWait, 100));
		assert.equal(await readFile(writesFile, "utf8"), writesAtExit, "editor helper wrote after abort cleanup completed");
		const [directory] = await readdir(paths.temporary);
		assert.equal(await readFile(join(paths.temporary, directory, "prompt"), "utf8"), "recover this\n");
	} finally {
		if (!controller.signal.aborted) controller.abort();
		await pending.catch(() => undefined);
	}
});
