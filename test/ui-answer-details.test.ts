import assert from "node:assert/strict";
import test from "node:test";
import { AppController } from "../src/ui/app.js";
import { FakeQueryHarness } from "./helpers/fake-query.js";
import { FakeTerminal } from "./helpers/terminal.js";
import { appDependencies, testLaunch, waitFor } from "./helpers/ui-app.js";
import { assistantMessage, textBlock, toolUseBlock } from "./helpers/sdk-event-core.js";

test("copy uses the current completed answer and details stay local", async () => {
	const terminal = new FakeTerminal();
	const fake = new FakeQueryHarness();
	const copied: string[] = [];
	const controller = new AppController(testLaunch(), appDependencies(fake, terminal, {
		copyText: async (text) => { copied.push(text); },
	}));
	const running = controller.run();
	try {
		await waitFor(() => controller.ready !== undefined);
		fake.pushMessage(assistantMessage({ envelopeId: "answer", modelMessageId: "answer", content: [textBlock("Answer **one**"), textBlock("second block")] }));
		await waitFor(() => controller.state.conversationBlocks.length === 2);
		controller.setDraft("keep draft");
		terminal.input("\u001b[121;6u");
		await waitFor(() => copied.length === 1);
		assert.equal(copied[0], "Answer **one**\nsecond block");
		assert.equal(controller.views.editor.getText(), "keep draft");
		fake.pushMessage(assistantMessage({ envelopeId: "tool", modelMessageId: "tool", content: [toolUseBlock("read-1", "Read", { file_path: "source.ts", note: "extra detail" })] }));
		await waitFor(() => controller.state.toolReceipts.size === 1);
		controller.submitPrompt("/phi details");
		await waitFor(() => controller.views.transcript.toolDetailsVisible);
		assert.match(controller.views.transcript.render(80).join("\n"), /extra detail/);
		controller.submitPrompt("/phi details");
		await waitFor(() => !controller.views.transcript.toolDetailsVisible);
		assert.equal(fake.receivedMessages.length, 0);
	} finally { await controller.close(0); await running; }
});
