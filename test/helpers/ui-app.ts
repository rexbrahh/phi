import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AppDependencies } from "../../src/ui/app.js";
import type { FakeQueryHarness } from "./fake-query.js";
import { FakeSignals, FakeTerminal } from "./terminal.js";

export function appDependencies(
	fake: FakeQueryHarness,
	terminal: FakeTerminal,
	additional: Partial<AppDependencies> = {},
): Partial<AppDependencies> {
	return {
		createQuery: fake.createQuery,
		terminal,
		readClipboardImage: async () => null,
		copyText: async () => undefined,
		isInteractive: () => true,
		signals: new FakeSignals(),
		suspendProcess: () => undefined,
		...additional,
	};
}

export async function waitFor(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!condition()) {
		if (Date.now() >= deadline) throw new Error("Timed out while waiting for the app condition.");
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
}

export function historyMessage(uuid: string, text: string): SessionMessage {
	return {
		type: "assistant",
		uuid,
		session_id: "test-session",
		message: { role: "assistant", content: [{ type: "text", text }] },
		parent_tool_use_id: null,
		parent_agent_id: null,
	};
}
