import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { environmentForLocalGit } from "./workspace.js";

const TERMINATION_GRACE_MS = 1_000;
const PROCESS_GROUP_EXIT_TIMEOUT_MS = 2_000;
const PROCESS_GROUP_POLL_MS = 25;
const EDITOR_SHELL_COMMAND = [
	"set -m",
	"printf 'ready\\n' >&3",
	"IFS= read -r launch <&4 || exit 1",
	'[ "$launch" = launch ] || exit 1',
	"phi_prompt_editor_command=$1",
	"phi_prompt_editor_file=$2",
	"phi_prompt_editor_job() {",
	"  IFS= read -r start <&4 || exit 1",
	"  exec 4<&-",
	'  [ "$start" = start ] || exit 1',
	'  eval "exec $phi_prompt_editor_command \\"\\$phi_prompt_editor_file\\""',
	"}",
	"phi_prompt_editor_job 3>&- &",
	"editor_group=$!",
	"printf 'group:%s\\n' \"$editor_group\" >&3",
	"exec 3>&- 4<&-",
	"if [ -t 0 ]; then fg %1; else wait \"$editor_group\"; fi",
	"exit $?",
].join("\n");

interface EditorExit {
	code: number | null;
	signal: NodeJS.Signals | null;
}

export async function editPrompt(
	text: string,
	cwd: string,
	environment: NodeJS.ProcessEnv,
	signal: AbortSignal,
): Promise<string> {
	if (signal.aborted) throw new Error("Prompt editor aborted", { cause: signal.reason });

	const temporaryRoot = resolve(environment.TMPDIR || tmpdir());
	let directory: string | undefined;
	let editorStarted = false;
	let preserveDraft = false;
	try {
		directory = await mkdtemp(join(temporaryRoot, "phi-prompt-editor-"));
		const file = join(directory, "prompt");
		await writeFile(file, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
		if (signal.aborted) throw new Error("Prompt editor aborted", { cause: signal.reason });

		const command = environment.VISUAL?.trim() || environment.EDITOR?.trim() || "vi";
		const exit = await runEditor(command, file, cwd, environment, signal, () => {
			editorStarted = true;
		});
		if (signal.aborted) throw new Error("Prompt editor aborted", { cause: signal.reason });
		if (exit.code !== 0) {
			preserveDraft = true;
			const status = exit.code === null ? `signal ${exit.signal}` : `status ${exit.code}`;
			throw new Error(`Prompt editor exited with ${status}; draft retained at ${file}`);
		}

		const edited = await readFile(file, "utf8");
		if (signal.aborted) throw new Error("Prompt editor aborted", { cause: signal.reason });
		await rm(directory, { recursive: true, force: true });
		directory = undefined;
		return edited;
	} catch (error) {
		if (editorStarted && signal.aborted && directory) {
			preserveDraft = true;
			throw new Error(`${error instanceof Error ? error.message : String(error)}; draft retained at ${join(directory, "prompt")}`, { cause: error });
		}
		if (directory && !preserveDraft) await rm(directory, { recursive: true, force: true });
		throw error;
	}
}

function runEditor(
	command: string,
	file: string,
	cwd: string,
	environment: NodeJS.ProcessEnv,
	signal: AbortSignal,
	onStarted: () => void,
): Promise<EditorExit> {
	return new Promise((resolveExit, reject) => {
		// Bash also supports process groups when no controlling terminal is available.
		const child = spawn("/bin/bash", ["-c", EDITOR_SHELL_COMMAND, "phi-prompt-editor", command, file], {
			cwd,
			env: environmentForLocalGit(environment),
			stdio: ["inherit", "inherit", "inherit", "pipe", "pipe"],
		});
		const protocol = child.stdio[3];
		const launchControl = child.stdio[4];
		if (!(protocol instanceof Readable) || !(launchControl instanceof Writable)) {
			child.kill("SIGKILL");
			reject(new Error("Unable to create prompt editor control pipes"));
			return;
		}
		protocol.setEncoding("utf8");
		let spawnError: Error | undefined;
		let protocolError: Error | undefined;
		let abortError: Error | undefined;
		let killTimer: NodeJS.Timeout | undefined;
		let editorGroup: number | undefined;
		let launchSent = false;
		let protocolBuffer = "";

		const closeLaunchControl = () => {
			if (!launchControl.destroyed && !launchControl.writableEnded) launchControl.end();
		};
		const signalEditorGroup = (pid: number, sentSignal: NodeJS.Signals): boolean => {
			try {
				process.kill(-pid, sentSignal);
				return true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
				throw error;
			}
		};
		const terminateEditorGroup = (pid: number) => {
			if (killTimer) return;
			try {
				if (!signalEditorGroup(pid, "SIGTERM")) return;
			} catch (error) {
				protocolError = new Error("Could not stop the prompt editor process group", { cause: error });
				child.kill("SIGTERM");
				return;
			}
			killTimer = setTimeout(() => {
				try {
					if (processGroupExists(pid)) signalEditorGroup(pid, "SIGKILL");
				} catch (error) {
					protocolError ??= new Error("Unable to force-stop the prompt editor process group", { cause: error });
				}
			}, TERMINATION_GRACE_MS);
		};

		const cleanup = () => {
			signal.removeEventListener("abort", onAbort);
			if (killTimer) clearTimeout(killTimer);
			protocol.destroy();
			launchControl.destroy();
		};
		const waitForEditorGroupExit = async (pid: number) => {
			const deadline = performance.now() + PROCESS_GROUP_EXIT_TIMEOUT_MS;
			while (processGroupExists(pid)) {
				if (protocolError) throw protocolError;
				// Unreaped zombies can keep a group visible after every member has stopped.
				if (performance.now() >= deadline) throw new Error("Could not confirm prompt editor process group exit");
				await new Promise((resolveWait) => setTimeout(resolveWait, PROCESS_GROUP_POLL_MS));
			}
		};
		const onAbort = () => {
			abortError ??= new Error("Prompt editor aborted", { cause: signal.reason });
			if (editorGroup !== undefined) terminateEditorGroup(editorGroup);
			closeLaunchControl();
		};
		const onProtocolLine = (line: string) => {
			if (line === "ready") {
				if (signal.aborted) {
					onAbort();
					return;
				}
				if (launchSent) {
					protocolError = new Error("Prompt editor sent a duplicate ready message");
					child.kill("SIGTERM");
					return;
				}
				launchSent = true;
				launchControl.write("launch\n");
				return;
			}
			if (line.startsWith("group:")) {
				const pid = Number(line.slice("group:".length));
				if (!Number.isSafeInteger(pid) || pid <= 0 || editorGroup !== undefined) {
					protocolError = new Error("Prompt editor sent an invalid process group");
					closeLaunchControl();
					return;
				}
				editorGroup = pid;
				if (signal.aborted) {
					onAbort();
				} else {
					launchControl.end("start\n");
				}
				return;
			}
			protocolError = new Error("Prompt editor sent an invalid control message");
			if (editorGroup !== undefined) terminateEditorGroup(editorGroup);
			closeLaunchControl();
		};

		protocol.on("data", (chunk: string) => {
			protocolBuffer += chunk;
			let newline = protocolBuffer.indexOf("\n");
			while (newline >= 0) {
				const line = protocolBuffer.slice(0, newline);
				protocolBuffer = protocolBuffer.slice(newline + 1);
				onProtocolLine(line);
				newline = protocolBuffer.indexOf("\n");
			}
		});

		child.once("spawn", () => {
			onStarted();
			if (signal.aborted) onAbort();
		});
		child.once("error", (error) => { spawnError = error; });
		child.once("close", (code, exitSignal) => {
			void (async () => {
				if ((abortError || signal.aborted) && editorGroup !== undefined) await waitForEditorGroupExit(editorGroup);
				cleanup();
				if (spawnError) reject(new Error(`Unable to start prompt editor: ${spawnError.message}`, { cause: spawnError }));
				else if (protocolError) reject(protocolError);
				else if (abortError || signal.aborted) reject(abortError ?? new Error("Prompt editor aborted", { cause: signal.reason }));
				else resolveExit({ code, signal: exitSignal });
			})().catch((error: unknown) => {
				cleanup();
				reject(error);
			});
		});
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
	});
}

function processGroupExists(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return false;
		if (code === "EPERM") return true;
		throw error;
	}
}
