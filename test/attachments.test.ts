import assert from "node:assert/strict";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import {
	assertAttachmentTotalWithinLimit,
	createClipboardActions,
	loadImage,
	type SubprocessRequest,
} from "../src/attachments.js";

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
