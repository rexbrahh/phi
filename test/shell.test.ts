import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runUserShell, type ShellPreview, type ShellReceipt } from "../src/shell.js";

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

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		env: {
			...process.env,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_AUTHOR_NAME: "Workspace Test",
			GIT_AUTHOR_EMAIL: "workspace-test@example.invalid",
			GIT_COMMITTER_NAME: "Workspace Test",
			GIT_COMMITTER_EMAIL: "workspace-test@example.invalid",
		},
	});
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
		GIT_SSH_COMMAND: "ssh -o BatchMode=yes -i /tmp/phi-test-key",
		GIT_CONFIG_COUNT: "2",
		GIT_CONFIG_KEY_0: "commit.gpgsign",
		GIT_CONFIG_VALUE_0: "true",
		GIT_CONFIG_KEY_1: "user.signingkey",
		GIT_CONFIG_VALUE_1: "test-signing-key",
	});

	try {
		await writeFile(
			fakeShell,
			'#!/bin/sh\nprintf \'%s\\n\' "$#" "$1" "$2" "$PHI_TEST_VALUE" "$GIT_SSH_COMMAND" "$GIT_CONFIG_COUNT" "$GIT_CONFIG_KEY_0" "$GIT_CONFIG_VALUE_0" "$GIT_CONFIG_KEY_1" "$GIT_CONFIG_VALUE_1" > "$PHI_TEST_CAPTURE"\n' +
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
			"ssh -o BatchMode=yes -i /tmp/phi-test-key",
			"2",
			"commit.gpgsign",
			"true",
			"user.signingkey",
			"test-signing-key",
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

test("runUserShell Git commands follow the linked cwd despite inherited Git routing selectors", async () => {
	const temporary = await mkdtemp(join("/private/tmp", "phi shell git context "));
	const restoreEnvironment = setEnvironment({
		XDG_STATE_HOME: join(temporary, "state"),
		SHELL: "/bin/sh",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "Workspace Test",
		GIT_AUTHOR_EMAIL: "workspace-test@example.invalid",
		GIT_COMMITTER_NAME: "Workspace Test",
		GIT_COMMITTER_EMAIL: "workspace-test@example.invalid",
	});
	const routingVariables = ["GIT_INDEX_FILE", "GIT_DIR", "GIT_WORK_TREE"] as const;
	const originalRouting = new Map(routingVariables.map((name) => [name, process.env[name]]));
	const linkedWorktrees: Array<[string, string]> = [];
	for (const name of routingVariables) delete process.env[name];

	try {
		for (const name of routingVariables) {
			const repository = join(temporary, `${name} primary`);
			const linkedWorktree = join(temporary, `${name} linked`);
			await mkdir(repository);
			git(repository, "init", "--quiet", "-b", "main");
			git(repository, "config", "user.name", "Workspace Test");
			git(repository, "config", "user.email", "workspace-test@example.invalid");
			await writeFile(join(repository, "tracked.txt"), "committed content\n");
			await writeFile(join(repository, "primary-only.txt"), "committed primary content\n");
			git(repository, "add", "--", "tracked.txt", "primary-only.txt");
			git(repository, "commit", "--quiet", "-m", "test base");
			const baseRevision = git(repository, "rev-parse", "HEAD").trim();

			await writeFile(join(repository, "primary-only.txt"), "staged primary content\n");
			git(repository, "add", "--", "primary-only.txt");
			const primaryState = async () => ({
				status: git(repository, "status", "--porcelain=v1", "--untracked-files=no"),
				indexBlob: git(repository, "rev-parse", ":primary-only.txt").trim(),
				indexContent: git(repository, "show", ":primary-only.txt"),
				worktreeContent: await readFile(join(repository, "primary-only.txt"), "utf8"),
			});
			const stagedPrimaryState = await primaryState();
			assert.equal(stagedPrimaryState.status, "M  primary-only.txt\n");
			assert.equal(stagedPrimaryState.indexContent, "staged primary content\n");
			assert.equal(stagedPrimaryState.worktreeContent, "staged primary content\n");
			assert.notEqual(stagedPrimaryState.indexBlob, git(repository, "rev-parse", "HEAD:primary-only.txt").trim());

			git(repository, "worktree", "add", "--quiet", "--detach", linkedWorktree, baseRevision);
			linkedWorktrees.push([repository, linkedWorktree]);
			const changedContent = `selected ${name} content\n`;
			await writeFile(join(linkedWorktree, "tracked.txt"), changedContent);
			const linkedIndexBefore = git(linkedWorktree, "rev-parse", ":tracked.txt").trim();
			const expectedLinkedBlob = git(linkedWorktree, "hash-object", "tracked.txt").trim();
			assert.notEqual(linkedIndexBefore, expectedLinkedBlob);

			const gitDirectory = git(repository, "rev-parse", "--absolute-git-dir").trim();
			const selector = name === "GIT_INDEX_FILE"
				? join(gitDirectory, "index")
				: name === "GIT_DIR" ? gitDirectory : repository;
			process.env[name] = selector;
			const command = "git add -- tracked.txt";
			let receipt: ShellReceipt;
			try {
				receipt = await runUserShell(
					command,
					linkedWorktree,
					`git-routing-${name.toLowerCase()}`,
					new AbortController().signal,
					() => {},
					temporary,
				).done;
			} finally {
				for (const variable of routingVariables) delete process.env[variable];
			}

			assert.equal(receipt.command, command);
			assert.equal(receipt.cwd, linkedWorktree);
			assert.equal(receipt.exitCode, 0);
			assert.equal(receipt.signal, null);
			assert.deepEqual(await primaryState(), stagedPrimaryState, `${name} must not change staged primary state`);
			assert.notEqual(git(linkedWorktree, "rev-parse", ":tracked.txt").trim(), linkedIndexBefore);
			assert.equal(git(linkedWorktree, "rev-parse", ":tracked.txt").trim(), expectedLinkedBlob);
			assert.equal(git(linkedWorktree, "show", ":tracked.txt"), changedContent);
			assert.equal(git(linkedWorktree, "status", "--porcelain=v1", "--untracked-files=no"), "M  tracked.txt\n");
		}
	} finally {
		for (const variable of routingVariables) delete process.env[variable];
		try {
			for (const [repository, linkedWorktree] of linkedWorktrees) {
				git(repository, "worktree", "remove", "--force", linkedWorktree);
			}
		} finally {
			restoreEnvironment();
			for (const [name, value] of originalRouting) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
			await rm(temporary, { recursive: true, force: true });
		}
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

test("runUserShell isolates a merge conflict and abort from staged work in the primary worktree", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "phi shell linked worktree "));
	const repository = join(temporary, "primary repository");
	const linkedWorktree = join(temporary, "conflict worktree");
	const stateHome = join(temporary, "state");
	const restoreEnvironment = setEnvironment({
		XDG_STATE_HOME: stateHome,
		SHELL: "/bin/sh",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "Workspace Test",
		GIT_AUTHOR_EMAIL: "workspace-test@example.invalid",
		GIT_COMMITTER_NAME: "Workspace Test",
		GIT_COMMITTER_EMAIL: "workspace-test@example.invalid",
	});
	let linkedWorktreeAdded = false;

	try {
		await mkdir(repository);
		git(repository, "init", "--quiet", "-b", "conflict-main");
		git(repository, "config", "user.name", "Workspace Test");
		git(repository, "config", "user.email", "workspace-test@example.invalid");
		git(repository, "config", "commit.gpgsign", "false");
		await writeFile(join(repository, "conflict.txt"), "base conflict content\n");
		await writeFile(join(repository, "primary.txt"), "base primary content\n");
		git(repository, "add", "--", "conflict.txt", "primary.txt");
		git(repository, "commit", "--quiet", "-m", "test base");
		const baseRevision = git(repository, "rev-parse", "HEAD").trim();

		await writeFile(join(repository, "conflict.txt"), "main conflict content\n");
		git(repository, "add", "--", "conflict.txt");
		git(repository, "commit", "--quiet", "-m", "main conflict change");
		const mainRevision = git(repository, "rev-parse", "HEAD").trim();

		git(repository, "switch", "--quiet", "--create", "conflict-topic", baseRevision);
		await writeFile(join(repository, "conflict.txt"), "topic conflict content\n");
		git(repository, "add", "--", "conflict.txt");
		git(repository, "commit", "--quiet", "-m", "topic conflict change");
		const topicRevision = git(repository, "rev-parse", "HEAD").trim();
		git(repository, "switch", "--quiet", "conflict-main");
		assert.equal(git(repository, "merge-base", "conflict-main", "conflict-topic").trim(), baseRevision);

		const primaryFile = join(repository, "primary.txt");
		await writeFile(primaryFile, "staged primary content\n");
		git(repository, "add", "--", "primary.txt");
		const primaryState = async () => ({
			status: git(repository, "status", "--porcelain=v1", "--untracked-files=no"),
			indexBlob: git(repository, "rev-parse", ":primary.txt").trim(),
			indexContent: git(repository, "show", ":primary.txt"),
			worktreeContent: await readFile(primaryFile, "utf8"),
		});
		const stagedPrimaryState = await primaryState();
		assert.deepEqual(stagedPrimaryState, {
			status: "M  primary.txt\n",
			indexBlob: stagedPrimaryState.indexBlob,
			indexContent: "staged primary content\n",
			worktreeContent: "staged primary content\n",
		});
		assert.notEqual(stagedPrimaryState.indexBlob, git(repository, "rev-parse", "HEAD:primary.txt").trim());

		git(repository, "worktree", "add", "--quiet", "--detach", linkedWorktree, mainRevision);
		linkedWorktreeAdded = true;
		assert.equal(git(linkedWorktree, "status", "--porcelain=v1", "--untracked-files=no"), "");
		assert.deepEqual(await primaryState(), stagedPrimaryState, "adding the clean linked worktree must preserve staged primary state");

		const mergeCommand = "git merge --no-edit conflict-topic";
		const mergeReceipt = await runUserShell(
			mergeCommand,
			linkedWorktree,
			"linked-worktree-conflict",
			new AbortController().signal,
			() => {},
			temporary,
		).done;
		assert.equal(mergeReceipt.command, mergeCommand);
		assert.equal(mergeReceipt.cwd, linkedWorktree);
		assert.equal(mergeReceipt.exitCode, 1, "native Git merge must report its conflict with a nonzero exit");
		assert.equal(mergeReceipt.signal, null);
		assert.equal(mergeReceipt.aborted, false);
		assert.equal(mergeReceipt.infrastructureError, undefined);
		assert.ok(mergeReceipt.outputFiles.stdout);
		assert.ok(mergeReceipt.outputFiles.stderr);
		const mergeOutput = `${await readFile(mergeReceipt.outputFiles.stdout!, "utf8")}${await readFile(mergeReceipt.outputFiles.stderr!, "utf8")}`;
		assert.match(mergeOutput, /CONFLICT \(content\): Merge conflict in conflict\.txt/);

		assert.equal(git(linkedWorktree, "status", "--porcelain=v1", "--untracked-files=no"), "UU conflict.txt\n");
		assert.equal(
			await readFile(join(linkedWorktree, "conflict.txt"), "utf8"),
			"<<<<<<< HEAD\nmain conflict content\n=======\ntopic conflict content\n>>>>>>> conflict-topic\n",
		);
		const unmergedEntries = git(linkedWorktree, "ls-files", "--unmerged", "--", "conflict.txt").trim().split("\n");
		assert.deepEqual(unmergedEntries.map((entry) => entry.split(/\s+/)[2]), ["1", "2", "3"]);
		assert.ok(unmergedEntries.every((entry) => entry.endsWith("\tconflict.txt")));
		const linkedGitDirectory = git(linkedWorktree, "rev-parse", "--absolute-git-dir").trim();
		const mergeHeadPath = join(linkedGitDirectory, "MERGE_HEAD");
		assert.equal(await readFile(mergeHeadPath, "utf8"), `${topicRevision}\n`);
		assert.deepEqual(await primaryState(), stagedPrimaryState, "the conflict must not change staged primary state");

		const abortCommand = "git merge --abort";
		const abortReceipt = await runUserShell(
			abortCommand,
			linkedWorktree,
			"linked-worktree-abort",
			new AbortController().signal,
			() => {},
			temporary,
		).done;
		assert.equal(abortReceipt.command, abortCommand);
		assert.equal(abortReceipt.cwd, linkedWorktree);
		assert.equal(abortReceipt.exitCode, 0);
		assert.equal(abortReceipt.signal, null);
		assert.equal(abortReceipt.aborted, false);
		assert.equal(abortReceipt.infrastructureError, undefined);
		assert.equal(git(linkedWorktree, "status", "--porcelain=v1", "--untracked-files=no"), "");
		assert.equal(git(linkedWorktree, "ls-files", "--unmerged"), "");
		assert.equal(await readFile(join(linkedWorktree, "conflict.txt"), "utf8"), "main conflict content\n");
		await assert.rejects(readFile(mergeHeadPath, "utf8"), { code: "ENOENT" });
		assert.deepEqual(await primaryState(), stagedPrimaryState, "aborting the linked conflict must preserve staged primary state");
	} finally {
		try {
			if (linkedWorktreeAdded) git(repository, "worktree", "remove", "--force", linkedWorktree);
		} finally {
			restoreEnvironment();
			await rm(temporary, { recursive: true, force: true });
		}
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
