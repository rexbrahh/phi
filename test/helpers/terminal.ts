import type { ProgramStatus, Terminal } from "@earendil-works/pi-tui";

export class FakeTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = false;
	output = "";
	startCalls = 0;
	stopCalls = 0;
	programStatus: ProgramStatus | undefined;
	progress = false;

	private inputHandler: ((data: string) => void) | undefined;
	private resizeHandler: (() => void) | undefined;

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.startCalls += 1;
		this.inputHandler = onInput;
		this.resizeHandler = onResize;
	}

	stop(): void {
		this.stopCalls += 1;
		this.inputHandler = undefined;
		this.resizeHandler = undefined;
	}

	drainInput(): Promise<void> {
		return Promise.resolve();
	}

	write(data: string): void {
		this.output += data;
	}

	moveBy(lines: number): void {
		this.write(`move:${lines}`);
	}

	hideCursor(): void {
		this.write("hide-cursor");
	}

	showCursor(): void {
		this.write("show-cursor");
	}

	clearLine(): void {
		this.write("clear-line");
	}

	clearFromCursor(): void {
		this.write("clear-from-cursor");
	}

	clearScreen(): void {
		this.write("clear-screen");
	}

	setTitle(title: string): void {
		this.write(`title:${title}`);
	}

	setProgress(active: boolean): void {
		this.progress = active;
	}

	setProgramStatus(status: ProgramStatus): void {
		this.programStatus = status;
	}

	input(data: string): void {
		this.inputHandler?.(data);
	}

	resize(columns: number, rows: number): void {
		this.columns = columns;
		this.rows = rows;
		this.resizeHandler?.();
	}
}

export class FakeSignals {
	private readonly listeners = new Map<string, Set<() => void>>();

	on(signal: string, listener: () => void): void {
		const listeners = this.listeners.get(signal) ?? new Set<() => void>();
		listeners.add(listener);
		this.listeners.set(signal, listeners);
	}

	off(signal: string, listener: () => void): void {
		this.listeners.get(signal)?.delete(listener);
	}

	emit(signal: string): void {
		for (const listener of this.listeners.get(signal) ?? []) listener();
	}
}
