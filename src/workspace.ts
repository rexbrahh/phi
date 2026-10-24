import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";

const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

export interface WorktreeInfo {
	path: string;
	head: string;
	branch: string | null;
	detached: boolean;
	bare: boolean;
	locked: boolean;
	lockReason?: string;
	prunable: boolean;
	prunableReason?: string;
}

export type WorkspaceInfo =
	| {
			kind: "repository";
			cwd: string;
			root: string;
			branch: string | null;
			detached: boolean;
			dirty: boolean;
			worktrees: WorktreeInfo[];
	  }
	| {
			kind: "not-repository";
			cwd: string;
	  }
	| {
			kind: "error";
			cwd: string;
			error: string;
	  };

interface GitResult {
	stdout: Buffer;
	stderr: Buffer;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	error?: Error & { code?: number | string | null; signal?: NodeJS.Signals | null };
}

function runGit(cwd: string, args: string[]): Promise<GitResult> {
	return new Promise((resolve) => {
		execFile(
			"git",
			["-C", cwd, ...args],
			{
				encoding: "buffer",
					env: {
					...process.env,
					GIT_OPTIONAL_LOCKS: "0",
					GIT_TERMINAL_PROMPT: "0",
				},
				killSignal: "SIGKILL",
				maxBuffer: GIT_MAX_BUFFER_BYTES,
				timeout: GIT_TIMEOUT_MS,
			},
			(error, stdout, stderr) => {
				const output = (value: string | Buffer): Buffer => Buffer.isBuffer(value) ? value : Buffer.from(value);
				const code = error?.code;
				resolve({
					stdout: output(stdout),
					stderr: output(stderr),
					exitCode: typeof code === "number" ? code : error ? null : 0,
					signal: error?.signal ?? null,
					...(error ? { error } : {}),
				});
			},
		);
	});
}

function lineValue(value: Buffer): string {
	const text = value.toString("utf8");
	return text.endsWith("\n") ? text.slice(0, -1).replace(/\r$/, "") : text;
}

function errorMessage(result: GitResult): string {
	const detail = result.stderr.toString("utf8").trim();
	if (detail) return detail;
	if (result.error?.message) return result.error.message;
	if (result.signal) return `git was terminated by ${result.signal}`;
	return `git exited with status ${result.exitCode ?? "unknown"}`;
}

function parseWorktrees(output: Buffer): WorktreeInfo[] {
	const worktrees: WorktreeInfo[] = [];
	let current: Partial<WorktreeInfo> = {};

	function finish(): void {
		if (current.path !== undefined) {
			worktrees.push({
				path: current.path,
				head: current.head ?? "",
				branch: current.branch ?? null,
				detached: current.detached ?? false,
				bare: current.bare ?? false,
				locked: current.locked ?? false,
				...(current.lockReason === undefined ? {} : { lockReason: current.lockReason }),
				prunable: current.prunable ?? false,
				...(current.prunableReason === undefined ? {} : { prunableReason: current.prunableReason }),
			});
		}
		current = {};
	}

	for (const field of output.toString("utf8").split("\0")) {
		if (field === "") {
			finish();
			continue;
		}

		const separator = field.indexOf(" ");
		const key = separator === -1 ? field : field.slice(0, separator);
		const value = separator === -1 ? "" : field.slice(separator + 1);
		switch (key) {
			case "worktree":
				current.path = value;
				break;
			case "HEAD":
				current.head = value;
				break;
			case "branch":
				current.branch = value.startsWith("refs/heads/") ? value.slice("refs/heads/".length) : value;
				break;
			case "detached":
				current.detached = true;
				break;
			case "bare":
				current.bare = true;
				break;
			case "locked":
				current.locked = true;
				if (value) current.lockReason = value;
				break;
			case "prunable":
				current.prunable = true;
				if (value) current.prunableReason = value;
				break;
		}
	}
	finish();
	return worktrees;
}

export async function readWorkspace(cwd: string): Promise<WorkspaceInfo> {
	let directory;
	try {
		directory = await stat(cwd);
	} catch (error) {
		return { kind: "error", cwd, error: error instanceof Error ? error.message : String(error) };
	}
	if (!directory.isDirectory()) {
		return { kind: "error", cwd, error: "The requested cwd is not a directory" };
	}

	const rootResult = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
	if (rootResult.exitCode !== 0) {
		if (rootResult.exitCode === 128 && /not a git repository/i.test(rootResult.stderr.toString("utf8"))) {
			return { kind: "not-repository", cwd };
		}
		return { kind: "error", cwd, error: errorMessage(rootResult) };
	}
	const root = lineValue(rootResult.stdout);

	const [branchResult, statusResult, worktreeResult] = await Promise.all([
		runGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
		runGit(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
		runGit(cwd, ["worktree", "list", "--porcelain", "-z"]),
	]);

	if (branchResult.exitCode !== 0 && branchResult.exitCode !== 1) {
		return { kind: "error", cwd, error: errorMessage(branchResult) };
	}
	if (statusResult.exitCode !== 0) return { kind: "error", cwd, error: errorMessage(statusResult) };
	if (worktreeResult.exitCode !== 0) return { kind: "error", cwd, error: errorMessage(worktreeResult) };

	const detached = branchResult.exitCode === 1;
	return {
		kind: "repository",
		cwd,
		root,
		branch: detached ? null : lineValue(branchResult.stdout),
		detached,
		dirty: statusResult.stdout.length > 0,
		worktrees: parseWorktrees(worktreeResult.stdout),
	};
}
