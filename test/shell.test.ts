import assert from "node:assert/strict";
import fs from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
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

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function processGroupExists(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function withinDeadline<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
	let timeout: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timeout = setTimeout(() => reject(new Error(message)), milliseconds);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

test("runUserShell passes the exact command and inherited environment and stores private split output", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "phi shell "));
	const stateHome = join(temporary, "state home");
	const fakeShell = join(temporary, "configured shell");
	const capturePath = join(temporary, "captured arguments.txt");
	const cwdCapturePath = join(temporary, "captured cwd.txt");
	const restoreEnvironment = setEnvironment({
		XDG_STATE_HOME: stateHome,
		SHELL: fakeShell,
		PHI_TEST_CAPTURE: capturePath,
		PHI_TEST_CWD_CAPTURE: cwdCapturePath,
		PHI_TEST_VALUE: "inherited value",
	});

	try {
		await writeFile(
			fakeShell,
			'#!/bin/sh\nprintf \'%s\\n\' "$#" "$1" "$2" "$PHI_TEST_VALUE" > "$PHI_TEST_CAPTURE"\n' +
			'pwd > "$PHI_TEST_CWD_CAPTURE"\n' +
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
		}, temporary);
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
		assert.equal((await readFile(cwdCapturePath, "utf8")).trimEnd(), await realpath(temporary));
		assert.equal(await readFile(receipt.outputFiles.stdout!, "utf8"), "stdout line\nstdin closed\n");
		assert.equal(await readFile(receipt.outputFiles.stderr!, "utf8"), "stderr line\n");
		assert.ok(previews.length > 0);
		assert.equal(previews.at(-1)?.stdout, "stdout line\nstdin closed\n");
		assert.equal(previews.at(-1)?.stderr, "stderr line\n");

		for (const directory of [temporary, join(temporary, "state"), join(temporary, "state", "session-alpha"), join(temporary, "state", "session-alpha", "shell")]) {
			assert.equal((await stat(directory)).mode & 0o777, 0o700);
		}
		assert.ok(receipt.outputFiles.stdout?.startsWith(join(temporary, "state", "session-alpha", "shell")));
		assert.ok(!receipt.outputFiles.stdout?.startsWith(stateHome));
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
		}, temporary).done;
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
		}, temporary).done;
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
		const failedCommand = await runUserShell("exit 7", temporary, "exit-session", new AbortController().signal, () => {}, temporary).done;
		assert.equal(failedCommand.exitCode, 7);
		assert.equal(failedCommand.signal, null);
		assert.equal(failedCommand.aborted, false);

		process.env.SHELL = join(temporary, "shell that does not exist");
		const spawnFailure = await runUserShell("true", temporary, "spawn-session", new AbortController().signal, () => {}, temporary).done;
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
	const stateBlocker = join(temporary, "state");
	await writeFile(stateBlocker, "not a directory");
	const restoreEnvironment = setEnvironment({ XDG_STATE_HOME: join(temporary, "elsewhere"), SHELL: "/bin/sh" });
	try {
		const receipt = await runUserShell("printf 'completed'", temporary, "storage-session", new AbortController().signal, () => {}, temporary).done;
		assert.equal(receipt.exitCode, 0);
		assert.match(receipt.infrastructureError ?? "", /not a directory|enotdir/i);
		assert.deepEqual(receipt.outputFiles, {});
	} finally {
		restoreEnvironment();
		await rm(temporary, { recursive: true, force: true });
	}
});

