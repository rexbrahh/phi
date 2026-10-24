import assert from "node:assert/strict";
import fs from "node:fs";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runUserShell, type ShellPreview } from "../src/shell.js";

function setEnvironment(values: Record<string, string>): () => void {
	const previous = new Map<string, string | undefined>();
	for (const [name, value] of Object.entries(values)) {
		previous.set(name, process.env[name]);
		process.env[name] = value;
	}
	return () => {
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	};
}

function quoteShell(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test("runUserShell passes the exact command and inherited environment and stores private split output", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "phi shell "));
	const stateHome = join(temporary, "state home");
	const fakeShell = join(temporary, "configured shell");
	const capturePath = join(temporary, "captured arguments.txt");
	const restoreEnvironment = setEnvironment({
		XDG_STATE_HOME: stateHome,
		SHELL: fakeShell,
		PHI_TEST_CAPTURE: capturePath,
		PHI_TEST_VALUE: "inherited value",
	});

	try {
		await writeFile(
			fakeShell,
			'#!/bin/sh\nprintf \'%s\\n\' "$#" "$1" "$2" "$PHI_TEST_VALUE" > "$PHI_TEST_CAPTURE"\n' +
			"printf 'stdout line\\n'\n" +
			"printf 'stderr line\\n' >&2\n" +
			"if IFS= read -r line; then printf 'stdin open\\n'; else printf 'stdin closed\\n'; fi\n",
			{ mode: 0o700 },
		);
		await chmod(fakeShell, 0o700);

		const command = `printf '%s' 'quoted command with spaces'`;
		const previews: ShellPreview[] = [];
		const job = runUserShell(command, temporary, "session-alpha", new AbortController().signal, (preview) => {
			previews.push(preview);
		});
		const receipt = await job.done;

		assert.equal(receipt.command, command);
		assert.equal(receipt.cwd, temporary);
		assert.equal(receipt.jobId, job.jobId);
		assert.equal(receipt.exitCode, 0);
		assert.equal(receipt.signal, null);
		assert.equal(receipt.aborted, false);
		assert.equal(receipt.infrastructureError, undefined);
		assert.deepEqual((await readFile(capturePath, "utf8")).split("\n"), [
			"2",
			"-lc",
			command,
			"inherited value",
			"",
		]);
		assert.equal(await readFile(receipt.outputFiles.stdout!, "utf8"), "stdout line\nstdin closed\n");
		assert.equal(await readFile(receipt.outputFiles.stderr!, "utf8"), "stderr line\n");
		assert.ok(previews.length > 0);
		assert.equal(previews.at(-1)?.stdout, "stdout line\nstdin closed\n");
		assert.equal(previews.at(-1)?.stderr, "stderr line\n");

		for (const directory of [join(stateHome, "phi"), join(stateHome, "phi", "session-alpha"), join(stateHome, "phi", "session-alpha", "shell")]) {
			assert.equal((await stat(directory)).mode & 0o777, 0o700);
		}
		for (const outputPath of Object.values(receipt.outputFiles)) {
			assert.ok(outputPath);
			assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
		}
	} finally {
		restoreEnvironment();
		await rm(temporary, { recursive: true, force: true });
	}
});

test("runUserShell preserves UTF-8 characters split across child output chunks", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "phi shell unicode "));
	const restoreEnvironment = setEnvironment({ XDG_STATE_HOME: join(temporary, "state"), SHELL: "/bin/sh" });
	try {
		const command = "printf '\\360'; sleep 0.05; printf '\\237\\214\\237'";
		let latest: ShellPreview | undefined;
		const receipt = await runUserShell(command, temporary, "unicode-session", new AbortController().signal, (preview) => {
			latest = preview;
		}).done;
		assert.equal(receipt.exitCode, 0);
		assert.equal(await readFile(receipt.outputFiles.stdout!, "utf8"), "🌟");
		assert.equal(latest?.stdout, "🌟");
	} finally {
		restoreEnvironment();
		await rm(temporary, { recursive: true, force: true });
	}
});

test("runUserShell keeps previews bounded while preserving complete output on disk", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "phi shell output "));
	const restoreEnvironment = setEnvironment({ XDG_STATE_HOME: join(temporary, "state"), SHELL: "/bin/sh" });
	try {
		let latest: ShellPreview | undefined;
		const command = "printf '%*s' 20000 '' | tr ' ' x";
		const receipt = await runUserShell(command, temporary, "large-session", new AbortController().signal, (preview) => {
			latest = preview;
		}).done;
		assert.equal(receipt.exitCode, 0);
		assert.equal((await readFile(receipt.outputFiles.stdout!, "utf8")).length, 20_000);
		assert.ok(latest);
		assert.equal(latest.stdout.length, 8_192);
		assert.equal(latest.stdoutTruncated, true);
		assert.equal(latest.stderr.length, 0);
	} finally {
		restoreEnvironment();
		await rm(temporary, { recursive: true, force: true });
	}
});

test("runUserShell reports nonzero exit status and spawn failure as receipts", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "phi shell failures "));
	const stateHome = join(temporary, "state");
	const restoreEnvironment = setEnvironment({ XDG_STATE_HOME: stateHome, SHELL: "/bin/sh" });
	try {
		const failedCommand = await runUserShell("exit 7", temporary, "exit-session", new AbortController().signal, () => {}).done;
		assert.equal(failedCommand.exitCode, 7);
		assert.equal(failedCommand.signal, null);
		assert.equal(failedCommand.aborted, false);

		process.env.SHELL = join(temporary, "shell that does not exist");
		const spawnFailure = await runUserShell("true", temporary, "spawn-session", new AbortController().signal, () => {}).done;
		assert.equal(spawnFailure.exitCode, null);
		assert.equal(spawnFailure.signal, null);
		assert.match(spawnFailure.infrastructureError ?? "", /not found|no such file|enoent/i);
		assert.ok(spawnFailure.outputFiles.stdout);
		assert.ok(spawnFailure.outputFiles.stderr);
	} finally {
		restoreEnvironment();
		await rm(temporary, { recursive: true, force: true });
	}
});

