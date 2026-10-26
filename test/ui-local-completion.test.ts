import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CombinedAutocompleteProvider, type SlashCommand } from "@earendil-works/pi-tui";
import { PhiAutocompleteProvider, localAutocompleteCommands } from "../src/ui/app-command-palette.js";
import { AppController } from "../src/ui/app.js";
import { FakeQueryHarness } from "./helpers/fake-query.js";
import { FakeTerminal } from "./helpers/terminal.js";
import { appDependencies, testLaunch, waitFor } from "./helpers/ui-app.js";

function provider(commands: SlashCommand[] = localAutocompleteCommands(), cwd = process.cwd(), fdPath?: string) {
	return new PhiAutocompleteProvider(commands, cwd, fdPath);
}

function suggest(combined: CombinedAutocompleteProvider, line: string) {
	return combined.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
}

test("Tab completes a pasted local subcommand without sending it to the SDK", async () => {
	const terminal = new FakeTerminal();
	const fake = new FakeQueryHarness();
	const controller = new AppController(testLaunch(), appDependencies(fake, terminal));
	const running = controller.run();
	try {
		await waitFor(() => controller.ready !== undefined);
		terminal.input("\u001b[200~/phi det\u001b[201~");
		terminal.input("\t");
		await waitFor(() => controller.views.editor.getText() === "/phi details");
		assert.equal(fake.receivedMessages.length, 0);
		terminal.input("\r");
		await waitFor(() => controller.views.transcript.toolDetailsVisible);
		assert.equal(fake.receivedMessages.length, 0);
	} finally { await controller.close(0); await running; }
});

test("local completion resolves /phi subcommands and preserves descriptions", async () => {
	const combined = provider();
	const namespace = await suggest(combined, "/ph");
	assert.deepEqual(namespace?.items.map((item) => item.value), ["phi"]);

	const subcommand = await suggest(combined, "/phi ses");
	assert.equal(subcommand?.items[0]?.value, "sessions");
	assert.equal(subcommand?.items[0]?.description, "Find and resume a saved session");
	assert.equal(combined.applyCompletion(["/phi ses"], 0, 8, subcommand!.items[0]!, subcommand!.prefix).lines[0], "/phi sessions");

	const localEntries = await suggest(combined, "/phi ");
	assert.ok(localEntries?.items.some((item) => item.value === "workflow-size"));
});

test("local argument controls have hints and do not replace started arguments", async () => {
	const combined = provider();
	for (const [prefix, value, description] of [
		["re", "resume", "<id> — Resume an SDK session"],
		["att", "attach", "<path> — Attach an image"],
		["sen", "send", "<text> — Submit literal text"],
	]) {
		const suggestions = await suggest(combined, `/phi ${prefix}`);
		assert.equal(suggestions?.items.find((item) => item.value === value)?.description, description);
	}
	assert.equal(await suggest(combined, "/phi resume <id>"), null);
});

test("short aliases are unique and native commands plus @file completion remain available", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "phi-local-completion-"));
	const fdPath = join(cwd, "fd");
	try {
		await writeFile(join(cwd, "localtemp.md"), "completion fixture");
		await writeFile(fdPath, "#!/bin/sh\nprintf 'localtemp.md\\n'\n");
		await chmod(fdPath, 0o755);
		const native: SlashCommand = { name: "sdk-command", description: "Native SDK command" };
		const combined = provider([native, ...localAutocompleteCommands()], cwd, fdPath);

		for (const [line, value] of [["/mo", "model"], ["/ef", "effort"]]) {
			const completion = await suggest(combined, line);
			assert.deepEqual(completion?.items.map((item) => item.value), [value]);
		}
		assert.deepEqual((await suggest(combined, "/sdk"))?.items.map((item) => item.value), ["sdk-command"]);
		assert.ok((await suggest(combined, "@localtemp"))?.items.some((item) => item.label === "localtemp.md"));
		const fileArgument = "/phi attach localt";
		const files = await combined.getSuggestions([fileArgument], 0, fileArgument.length, {
			force: true, signal: new AbortController().signal,
		});
		assert.ok(files?.items.some((item) => item.label === "localtemp.md"), "Tab must still complete file arguments");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
