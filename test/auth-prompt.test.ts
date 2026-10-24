import assert from "node:assert/strict";
import test from "node:test";
import { promptForPhiApiKey } from "../src/auth-prompt.js";
import { FakeTerminal } from "./helpers/terminal.js";

class FakeSignals {
	private readonly listeners = new Map<NodeJS.Signals, Set<() => void>>();

	on(signal: NodeJS.Signals, listener: () => void): unknown {
		const listeners = this.listeners.get(signal) ?? new Set<() => void>();
		listeners.add(listener);
		this.listeners.set(signal, listeners);
		return this;
	}

	off(signal: NodeJS.Signals, listener: () => void): unknown {
		this.listeners.get(signal)?.delete(listener);
		return this;
	}

	emit(signal: NodeJS.Signals): void {
		for (const listener of this.listeners.get(signal) ?? []) listener();
	}

	get listenerCount(): number {
		return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0);
	}
}

async function waitForHiddenPrompt(terminal: FakeTerminal): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!terminal.output.includes("Input is hidden")) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for the hidden API key prompt.");
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
}

async function startPrompt(terminal: FakeTerminal, signals = new FakeSignals()) {
	const result = promptForPhiApiKey(terminal, signals);
	await waitForHiddenPrompt(terminal);
	return { result, signals };
}

test("typed API key is returned only after Enter and never reaches terminal writes", async () => {
	const terminal = new FakeTerminal();
	const { result } = await startPrompt(terminal);
	const secret = "phi_test_typed_key";
	let settled = false;
	void result.then(() => { settled = true; });

	terminal.input(secret);
	await Promise.resolve();
	assert.equal(settled, false);
	assert.equal(terminal.output.includes(secret), false);

	terminal.input("\r");
	assert.equal(await result, secret);
	assert.equal(terminal.output.includes(secret), false);
	assert.equal(terminal.stopCalls, 1);
});

test("bracketed paste remains hidden without output proportional to key length", async () => {
	const terminal = new FakeTerminal();
	const { result } = await startPrompt(terminal);
	const secret = `phi_test_paste_${"x".repeat(16_384)}`;

	terminal.input(`\u001b[200~${secret}\u001b[201~`);
	assert.equal(terminal.output.includes(secret), false);
	assert.ok(terminal.output.length < 4_096);

	terminal.input("\r");
	assert.equal(await result, secret);
	assert.equal(terminal.output.includes(secret), false);
});

test("multiline bracketed paste is rejected before flattening and can be corrected", async () => {
	const terminal = new FakeTerminal();
	const { result } = await startPrompt(terminal);
	const firstLine = "phi_test_multiline_first_secret";
	const secondLine = "phi_test_multiline_second_secret";
	let settled = false;
	void result.then(() => { settled = true; });

	terminal.input(`\u001b[200~${firstLine}\n${secondLine}\u001b[201~`);
	await Promise.resolve();
	assert.equal(settled, false);
	assert.ok(terminal.output.includes("Enter a non-empty, single-line API key."));
	assert.equal(terminal.output.includes(firstLine), false);
	assert.equal(terminal.output.includes(secondLine), false);

	terminal.input("\r");
	await Promise.resolve();
	assert.equal(settled, false);

	const corrected = "phi_test_corrected_key";
	terminal.input(corrected);
	terminal.input("\r");
	assert.equal(await result, corrected);
	assert.equal(terminal.output.includes(firstLine), false);
	assert.equal(terminal.output.includes(secondLine), false);
	assert.equal(terminal.output.includes(corrected), false);
});

test("Escape and Ctrl+C cancel without rendering the partial key", async () => {
	for (const cancelKey of ["\u001b", "\u0003"]) {
		const terminal = new FakeTerminal();
		const { result } = await startPrompt(terminal);
		const partialKey = "phi_test_partial_key";

		terminal.input(partialKey);
		terminal.input(cancelKey);
		assert.equal(await result, undefined);
		assert.equal(terminal.output.includes(partialKey), false);
		assert.equal(terminal.stopCalls, 1);
	}
});

test("termination signal cancels and unregisters every signal listener", async () => {
	const terminal = new FakeTerminal();
	const signals = new FakeSignals();
	const { result } = await startPrompt(terminal, signals);
	assert.ok(signals.listenerCount > 0);
	const partialKey = "phi_test_signal_partial";
	terminal.input(partialKey);

	signals.emit("SIGTERM");
	assert.equal(await result, undefined);
	assert.equal(terminal.output.includes(partialKey), false);
	assert.equal(signals.listenerCount, 0);
	assert.equal(terminal.stopCalls, 1);
});

test("empty and whitespace-only submissions stay hidden in the prompt", async () => {
	const terminal = new FakeTerminal();
	const { result } = await startPrompt(terminal);
	let settled = false;
	void result.then(() => { settled = true; });

	terminal.input("   ");
	terminal.input("\r");
	assert.equal(settled, false);
	assert.ok(terminal.output.includes("Enter a non-empty, single-line API key."));

	terminal.input("\u001b[200~ \n \u001b[201~");
	terminal.input("\r");
	assert.equal(settled, false);
	assert.equal(terminal.output.includes("\u001b[200~"), false);

	const secret = "phi_test_trimmed_key";
	terminal.input(`  ${secret}  `);
	terminal.input("\r");
	assert.equal(await result, secret);
	assert.equal(terminal.output.includes(secret), false);
});

test("render failure restores the terminal and unregisters input and signals", async () => {
	class RenderFailureTerminal extends FakeTerminal {
		override write(data: string): void {
			if (data.includes("Input is hidden")) throw new Error("synthetic render failure");
			super.write(data);
		}
	}

	const terminal = new RenderFailureTerminal();
	const signals = new FakeSignals();
	const result = promptForPhiApiKey(terminal, signals);

	await assert.rejects(result, /synthetic render failure/u);
	assert.equal(terminal.startCalls, 1);
	assert.equal(terminal.stopCalls, 1);
	assert.equal(signals.listenerCount, 0);
	assert.equal(terminal.output.includes("phi_test"), false);
});
