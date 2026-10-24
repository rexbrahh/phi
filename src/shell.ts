import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, lstat, mkdir, stat } from "node:fs/promises";
import { createWriteStream, type WriteStream } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";

const PREVIEW_LIMIT = 8_192;
const STOP_ESCALATION_MS = 2_000;
const INFRASTRUCTURE_ERROR_LIMIT = 2_048;

export interface ShellPreview {
	stdout: string;
	stderr: string;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
}

export interface ShellReceipt {
	jobId: string;
	sessionId: string;
	command: string;
	cwd: string;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	aborted: boolean;
	infrastructureError?: string;
	outputFiles: {
		stdout?: string;
		stderr?: string;
	};
}

export interface ShellJob {
	readonly jobId: string;
	readonly done: Promise<ShellReceipt>;
}

interface PreviewBuffer {
	value: string;
	truncated: boolean;
}

interface OutputSink {
	stream: WriteStream;
	failed: boolean;
	failureReported: boolean;
	failure?: unknown;
	onFailure?: (error: unknown) => void;
	readable?: Readable;
	finish?: Promise<void>;
}

interface ProcessExit {
	exitCode: number | null;
	signal: NodeJS.Signals | null;
}

let activeJobId: string | undefined;

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function appendPreview(buffer: PreviewBuffer, text: string): boolean {
	if (text.length === 0) return false;
	const remaining = PREVIEW_LIMIT - buffer.value.length;
	if (remaining <= 0) {
		buffer.truncated = true;
		return false;
	}
	if (text.length <= remaining) {
		buffer.value += text;
		return true;
	}

	let end = remaining;
	const lastUnit = text.charCodeAt(end - 1);
	const nextUnit = text.charCodeAt(end);
	if (lastUnit >= 0xd800 && lastUnit <= 0xdbff && nextUnit >= 0xdc00 && nextUnit <= 0xdfff) end -= 1;
	buffer.value += text.slice(0, end);
	buffer.truncated = true;
	return end > 0;
}

function safeSessionDirectory(sessionId: string): string {
	if (!/^[A-Za-z0-9._-]+$/.test(sessionId) || sessionId === "." || sessionId === "..") {
		throw new TypeError("sessionId must be a safe path segment");
	}
	const stateHome = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
	return join(stateHome, "phi", sessionId, "shell");
}

async function ensurePrivateDirectory(path: string): Promise<void> {
	let metadata;
	try {
		metadata = await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		await mkdir(path, { recursive: true, mode: 0o700 });
		metadata = await lstat(path);
	}
	if (metadata.isSymbolicLink()) throw new Error(`private shell output directory is a symbolic link: ${path}`);
	if (!metadata.isDirectory()) throw new Error(`private shell output path is not a directory: ${path}`);
	await chmod(path, 0o700);
}

async function openOutput(path: string): Promise<OutputSink> {
	const stream = createWriteStream(path, { flags: "wx", mode: 0o600 });
	const sink: OutputSink = { stream, failed: false, failureReported: false };
	await new Promise<void>((resolve, reject) => {
		let opened = false;
		stream.on("error", (error) => {
			sink.failed = true;
			sink.failure = error;
			sink.onFailure?.(error);
			if (!opened) reject(error);
		});
		stream.once("open", () => {
			opened = true;
			resolve();
		});
	});
	try {
		await chmod(path, 0o600);
	} catch (error) {
		stream.destroy();
		throw error;
	}
	return sink;
}

async function outputFileExists(path: string | undefined): Promise<boolean> {
	if (path === undefined) return false;
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals, addError: (error: unknown) => void): void {
	if (child.pid === undefined) return;
	if (process.platform === "win32") {
		try {
			child.kill(signal);
		} catch (error) {
			addError(error);
		}
		return;
	}
	try {
		process.kill(-child.pid, signal);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") addError(error);
	}
}

