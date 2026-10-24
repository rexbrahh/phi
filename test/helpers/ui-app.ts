import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { parseArgs } from "../../src/config.js";
import type { AppDependencies } from "../../src/ui/app.js";
import type { FakeQueryHarness } from "./fake-query.js";
import { FakeSignals, FakeTerminal } from "./terminal.js";

const uiHome = mkdtempSync(join(tmpdir(), "phi-ui-home-"));

export const uiEnvironment: NodeJS.ProcessEnv = {
	...process.env,
	PHI_HOME: uiHome,
	CLAUDE_CONFIG_DIR: join(uiHome, "legacy-config"),
	CLAUDE_CODE_PLUGIN_CACHE_DIR: join(uiHome, "legacy-plugin-cache"),
};

export function testLaunch(argv: string[] = []) {
	return parseArgs(argv, uiEnvironment);
}

export function appDependencies(
	fake: FakeQueryHarness,
	terminal: FakeTerminal,
	additional: Partial<AppDependencies> = {},
): Partial<AppDependencies> {
	return {
		environment: uiEnvironment,
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
