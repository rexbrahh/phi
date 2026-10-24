import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { readWorkspace } from "../src/workspace.js";

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

async function snapshotTree(root: string): Promise<string[]> {
	const entries: string[] = [];

	async function visit(directory: string): Promise<void> {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			const name = relative(root, path);
			const stats = await lstat(path, { bigint: true });
			const metadata = `${stats.mode}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;

			if (entry.isDirectory()) {
				entries.push(`directory:${name}:${metadata}`);
				await visit(path);
			} else if (entry.isSymbolicLink()) {
				entries.push(`symlink:${name}:${metadata}:${await readlink(path)}`);
			} else {
				entries.push(`file:${name}:${metadata}:${(await readFile(path)).toString("base64")}`);
			}
		}
	}

	await visit(root);
	return entries.sort();
}

test("readWorkspace reports linked worktrees and dirty state without changing files or refs", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "phi workspace "));
	const repository = join(temporary, "main repository");
	const linkedWorktree = join(temporary, "linked worktree");
	await mkdir(repository);

	try {
		git(repository, "init", "-b", "main");
		git(repository, "config", "user.name", "Workspace Test");
		git(repository, "config", "user.email", "workspace-test@example.invalid");
		await writeFile(join(repository, "tracked file.txt"), "committed\n");
		git(repository, "add", "--", "tracked file.txt");
		git(repository, "commit", "-m", "initial commit");
		git(repository, "worktree", "add", "-b", "linked/feature", linkedWorktree);
		await writeFile(join(linkedWorktree, "tracked file.txt"), "modified\n");
		await writeFile(join(linkedWorktree, "untracked file.txt"), "new\n");

		const before = await snapshotTree(temporary);
		const refsBefore = git(repository, "show-ref");
		const info = await readWorkspace(linkedWorktree);

		assert.equal(info.kind, "repository");
		if (info.kind !== "repository") return;
		assert.equal(info.root, await realpath(linkedWorktree));
		assert.equal(info.branch, "linked/feature");
		assert.equal(info.detached, false);
		assert.equal(info.dirty, true);
		assert.deepEqual(
			info.worktrees
				.map(({ path, branch, detached }) => ({ path, branch, detached }))
				.sort((left, right) => left.path.localeCompare(right.path)),
			[
				{ path: await realpath(linkedWorktree), branch: "linked/feature", detached: false },
				{ path: await realpath(repository), branch: "main", detached: false },
			],
		);
		assert.ok(info.worktrees.every((worktree) => worktree.head.length > 0));
		assert.deepEqual(await snapshotTree(temporary), before);
		assert.equal(git(repository, "show-ref"), refsBefore);

		const mainBefore = await snapshotTree(temporary);
		const mainRefsBefore = git(repository, "show-ref");
		const main = await readWorkspace(repository);
		assert.equal(main.kind, "repository");
		if (main.kind !== "repository") return;
		assert.equal(main.root, await realpath(repository));
		assert.equal(main.branch, "main");
		assert.equal(main.dirty, false);
		assert.deepEqual(await snapshotTree(temporary), mainBefore);
		assert.equal(git(repository, "show-ref"), mainRefsBefore);

		git(repository, "checkout", "--detach", "HEAD");
		const detachedBefore = await snapshotTree(temporary);
		const detachedRefsBefore = git(repository, "show-ref");
		const detached = await readWorkspace(repository);
		assert.equal(detached.kind, "repository");
		if (detached.kind !== "repository") return;
		assert.equal(detached.branch, null);
		assert.equal(detached.detached, true);
		assert.deepEqual(await snapshotTree(temporary), detachedBefore);
		assert.equal(git(repository, "show-ref"), detachedRefsBefore);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});

test("readWorkspace distinguishes a non-repository from an unavailable cwd", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "phi workspace errors "));
	const nonRepository = join(temporary, "plain directory");
	const unavailable = join(temporary, "missing directory");
	await mkdir(nonRepository);

	try {
		assert.deepEqual(await readWorkspace(nonRepository), {
			kind: "not-repository",
			cwd: nonRepository,
		});

		const result = await readWorkspace(unavailable);
		assert.equal(result.kind, "error");
		if (result.kind === "error") {
			assert.equal(result.cwd, unavailable);
			assert.match(result.error, /not found|no such file|unavailable/i);
		}
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});

test("readWorkspace ignores inherited Git index and repository-location overrides", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "phi workspace overrides "));
	const repository = join(temporary, "requested repository");
	const alternateRepository = join(temporary, "alternate repository");
	const linkedWorktree = join(temporary, "alternate linked worktree");
	await mkdir(repository);
	await mkdir(alternateRepository);

	try {
		for (const path of [repository, alternateRepository]) {
			git(path, "init", "-b", "main");
			git(path, "config", "user.name", "Workspace Test");
			git(path, "config", "user.email", "workspace-test@example.invalid");
			await writeFile(join(path, "tracked file.txt"), "committed\n");
			git(path, "add", "--", "tracked file.txt");
			git(path, "commit", "-m", "initial commit");
		}
		git(alternateRepository, "worktree", "add", "-b", "linked/feature", linkedWorktree);
		await writeFile(join(linkedWorktree, "tracked file.txt"), "staged in alternate index\n");
		git(linkedWorktree, "add", "--", "tracked file.txt");

		const alternateGitDirectory = git(linkedWorktree, "rev-parse", "--absolute-git-dir");
		const overrides = [
			["GIT_INDEX_FILE", join(alternateGitDirectory, "index")],
			["GIT_DIR", join(alternateRepository, ".git")],
			["GIT_WORK_TREE", alternateRepository],
		] as const;

		for (const [name, value] of overrides) {
			const previous = process.env[name];
			process.env[name] = value;
			try {
				const info = await readWorkspace(repository);
				assert.equal(info.kind, "repository", `${name} must not redirect repository inspection`);
				if (info.kind !== "repository") continue;
				assert.equal(info.root, await realpath(repository), `${name} must not redirect the repository root`);
				assert.equal(info.branch, "main");
				assert.equal(info.dirty, false, `${name} must not redirect index-based status`);
				assert.deepEqual(info.worktrees.map((worktree) => worktree.path), [await realpath(repository)]);
			} finally {
				if (previous === undefined) delete process.env[name];
				else process.env[name] = previous;
			}
		}
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});