function processGroupExists(pid: number): boolean {
	if (process.platform === "win32") return false;
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function wait(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForProcessGroupExit(pid: number): Promise<void> {
	while (processGroupExists(pid)) await wait(50);
}

async function terminateProcessGroup(
	child: ChildProcess,
	addError: (error: unknown) => void,
): Promise<void> {
	const pid = child.pid;
	if (pid === undefined || process.platform === "win32") {
		signalGroup(child, "SIGTERM", addError);
		return;
	}

	signalGroup(child, "SIGTERM", addError);
	const deadline = Date.now() + STOP_ESCALATION_MS;
	while (Date.now() < deadline && processGroupExists(pid)) {
		await wait(Math.min(50, deadline - Date.now()));
	}
	if (processGroupExists(pid)) signalGroup(child, "SIGKILL", addError);
}

async function runJob(
	jobId: string,
	command: string,
	cwd: string,
	sessionId: string,
	signal: AbortSignal,
	onUpdate: (preview: ShellPreview) => void,
	shellPath: string,
	environment: NodeJS.ProcessEnv,
): Promise<ShellReceipt> {
	let infrastructureError: string | undefined;
	let aborted = signal.aborted;
	let child: ChildProcess | undefined;
	let stopPromise: Promise<void> | undefined;
	let processExit: ProcessExit = { exitCode: null, signal: null };
	const outputFiles: { stdout?: OutputSink; stderr?: OutputSink } = {};
	const outputPaths: { stdout?: string; stderr?: string } = {};
	const stdoutPreview: PreviewBuffer = { value: "", truncated: false };
	const stderrPreview: PreviewBuffer = { value: "", truncated: false };
	const stdoutDecoder = new StringDecoder("utf8");
	const stderrDecoder = new StringDecoder("utf8");

	const addInfrastructureError = (error: unknown): void => {
		const detail = formatError(error).slice(0, INFRASTRUCTURE_ERROR_LIMIT);
		infrastructureError = infrastructureError
			? `${infrastructureError}; ${detail}`.slice(0, INFRASTRUCTURE_ERROR_LIMIT)
			: detail;
	};

	const snapshotPreview = (): ShellPreview => ({
		stdout: stdoutPreview.value,
		stderr: stderrPreview.value,
		stdoutTruncated: stdoutPreview.truncated,
		stderrTruncated: stderrPreview.truncated,
	});

	const notify = (): void => {
		try {
			onUpdate(snapshotPreview());
		} catch (error) {
			addInfrastructureError(`shell preview update failed: ${formatError(error)}`);
		}
	};

	const onAbort = (): void => {
		if (aborted) return;
		aborted = true;
		if (child) stopPromise = terminateProcessGroup(child, addInfrastructureError);
	};

	if (!signal.aborted) signal.addEventListener("abort", onAbort, { once: true });

	const stateDirectory = safeSessionDirectory(sessionId);
	try {
		const phiDirectory = join(stateDirectory, "..", "..");
		const sessionDirectory = join(stateDirectory, "..");
		await ensurePrivateDirectory(phiDirectory);
		await ensurePrivateDirectory(sessionDirectory);
		await ensurePrivateDirectory(stateDirectory);
	} catch (error) {
		addInfrastructureError(`cannot create private shell output directory: ${formatError(error)}`);
	}

	if (!infrastructureError) {
		const stdoutPath = join(stateDirectory, `stdout-${jobId}.log`);
		const stderrPath = join(stateDirectory, `stderr-${jobId}.log`);
		outputPaths.stdout = stdoutPath;
		outputPaths.stderr = stderrPath;
		const [stdoutResult, stderrResult] = await Promise.allSettled([openOutput(stdoutPath), openOutput(stderrPath)]);
		if (stdoutResult.status === "fulfilled") outputFiles.stdout = stdoutResult.value;
		else addInfrastructureError(`cannot create stdout output file: ${formatError(stdoutResult.reason)}`);
		if (stderrResult.status === "fulfilled") outputFiles.stderr = stderrResult.value;
		else addInfrastructureError(`cannot create stderr output file: ${formatError(stderrResult.reason)}`);
	}

	const markOutputFailure = (channel: "stdout" | "stderr", sink: OutputSink, error: unknown): void => {
		if (sink.failureReported) return;
		sink.failed = true;
		sink.failureReported = true;
		addInfrastructureError(`cannot write ${channel} output: ${formatError(error)}`);
		sink.readable?.resume();
	};

	const writeChunk = (channel: "stdout" | "stderr", chunk: Buffer): void => {
		const decoder = channel === "stdout" ? stdoutDecoder : stderrDecoder;
		const preview = channel === "stdout" ? stdoutPreview : stderrPreview;
		if (appendPreview(preview, decoder.write(chunk))) notify();

		const sink = outputFiles[channel];
		const readable = channel === "stdout" ? child?.stdout : child?.stderr;
		if (!sink || sink.failed || !readable) return;
		sink.readable = readable;
		try {
			if (!sink.stream.write(chunk)) {
				readable.pause();
				sink.stream.once("drain", () => readable.resume());
			}
		} catch (error) {
			markOutputFailure(channel, sink, error);
			sink.stream.destroy();
			readable.resume();
		}
	};

	for (const channel of ["stdout", "stderr"] as const) {
		const sink = outputFiles[channel];
		if (sink) {
			sink.onFailure = (error) => markOutputFailure(channel, sink, error);
			if (sink.failure !== undefined) sink.onFailure(sink.failure);
		}
	}

	let spawnFailed = false;
	if (!aborted) {
		try {
			child = spawn(shellPath, ["-lc", command], {
				cwd,
				detached: process.platform !== "win32",
				env: environment,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
			addInfrastructureError(`cannot start user shell: ${formatError(error)}`);
		}
	}

	if (child) {
		child.on("error", (error) => {
			if (child?.pid === undefined) spawnFailed = true;
			addInfrastructureError(`user shell process failed: ${formatError(error)}`);
		});
		child.stdout?.on("data", (chunk: Buffer) => writeChunk("stdout", chunk));
		child.stderr?.on("data", (chunk: Buffer) => writeChunk("stderr", chunk));

		const close = new Promise<ProcessExit>((resolve) => {
			child?.once("close", (exitCode, exitSignal) => {
				resolve({ exitCode, signal: exitSignal });
			});
		});
		processExit = await close;
		if (child.pid !== undefined && process.platform !== "win32") await waitForProcessGroupExit(child.pid);
		if (stopPromise) await stopPromise;
	}

	if (child?.stdout) {
		const tail = stdoutDecoder.end();
		if (appendPreview(stdoutPreview, tail)) notify();
	}
	if (child?.stderr) {
		const tail = stderrDecoder.end();
		if (appendPreview(stderrPreview, tail)) notify();
	}

	const finishSink = (sink: OutputSink): Promise<void> => {
		if (sink.finish) return sink.finish;
		sink.finish = new Promise<void>((resolve) => {
			if (sink.stream.closed) {
				resolve();
				return;
			}
			sink.stream.once("close", resolve);
			if (sink.failed) sink.stream.destroy();
			else sink.stream.end();
		});
		return sink.finish;
	};

	await Promise.all(Object.values(outputFiles).filter((sink): sink is OutputSink => sink !== undefined).map(finishSink));
	signal.removeEventListener("abort", onAbort);

	const existingOutputPaths: ShellReceipt["outputFiles"] = {};
	if (await outputFileExists(outputPaths.stdout)) existingOutputPaths.stdout = outputPaths.stdout;
	if (await outputFileExists(outputPaths.stderr)) existingOutputPaths.stderr = outputPaths.stderr;

	return {
		jobId,
		sessionId,
		command,
		cwd,
		exitCode: aborted || spawnFailed ? null : processExit.exitCode,
		signal: aborted ? processExit.signal ?? (child ? "SIGTERM" : null) : processExit.signal,
		aborted,
		...(infrastructureError ? { infrastructureError } : {}),
		outputFiles: existingOutputPaths,
	};
}

export function runUserShell(
	command: string,
	cwd: string,
	sessionId: string,
	signal: AbortSignal,
	onUpdate: (preview: ShellPreview) => void,
): ShellJob {
	if (activeJobId !== undefined) throw new Error("Only one local shell job may run at a time");
	safeSessionDirectory(sessionId);
	const jobId = randomUUID();
	const environment = { ...process.env };
	const shellPath = environment.SHELL || "/bin/sh";
	activeJobId = jobId;
	const done = runJob(jobId, command, cwd, sessionId, signal, onUpdate, shellPath, environment)
		.catch((error: unknown) => ({
			jobId,
			sessionId,
			command,
			cwd,
			exitCode: null,
			signal: null,
			aborted: signal.aborted,
			infrastructureError: formatError(error),
			outputFiles: {},
		}))
		.finally(() => {
			if (activeJobId === jobId) activeJobId = undefined;
		});
	return { jobId, done };
}