test("runUserShell rejects symlinked app directories without changing outside targets", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "phi shell symlink "));
	const home = join(temporary, "phi-home");
	const stateDirectory = join(home, "state");
	const sessionDirectory = join(stateDirectory, "symlink-session");
	const shellDirectory = join(sessionDirectory, "shell");
	const outsideDirectory = join(temporary, "outside target");
	const outsideFile = join(outsideDirectory, "important.txt");
	const restoreEnvironment = setEnvironment({ XDG_STATE_HOME: join(temporary, "elsewhere"), SHELL: "/bin/sh" });
	await mkdir(outsideDirectory);
	await mkdir(home);
	await writeFile(outsideFile, "outside contents remain unchanged\n");
	await chmod(outsideDirectory, 0o755);
	const originalMode = (await stat(outsideDirectory)).mode & 0o777;
	const originalContents = await readFile(outsideFile, "utf8");
	try {
		for (const component of ["state", "session", "shell"] as const) {
			await rm(stateDirectory, { recursive: true, force: true });
			if (component === "state") {
				await symlink(outsideDirectory, stateDirectory);
			} else {
				await mkdir(stateDirectory, { recursive: true });
				if (component === "session") await symlink(outsideDirectory, sessionDirectory);
				else {
					await mkdir(sessionDirectory);
					await symlink(outsideDirectory, shellDirectory);
				}
			}

			const receipt = await runUserShell(
				"printf 'output must not reach the outside target'",
				temporary,
				"symlink-session",
				new AbortController().signal,
				() => {},
				home,
			).done;
			assert.match(receipt.infrastructureError ?? "", /symbolic link/i, `${component} symlink must report an infrastructure error`);
			assert.deepEqual(receipt.outputFiles, {});
			assert.equal((await stat(outsideDirectory)).mode & 0o777, originalMode);
			assert.deepEqual(await readdir(outsideDirectory), ["important.txt"]);
			assert.equal(await readFile(outsideFile, "utf8"), originalContents);
			const componentPath = component === "state" ? stateDirectory : component === "session" ? sessionDirectory : shellDirectory;
			assert.ok((await lstat(componentPath)).isSymbolicLink());
		}
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
		}, temporary).done;
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
		const job = runUserShell(command, temporary, "cancel-session", controller.signal, () => {}, temporary);
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

test("runUserShell keeps a background descendant owned and cancellable after the shell exits", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "phi shell detached descendant "));
	const stateHome = join(temporary, "state");
	const pidPath = join(temporary, "process ids.txt");
	const markerPath = join(temporary, "descendant marker.txt");
	const restoreEnvironment = setEnvironment({ XDG_STATE_HOME: stateHome, SHELL: "/bin/sh" });
	const controller = new AbortController();
	let shellPid: number | undefined;
	try {
		const command = `(trap '' TERM; while :; do printf x >> ${quoteShell(markerPath)}; sleep 0.05; done) >/dev/null 2>&1 & printf '%s %s\\n' "$$" "$!" > ${quoteShell(pidPath)}; exit 0`;
		const job = runUserShell(command, temporary, "detached-session", controller.signal, () => {}, temporary);
		let jobSettled = false;
		void job.done.then(() => {
			jobSettled = true;
		});

		let descendantPid: number | undefined;
		for (let attempt = 0; attempt < 150; attempt += 1) {
			try {
				[shellPid, descendantPid] = (await readFile(pidPath, "utf8")).trim().split(" ").map(Number);
				break;
			} catch {
				await delay(20);
			}
		}
		assert.ok(shellPid, "the shell should record its process ID");
		assert.ok(descendantPid, "the shell should record its descendant process ID");

		let shellExited = false;
		for (let attempt = 0; attempt < 150; attempt += 1) {
			if (!processExists(shellPid)) {
				shellExited = true;
				break;
			}
			await delay(20);
		}
		assert.ok(shellExited, "the shell should exit before its descendant");
		assert.ok(processGroupExists(shellPid), "the descendant should keep the owned process group alive");
		await delay(100);
		assert.equal(jobSettled, false, "job.done should wait while the owned process group is alive");
		assert.throws(
			() => runUserShell("true", temporary, "detached-session", new AbortController().signal, () => {}, temporary),
			/one local shell job/i,
		);

		controller.abort();
		const receipt = await withinDeadline(job.done, 7_000, "cancelled detached descendant did not settle");
		assert.equal(receipt.aborted, true);
		assert.equal(receipt.exitCode, null);
		assert.ok(receipt.signal);
		const markerSize = await stat(markerPath).then((info) => info.size, () => 0);
		await delay(150);
		assert.equal(await stat(markerPath).then((info) => info.size, () => 0), markerSize);
	} finally {
		controller.abort();
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

test("runUserShell reports no signal when an already-aborted job starts no child", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "phi shell pre-aborted "));
	const restoreEnvironment = setEnvironment({ XDG_STATE_HOME: join(temporary, "state"), SHELL: "/bin/sh" });
	const controller = new AbortController();
	controller.abort();
	try {
		const receipt = await runUserShell("true", temporary, "pre-aborted-session", controller.signal, () => {}, temporary).done;
		assert.equal(receipt.aborted, true);
		assert.equal(receipt.exitCode, null);
		assert.equal(receipt.signal, null);
	} finally {
		restoreEnvironment();
		await rm(temporary, { recursive: true, force: true });
	}
});

