import assert from "node:assert/strict";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import {
	assertAttachmentTotalWithinLimit,
	createClipboardActions,
	loadImage,
	runSubprocess,
	type SubprocessRequest,
} from "../src/attachments.js";
import { AppAttachmentController } from "../src/ui/app-attachments.js";
import type { Editor } from "@earendil-works/pi-tui";

const imageFixtures = [
	{
		name: "png",
		mediaType: "image/png",
		bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]),
	},
	{
		name: "jpeg",
		mediaType: "image/jpeg",
		bytes: Buffer.from([0xff, 0xd8, 0xff, 0x01]),
	},
	{
		name: "gif87a",
		mediaType: "image/gif",
		bytes: Buffer.from("GIF87a\x01", "binary"),
	},
	{
		name: "gif89a",
		mediaType: "image/gif",
		bytes: Buffer.from("GIF89a\x01", "binary"),
	},
	{
		name: "webp",
		mediaType: "image/webp",
		bytes: Buffer.from("RIFF\x04\x00\x00\x00WEBP\x01", "binary"),
	},
] as const;

async function withTemporaryDirectory(run: (directory: string) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "phi-attachments-"));
	try {
		await run(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("loadImage derives MIME type from PNG, JPEG, GIF, and WebP signatures", async () => {
	await withTemporaryDirectory(async (directory) => {
		for (const fixture of imageFixtures) {
			const path = join(directory, `${fixture.name}.data`);
			await writeFile(path, fixture.bytes);

			const attachment = await loadImage(path);
			assert.deepEqual(attachment, {
				name: basename(path),
				sizeBytes: fixture.bytes.byteLength,
				mediaType: fixture.mediaType,
				block: {
					type: "image",
					source: {
						type: "base64",
						media_type: fixture.mediaType,
						data: fixture.bytes.toString("base64"),
					},
				},
			});
		}
	});
});

test("loadImage trusts the detected signature instead of the filename extension", async () => {
	await withTemporaryDirectory(async (directory) => {
		const path = join(directory, "photo.txt");
		const png = imageFixtures[0].bytes;
		await writeFile(path, png);

		assert.equal((await loadImage(path)).mediaType, "image/png");
	});
});

test("loadImage rejects unsupported bytes with a supported-format hint", async () => {
	await withTemporaryDirectory(async (directory) => {
		const path = join(directory, "image.png");
		await writeFile(path, "not an image");

		await assert.rejects(loadImage(path), /PNG, JPEG, GIF, or WebP/);
	});
});

test("loadImage rejects files above the per-image limit", async () => {
	await withTemporaryDirectory(async (directory) => {
		const path = join(directory, "large.png");
		await writeFile(path, Buffer.alloc(0));
		await truncate(path, 5_000_001);

		await assert.rejects(loadImage(path), /5,000,000-byte limit/);
	});
});

test("loadImage rejects a cancelled request before it reads the file", async () => {
	await withTemporaryDirectory(async (directory) => {
		const path = join(directory, "cancelled.png");
		await writeFile(path, imageFixtures[0].bytes);
		const controller = new AbortController();
		controller.abort(new Error("draft changed"));

		await assert.rejects(loadImage(path, controller.signal), /cancel/i);
	});
});

test("aggregate attachment validation allows 20 MB and rejects excess or oversized images", () => {
	assert.doesNotThrow(() => assertAttachmentTotalWithinLimit([
		{ sizeBytes: 5_000_000 },
		{ sizeBytes: 5_000_000 },
		{ sizeBytes: 5_000_000 },
		{ sizeBytes: 5_000_000 },
	]));
	assert.throws(
		() => assertAttachmentTotalWithinLimit([
			{ sizeBytes: 5_000_000 },
			{ sizeBytes: 5_000_000 },
			{ sizeBytes: 5_000_000 },
			{ sizeBytes: 5_000_000 },
			{ sizeBytes: 1 },
		]),
		/20,000,000-byte submission limit/,
	);
	assert.throws(
		() => assertAttachmentTotalWithinLimit([{ sizeBytes: 5_000_001 }]),
		/5,000,000-byte image limit/,
	);
});

test("late image failures restore a command only for the same draft and session", async () => {
	let editorText = "";
	let draftRevision = 1;
	let sessionId: string | undefined = "session-one";
	let rejectImage: ((error: Error) => void) | undefined;
	const notices: Array<string | undefined> = [];
	const controller = new AppAttachmentController({
		dependencies: {
			readClipboardImage: async () => null,
			copyText: async () => undefined,
			loadImage: () => new Promise((_resolve, reject) => { rejectImage = reject; }),
		},
		editor: { setText: (text: string) => { editorText = text; } } as unknown as Editor,
		draftRevision: () => draftRevision,
		sessionId: () => sessionId,
		processGeneration: () => 0,
		selectedOutput: () => undefined,
		isClosing: () => false,
		showNotice: (message) => { notices.push(message); },
	});

	controller.loadImage("draft.png", "/phi attach draft.png");
	assert.ok(rejectImage);
	editorText = "newer composer draft";
	draftRevision += 1;
	rejectImage(new Error("late draft failure"));
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	assert.equal(editorText, "newer composer draft");
	assert.match(notices.at(-1) ?? "", /late draft failure/);

	controller.loadImage("session.png", "/phi attach session.png");
	assert.ok(rejectImage);
	sessionId = "session-two";
	rejectImage(new Error("late session failure"));
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	assert.equal(editorText, "newer composer draft");
	assert.match(notices.at(-1) ?? "", /late session failure/);
	await controller.close();
});

test("clipboard image reading uses injected osascript and returns a typed image block", async () => {
	const png = imageFixtures[0].bytes;
	const requests: SubprocessRequest[] = [];
	const clipboard = createClipboardActions(async (request) => {
		requests.push(request);
		return Buffer.from(`${png.toString("base64")}\n`);
	});

	const attachment = await clipboard.readClipboardImage();
	assert.equal(attachment?.mediaType, "image/png");
	assert.equal(attachment?.name, "Clipboard image");
	assert.equal(attachment?.block.source.type, "base64");
	assert.deepEqual(requests.map(({ command }) => command), ["osascript"]);
	assert.deepEqual(requests[0]?.args.slice(0, 1), ["-e"]);
	assert.match(requests[0]?.args[1] ?? "", /framework "AppKit"/);
	assert.match(requests[0]?.args[1] ?? "", /NSPasteboard/);
	assert.equal(requests[0]?.stdin, undefined);
	assert.equal(requests[0]?.maxOutputBytes, 6_666_670);
});

test("clipboard image reading forwards its cancellation signal", async () => {
	const controller = new AbortController();
	let receivedSignal: AbortSignal | undefined;
	const clipboard = createClipboardActions(async (request) => {
		receivedSignal = request.signal;
		return Buffer.from(`${imageFixtures[0].bytes.toString("base64")}\n`);
	});

	await clipboard.readClipboardImage(controller.signal);
	assert.equal(receivedSignal, controller.signal);
});

test("clipboard image reading returns null when AppKit has no image", async () => {
	const clipboard = createClipboardActions(async () => Buffer.from("\n"));
	assert.equal(await clipboard.readClipboardImage(), null);
});

test("clipboard image reading rejects decoded images above the per-image limit", async () => {
	const oversizedPng = Buffer.alloc(5_000_001, 0x01);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(oversizedPng);
	const clipboard = createClipboardActions(async () => Buffer.from(`${oversizedPng.toString("base64")}\n`));

	await assert.rejects(clipboard.readClipboardImage(), /5,000,000-byte limit/);
});

test("clipboard subprocess failures become actionable without exposing clipboard contents", async () => {
	const clipboard = createClipboardActions(async () => {
		throw new Error("osascript unavailable");
	});

	await assert.rejects(clipboard.readClipboardImage(), /macOS clipboard image.*osascript unavailable/i);
});

test("copyText sends exact text to pbcopy stdin without shell interpolation", async () => {
	const requests: SubprocessRequest[] = [];
	const clipboard = createClipboardActions(async (request) => {
		requests.push(request);
		return Buffer.alloc(0);
	});
	const text = "quote ' and $(must stay literal)\nsecond line";

	await clipboard.copyText(text);

	assert.equal(requests.length, 1);
	assert.equal(requests[0]?.command, "pbcopy");
	assert.deepEqual(requests[0]?.args, []);
	assert.equal(requests[0]?.stdin, text);
});

test("production subprocess runner rejects output above its byte limit", async () => {
	await assert.rejects(
		runSubprocess({
			command: process.execPath,
			args: ["-e", "process.stdout.write('four')"],
			maxOutputBytes: 3,
			timeoutMs: 2_000,
		}),
		/output exceeded 3 bytes/,
	);
});

test("production subprocess runner reports non-zero exit and bounded stderr", async () => {
	await assert.rejects(
		runSubprocess({
			command: process.execPath,
			args: ["-e", "process.stderr.write('command failed'); process.exit(7)"],
			maxOutputBytes: 0,
			timeoutMs: 2_000,
		}),
		/exited with code 7: command failed/,
	);
});

test("production subprocess runner stops an aborted child", async () => {
	const controller = new AbortController();
	const pending = runSubprocess({
		command: process.execPath,
		args: ["-e", "setInterval(() => {}, 1000)"],
		maxOutputBytes: 0,
		signal: controller.signal,
		timeoutMs: 2_000,
	});
	setTimeout(() => controller.abort(new Error("user cancelled")), 30);

	await assert.rejects(pending, /cancel/i);
});

test("production subprocess runner enforces its deadline", async () => {
	await assert.rejects(
		runSubprocess({
			command: process.execPath,
			args: ["-e", "setInterval(() => {}, 1000)"],
			maxOutputBytes: 0,
			timeoutMs: 30,
		}),
		/timed out after 30 ms/,
	);
});
