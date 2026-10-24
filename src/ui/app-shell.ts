import type { ShellJob, ShellPreview, ShellReceipt } from "../shell.js";
import type { AppDependencies } from "./app-types.js";

export interface ShellScreenState {
	mode: boolean;
	cwdSnapshot?: string;
	job?: { jobId: string; command: string; cwd: string };
	preview?: ShellPreview;
}

interface ActiveShellJob {
	controller: AbortController;
	job: ShellJob;
	command: string;
	cwd: string;
	sessionId: string;
	processGeneration: number;
	preview?: ShellPreview;
	done: Promise<void>;
}

export class AppShellController {
	mode = false;
	cwdSnapshot: string | undefined;
	private active: ActiveShellJob | undefined;
	private closed = false;

	constructor(
		private readonly runUserShell: AppDependencies["runUserShell"],
		private readonly onChange: () => void,
		private readonly onNotice: (message: string) => void,
		private readonly onReceipt: (receipt: ShellReceipt, preview: ShellPreview | undefined, command: string, cwd: string, sessionId: string) => void,
		private readonly currentProcessGeneration: () => number,
	) {}

	get running(): boolean {
		return this.active !== undefined;
	}

	enter(cwd: string): void {
		this.mode = true;
		this.cwdSnapshot = cwd;
		this.onNotice(`Shell mode · command cwd is ${cwd}. Press Esc to return to chat.`);
	}

	leave(): void {
		this.mode = false;
		this.cwdSnapshot = undefined;
		this.onChange();
	}

	start(command: string, cwd: string, sessionId: string | undefined): boolean {
		if (this.active) {
			this.onNotice("A local shell job is already running. Your command remains in the composer.");
			return false;
		}
		if (this.closed) {
			this.onNotice("The local shell is closing. Your command remains in the composer.");
			return false;
		}
		if (!sessionId) {
			this.onNotice("The session is not ready. Your shell command remains in the composer.");
			return false;
		}
		const controller = new AbortController();
		const processGeneration = this.currentProcessGeneration();
		let initialPreview: ShellPreview | undefined;
		let jobId: string | undefined;
		try {
			const job = this.runUserShell(command, cwd, sessionId, controller.signal, (preview) => {
				if (!jobId) {
					initialPreview = preview;
					return;
				}
				if (this.active?.job.jobId !== jobId || processGeneration !== this.currentProcessGeneration()) return;
				this.active.preview = preview;
				this.onChange();
			});
			jobId = job.jobId;
			const active: ActiveShellJob = {
				controller,
				job,
				command,
				cwd,
				sessionId,
				processGeneration,
				preview: initialPreview,
				done: Promise.resolve(),
			};
			this.active = active;
			active.done = this.finish(active);
			this.onChange();
			return true;
		} catch (error) {
			this.onNotice(`Could not start the local shell: ${errorText(error)}. Your command remains in the composer.`);
			return false;
		}
	}

	cancel(): void {
		this.active?.controller.abort();
	}

	screenState(): ShellScreenState {
		const active = this.active;
		return {
			mode: this.mode,
			cwdSnapshot: this.cwdSnapshot,
			...(active ? {
				job: { jobId: active.job.jobId, command: active.command, cwd: active.cwd },
				...(active.preview ? { preview: active.preview } : {}),
			} : {}),
		};
	}

	async close(): Promise<void> {
		this.closed = true;
		await this.stop();
	}

	async stop(): Promise<void> {
		const active = this.active;
		active?.controller.abort();
		await active?.done;
	}

	private async finish(active: ActiveShellJob): Promise<void> {
		try {
			const receipt = await active.job.done;
			if (!this.closed && active.processGeneration === this.currentProcessGeneration()) {
				this.onNotice(receipt.aborted
					? "Local shell command stopped."
					: `Local shell command exited ${receipt.exitCode ?? receipt.signal ?? "with an error"}.`);
				this.onReceipt(receipt, active.preview, active.command, active.cwd, active.sessionId);
			}
		} catch (error) {
			if (!this.closed && active.processGeneration === this.currentProcessGeneration()) this.onNotice(`Local shell job failed: ${errorText(error)}`);
		} finally {
			if (this.active === active) this.active = undefined;
			this.onChange();
		}
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
