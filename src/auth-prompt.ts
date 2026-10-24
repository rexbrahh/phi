import { Input, Key, matchesKey, Text, TuiMainScreen, type Terminal } from "@earendil-works/pi-tui";

const TERMINATION_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";

export async function promptForPhiApiKey(
	terminal: Terminal,
	signals: {
		on(signal: NodeJS.Signals, listener: () => void): unknown;
		off(signal: NodeJS.Signals, listener: () => void): unknown;
	} = process,
): Promise<string | undefined> {
	const tui = new TuiMainScreen(terminal);
	const prompt = new Text("Phi API key\nInput is hidden. Type or paste a key, then press Enter to submit. Esc or Ctrl+C cancels.");
	const feedback = new Text("");
	const input = new Input();
	const registeredSignals: Array<[NodeJS.Signals, () => void]> = [];
	let removeInputListener: (() => void) | undefined;
	let settled = false;
	let resolvePrompt!: (value: string | undefined) => void;
	let rejectPrompt!: (error: Error) => void;
	const result = new Promise<string | undefined>((resolve, reject) => {
		resolvePrompt = resolve;
		rejectPrompt = reject;
	});

	const complete = (value: string | undefined): void => {
		if (settled) return;
		settled = true;
		resolvePrompt(value);
	};
	const fail = (): void => {
		if (settled) return;
		settled = true;
		rejectPrompt(new Error("The hidden API key prompt could not be updated."));
	};
	const showInvalidInput = (): void => {
		feedback.setText("Enter a non-empty, single-line API key.");
		try {
			tui.renderNow(true);
		} catch {
			fail();
		}
	};

	input.onEscape = () => complete(undefined);
	input.onSubmit = (value) => {
		const key = value.trim();
		if (!key || /[\r\n]/u.test(value)) {
			showInvalidInput();
			return;
		}
		complete(key);
	};

	tui.addChild(prompt);
	tui.addChild(feedback);
	try {
		// Input.render() exposes its value, so only static Text components enter the TUI.
		removeInputListener = tui.addInputListener((data) => {
			if (settled) return { consume: true };
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
				complete(undefined);
				return { consume: true };
			}
			if (data.startsWith(BRACKETED_PASTE_START) && data.endsWith(BRACKETED_PASTE_END)) {
				const pastedText = data.slice(BRACKETED_PASTE_START.length, -BRACKETED_PASTE_END.length).trim();
				if (/[\r\n]/u.test(pastedText)) {
					showInvalidInput();
					return { consume: true };
				}
			}
			try {
				input.handleInput(data);
			} catch {
				fail();
			}
			return { consume: true };
		});

		for (const signal of TERMINATION_SIGNALS) {
			const listener = (): void => complete(undefined);
			signals.on(signal, listener);
			registeredSignals.push([signal, listener]);
		}

		tui.start();
		tui.renderNow(true);
		return await result;
	} finally {
		let cleanupError: unknown;
		try {
			removeInputListener?.();
		} catch (error) {
			cleanupError = error;
		}
		for (const [signal, listener] of registeredSignals) {
			try {
				signals.off(signal, listener);
			} catch (error) {
				cleanupError ??= error;
			}
		}
		input.setValue("");
		try {
			tui.stop();
		} catch (error) {
			try {
				terminal.stop();
			} catch {
				// Preserve the original stop error after attempting terminal restoration.
			}
			cleanupError ??= error;
		}
		if (cleanupError) throw cleanupError;
	}
}