test("runUserShell reports output storage failure without hiding command completion", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "phi shell storage "));
	const stateBlocker = join(temporary, "state is a file");
	await writeFile(stateBlocker, "not a directory");
	const restoreEnvironment = setEnvironment({ XDG_STATE_HOME: stateBlocker, SHELL: "/bin/sh" });
	try {
		const receipt = await runUserShell("printf 'completed'", temporary, "storage-session", new AbortController().signal, () => {}).done;
		assert.equal(receipt.exitCode, 0);
		assert.match(receipt.infrastructureError ?? "", /not a directory|enotdir/i);
		assert.deepEqual(receipt.outputFiles, {});
	} finally {
		restoreEnvironment();
		await rm(temporary, { recursive: true, force: true });
	}
});

test("runUserShell reports a disk write error and continues draining child output", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "phi shell write failure "));
	const restoreEnvironment = setEnvironment({ XDG_STATE_HOME: join(temporary, "state"), SHELL: "/bin/sh" });
	const originalCreateWriteStream = fs.createWriteStream;
	fs.createWriteStream = ((path, options) => {
		const stream = originalCreateWriteStream(path, options);
		if (String(path).includes("stdout-")) {
			stream.write = (() => {
				process.nextTick(() => stream.emit("error", new Error("simulated disk write failure")));
				return false;
			}) as typeof stream.write;
		}
		return stream;
	}) as typeof fs.createWriteStream;
	syncBuiltinESMExports();
	try {
		let latest: ShellPreview | undefined;
		const command = "printf 'preview remains available'; printf 'stderr remains available' >&2";
		const receipt = await runUserShell(command, temporary, "write-failure-session", new AbortController().signal, (preview) => {
			latest = preview;
		}).done;
		assert.equal(receipt.exitCode, 0);
		assert.match(receipt.infrastructureError ?? "", /cannot write stdout output: simulated disk write failure/);
		assert.equal(latest?.stdout, "preview remains available");
		assert.equal(latest?.stderr, "stderr remains available");
		assert.ok(receipt.outputFiles.stdout);
		assert.equal(await readFile(receipt.outputFiles.stdout!, "utf8"), "");
		assert.equal(await readFile(receipt.outputFiles.stderr!, "utf8"), "stderr remains available");
	} finally {
		fs.createWriteStream = originalCreateWriteStream;
		syncBuiltinESMExports();
		restoreEnvironment();
		await rm(temporary, { recursive: true, force: true });
	}
});

test("runUserShell abort kills its process group and does not report success", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "phi shell cancel "));
	const stateHome = join(temporary, "state");
	const pidPath = join(temporary, "child ids.txt");
	const markerPath = join(temporary, "descendant marker.txt");
	const restoreEnvironment = setEnvironment({ XDG_STATE_HOME: stateHome, SHELL: "/bin/sh" });
	const controller = new AbortController();
	let shellPid: number | undefined;
	try {
		const command = `(trap '' TERM; while :; do sleep 0.05; printf x >> ${quoteShell(markerPath)}; done) & printf '%s %s\\n' "$$" "$!" > ${quoteShell(pidPath)}; wait`;
		const job = runUserShell(command, temporary, "cancel-session", controller.signal, () => {});
		for (let attempt = 0; attempt < 150; attempt += 1) {
			try {
				const [shellId] = (await readFile(pidPath, "utf8")).trim().split(" ").map(Number);
				shellPid = shellId;
				break;
			} catch {
				await delay(20);
			}
		}
		assert.ok(shellPid, "the child shell should have started");
		controller.abort();
		let timeout: NodeJS.Timeout | undefined;
		const receipt = await Promise.race([
			job.done,
			new Promise<never>((_, reject) => {
				timeout = setTimeout(() => reject(new Error("cancelled shell did not settle")), 7_000);
			}),
		]);
		if (timeout) clearTimeout(timeout);
		assert.equal(receipt.aborted, true);
		assert.equal(receipt.exitCode, null);
		assert.ok(receipt.signal);
		const markerSize = await stat(markerPath).then((info) => info.size, () => 0);
		await delay(150);
		assert.equal(await stat(markerPath).then((info) => info.size, () => 0), markerSize);
	} finally {
		if (shellPid) {
			try {
				process.kill(-shellPid, "SIGKILL");
			} catch {
				// The process group has already exited.
			}
		}
		restoreEnvironment();
		await rm(temporary, { recursive: true, force: true });
	}
});

test("runUserShell allows only one active local job", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "phi shell single "));
	const restoreEnvironment = setEnvironment({ XDG_STATE_HOME: join(temporary, "state"), SHELL: "/bin/sh" });
	const controller = new AbortController();
	try {
		const first = runUserShell("sleep 30", temporary, "single-session", controller.signal, () => {});
		assert.throws(
			() => runUserShell("true", temporary, "single-session", new AbortController().signal, () => {}),
			/one local shell job/i,
		);
		controller.abort();
		await first.done;
	} finally {
		restoreEnvironment();
		await rm(temporary, { recursive: true, force: true });
	}
});