test("runUserShell reports no signal when abort races with process-group disappearance", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "phi shell disappearing group "));
	const restoreEnvironment = setEnvironment({ XDG_STATE_HOME: join(temporary, "state"), SHELL: "/bin/sh" });
	const controller = new AbortController();
	const originalKill = process.kill;
	let groupDisappearanceObserved = false;
	process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
		if (pid < 0) {
			if (signal === 0) {
				groupDisappearanceObserved = true;
				controller.abort();
			}
			throw Object.assign(new Error("no such process group"), { code: "ESRCH" });
		}
		return originalKill(pid, signal);
	}) as typeof process.kill;
	try {
		const receipt = await runUserShell("true", temporary, "disappearing-group-session", controller.signal, () => {}, temporary).done;
		assert.equal(groupDisappearanceObserved, true);
		assert.equal(receipt.aborted, true);
		assert.equal(receipt.exitCode, null);
		assert.equal(receipt.signal, null);
	} finally {
		process.kill = originalKill;
		restoreEnvironment();
		await rm(temporary, { recursive: true, force: true });
	}
});

test("runUserShell removes its abort listener after the process group disappears", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "phi shell empty group abort "));
	const restoreEnvironment = setEnvironment({ XDG_STATE_HOME: join(temporary, "state"), SHELL: "/bin/sh" });
	const controller = new AbortController();
	const originalKill = process.kill;
	const originalCreateWriteStream = fs.createWriteStream;
	let groupDisappearanceObserved = false;
	let finishCount = 0;
	let announceSinksFinishing!: () => void;
	let releaseSinks!: () => void;
	const sinksFinishing = new Promise<void>((resolve) => {
		announceSinksFinishing = resolve;
	});
	const sinksReleased = new Promise<void>((resolve) => {
		releaseSinks = resolve;
	});
	process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
		if (pid < 0) {
			if (signal === 0) groupDisappearanceObserved = true;
			throw Object.assign(new Error("no such process group"), { code: "ESRCH" });
		}
		return originalKill(pid, signal);
	}) as typeof process.kill;
	fs.createWriteStream = ((path, options) => {
		const stream = originalCreateWriteStream(path, options);
		const originalEnd = stream.end.bind(stream);
		stream.end = (() => {
			finishCount += 1;
			if (finishCount === 2) announceSinksFinishing();
			void sinksReleased.then(() => originalEnd());
			return stream;
		}) as typeof stream.end;
		return stream;
	}) as typeof fs.createWriteStream;
	syncBuiltinESMExports();
	let job: ReturnType<typeof runUserShell> | undefined;
	try {
		job = runUserShell("true", temporary, "empty-group-abort-session", controller.signal, () => {}, temporary);
		const pendingReceipt = job.done;
		await withinDeadline(sinksFinishing, 3_000, "output sinks did not enter finish");
		assert.equal(groupDisappearanceObserved, true);
		controller.abort();
		releaseSinks();
		const receipt = await withinDeadline(pendingReceipt, 3_000, "shell receipt did not finish");
		assert.equal(receipt.aborted, false);
		assert.equal(receipt.exitCode, 0);
		assert.equal(receipt.signal, null);
	} finally {
		releaseSinks();
		if (job) await job.done;
		process.kill = originalKill;
		fs.createWriteStream = originalCreateWriteStream;
		syncBuiltinESMExports();
		restoreEnvironment();
		await rm(temporary, { recursive: true, force: true });
	}
});

test("runUserShell allows only one active local job", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "phi shell single "));
	const restoreEnvironment = setEnvironment({ XDG_STATE_HOME: join(temporary, "state"), SHELL: "/bin/sh" });
	const controller = new AbortController();
	const pidPath = join(temporary, "shell id.txt");
	let shellPid: number | undefined;
	try {
		const first = runUserShell(`printf '%s\\n' "$$" > ${quoteShell(pidPath)}; sleep 30`, temporary, "single-session", controller.signal, () => {}, temporary);
		assert.throws(
			() => runUserShell("true", temporary, "single-session", new AbortController().signal, () => {}, temporary),
			/one local shell job/i,
		);
		for (let attempt = 0; attempt < 150; attempt += 1) {
			try {
				shellPid = Number((await readFile(pidPath, "utf8")).trim());
				break;
			} catch {
				await delay(20);
			}
		}
		assert.ok(shellPid, "the active shell should have started");
		controller.abort();
		await withinDeadline(first.done, 7_000, "aborted active shell did not settle");
	} finally {
		controller.abort();
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
