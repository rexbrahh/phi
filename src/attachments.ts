import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { basename } from "node:path";
import type { ImageBlockParam } from "@anthropic-ai/sdk/resources";

export const MAX_IMAGE_BYTES = 5_000_000;
export const MAX_SUBMISSION_ATTACHMENT_BYTES = 20_000_000;

const MAX_STDERR_BYTES = 8_192;
const MAX_CLIPBOARD_BASE64_BYTES = 4 * Math.ceil(MAX_IMAGE_BYTES / 3);
const DEFAULT_SUBPROCESS_TIMEOUT_MS = 10_000;
const KILL_ESCALATION_MS = 250;

class SubprocessOutputLimitError extends Error {}

export type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export interface ImageAttachment {
	name: string;
	sizeBytes: number;
	mediaType: ImageMediaType;
	block: ImageBlockParam;
}

export class AttachmentError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "AttachmentError";
	}
}

export interface SubprocessRequest {
	command: string;
	args: readonly string[];
	stdin?: string;
	maxOutputBytes: number;
	signal?: AbortSignal;
	timeoutMs?: number;
}

export type RunSubprocess = (request: SubprocessRequest) => Promise<Buffer>;

export interface ClipboardActions {
	readClipboardImage(signal?: AbortSignal): Promise<ImageAttachment | null>;
	copyText(text: string, signal?: AbortSignal): Promise<void>;
}

const APPKIT_IMAGE_SCRIPT = `use framework "AppKit"
use scripting additions

set pasteboard to current application's NSPasteboard's generalPasteboard()
set image to current application's NSImage's alloc()'s initWithPasteboard:pasteboard
if image is missing value then return ""

set tiffData to image's TIFFRepresentation()
if tiffData is missing value then return ""
set bitmap to current application's NSBitmapImageRep's imageRepWithData:tiffData
if bitmap is missing value then return ""
set pngData to bitmap's representationUsingType:(current application's NSBitmapImageFileTypePNG) properties:(current application's NSDictionary's dictionary())
if pngData is missing value then return ""
return (pngData's base64EncodedStringWithOptions:0) as text`;

export async function loadImage(path: string, signal?: AbortSignal): Promise<ImageAttachment> {
	const bytes = await readBoundedFile(path, signal);
	return makeImageAttachment(basename(path) || "Image", bytes, `Image "${path}"`);
}

export function assertAttachmentTotalWithinLimit(
	attachments: readonly Pick<ImageAttachment, "sizeBytes">[],
): void {
	let totalBytes = 0;
	for (const [index, attachment] of attachments.entries()) {
		if (!Number.isSafeInteger(attachment.sizeBytes) || attachment.sizeBytes < 0) {
			throw new AttachmentError(
				`Attachment ${index + 1} has invalid size metadata. Remove it and attach the image again.`,
			);
		}
		if (attachment.sizeBytes > MAX_IMAGE_BYTES) {
			throw new AttachmentError(
				`Image ${index + 1} exceeds the 5,000,000-byte image limit. Choose an image no larger than 5 MB.`,
			);
		}
		totalBytes += attachment.sizeBytes;
		if (totalBytes > MAX_SUBMISSION_ATTACHMENT_BYTES) {
			throw new AttachmentError(
				`Images exceed the 20,000,000-byte submission limit. Remove an image or choose smaller images.`,
			);
		}
	}
}

export function createClipboardActions(runSubprocess: RunSubprocess): ClipboardActions {
	return {
		async readClipboardImage(signal?: AbortSignal): Promise<ImageAttachment | null> {
			requireMacOS("clipboard image paste");
			let output: Buffer;
			try {
				output = await runSubprocess({
					command: "osascript",
					args: ["-e", APPKIT_IMAGE_SCRIPT],
					maxOutputBytes: MAX_CLIPBOARD_BASE64_BYTES + 2,
					signal,
				});
			} catch (error) {
				if (signal?.aborted) {
					throw new AttachmentError("Clipboard image read was cancelled.", { cause: error });
				}
				if (error instanceof SubprocessOutputLimitError) {
					throw new AttachmentError(
						"Clipboard image exceeds the 5,000,000-byte limit. Copy a smaller image and try again.",
						{ cause: error },
					);
				}
				throw new AttachmentError(
					`Could not read a macOS clipboard image with osascript. Check that osascript is available, then copy the image again. ${errorMessage(error)}`,
					{ cause: error },
				);
			}

			const encoded = output.toString("ascii").trim();
			if (encoded.length === 0) return null;
			if (encoded.length > MAX_CLIPBOARD_BASE64_BYTES) {
				throw new AttachmentError(
					"Clipboard image exceeds the 5,000,000-byte limit. Copy a smaller image and try again.",
				);
			}
			if (!isCanonicalBase64(encoded)) {
				throw new AttachmentError(
					"macOS returned invalid clipboard image data. Copy the image again and retry.",
				);
			}

			return makeImageAttachment("Clipboard image", Buffer.from(encoded, "base64"), "Clipboard image");
		},

		async copyText(text: string, signal?: AbortSignal): Promise<void> {
			requireMacOS("copying text");
			try {
				await runSubprocess({
					command: "pbcopy",
					args: [],
					stdin: text,
					maxOutputBytes: 0,
					signal,
				});
			} catch (error) {
				if (signal?.aborted) {
					throw new AttachmentError("Text copy was cancelled.", { cause: error });
				}
				throw new AttachmentError(
					`Could not copy text with pbcopy. Check that pbcopy is available and try again. ${errorMessage(error)}`,
					{ cause: error },
				);
			}
		},
	};
}

const defaultClipboardActions = createClipboardActions(runSubprocess);

export function readClipboardImage(signal?: AbortSignal): Promise<ImageAttachment | null> {
	return defaultClipboardActions.readClipboardImage(signal);
}

export function copyText(text: string, signal?: AbortSignal): Promise<void> {
	return defaultClipboardActions.copyText(text, signal);
}

async function readBoundedFile(path: string, signal?: AbortSignal): Promise<Buffer> {
	let file: FileHandle | undefined;
	let bytes: Buffer | undefined;
	let failure: unknown;

	try {
		throwIfAborted(signal, "Image load");
		file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
		throwIfAborted(signal, "Image load");
		const fileStat = await file.stat();
		throwIfAborted(signal, "Image load");
		if (!fileStat.isFile()) {
			throw new AttachmentError(`Image "${path}" is not a regular file. Choose a PNG, JPEG, GIF, or WebP file.`);
		}
		if (fileStat.size > MAX_IMAGE_BYTES) {
			throw imageSizeError(path);
		}

		const expectedBytes = fileStat.size;
		const buffer = Buffer.allocUnsafe(expectedBytes + 1);
		let totalBytes = 0;
		while (totalBytes < buffer.byteLength) {
			throwIfAborted(signal, "Image load");
			const { bytesRead } = await file.read(
				buffer,
				totalBytes,
				buffer.byteLength - totalBytes,
				null,
			);
			throwIfAborted(signal, "Image load");
			if (bytesRead === 0) break;
			totalBytes += bytesRead;
			if (totalBytes > MAX_IMAGE_BYTES) throw imageSizeError(path);
		}

		if (totalBytes !== expectedBytes) {
			throw new AttachmentError(`Image "${path}" changed while it was being read. Try attaching it again.`);
		}
		bytes = buffer.subarray(0, totalBytes);
	} catch (error) {
		failure = error;
	}

	if (file) {
		try {
			await file.close();
		} catch (error) {
			if (failure === undefined) failure = error;
		}
	}

	if (failure !== undefined) {
		if (failure instanceof AttachmentError) throw failure;
		throw new AttachmentError(
			`Cannot read image "${path}". Choose a readable PNG, JPEG, GIF, or WebP file. ${errorMessage(failure)}`,
			{ cause: failure },
		);
	}
	if (!bytes) {
		throw new AttachmentError(`Cannot read image "${path}". Choose a readable PNG, JPEG, GIF, or WebP file.`);
	}
	return bytes;
}

function makeImageAttachment(name: string, bytes: Buffer, description: string): ImageAttachment {
	if (bytes.byteLength > MAX_IMAGE_BYTES) {
		throw new AttachmentError(`${description} exceeds the 5,000,000-byte limit. Choose an image no larger than 5 MB.`);
	}
	const mediaType = detectImageMediaType(bytes);
	if (!mediaType) {
		throw new AttachmentError(
			`${description} does not have a supported PNG, JPEG, GIF, or WebP signature. Choose a supported image file.`,
		);
	}

	const block: ImageBlockParam = {
		type: "image",
		source: {
			type: "base64",
			media_type: mediaType,
			data: bytes.toString("base64"),
		},
	};
	return { name, sizeBytes: bytes.byteLength, mediaType, block };
}

function detectImageMediaType(bytes: Buffer): ImageMediaType | undefined {
	if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
		return "image/png";
	}
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return "image/jpeg";
	}
	if (bytes.length >= 6) {
		const gifSignature = bytes.toString("ascii", 0, 6);
		if (gifSignature === "GIF87a" || gifSignature === "GIF89a") return "image/gif";
	}
	if (
		bytes.length >= 12 &&
		bytes.toString("ascii", 0, 4) === "RIFF" &&
		bytes.toString("ascii", 8, 12) === "WEBP"
	) {
		return "image/webp";
	}
	return undefined;
}

function isCanonicalBase64(value: string): boolean {
	if (value.length === 0 || value.length % 4 !== 0) return false;

	let paddingBytes = 0;
	if (value.endsWith("==")) paddingBytes = 2;
	else if (value.endsWith("=")) paddingBytes = 1;

	const dataLength = value.length - paddingBytes;
	if (paddingBytes > 0 && dataLength % 4 !== 4 - paddingBytes) return false;
	for (let index = 0; index < dataLength; index += 1) {
		const code = value.charCodeAt(index);
		const isLetter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
		const isDigit = code >= 48 && code <= 57;
		if (!isLetter && !isDigit && code !== 43 && code !== 47) return false;
	}
	return Buffer.from(value, "base64").toString("base64") === value;
}

function requireMacOS(action: string): void {
	if (process.platform !== "darwin") {
		throw new AttachmentError(`macOS is required for ${action}.`);
	}
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

function imageSizeError(path: string): AttachmentError {
	return new AttachmentError(
		`Image "${path}" exceeds the 5,000,000-byte limit. Choose an image no larger than 5 MB.`,
	);
}

function throwIfAborted(signal: AbortSignal | undefined, action: string): void {
	if (!signal?.aborted) return;
	throw new AttachmentError(`${action} was cancelled.`, { cause: signal.reason });
}

export function runSubprocess(request: SubprocessRequest): Promise<Buffer> {
	const timeoutMs = request.timeoutMs ?? DEFAULT_SUBPROCESS_TIMEOUT_MS;
	if (!Number.isSafeInteger(request.maxOutputBytes) || request.maxOutputBytes < 0) {
		return Promise.reject(new TypeError("Subprocess output limit must be a non-negative safe integer."));
	}
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		return Promise.reject(new TypeError("Subprocess timeout must be greater than zero milliseconds."));
	}
	if (request.signal?.aborted) {
		return Promise.reject(new Error("Subprocess was cancelled before it started."));
	}

	return new Promise((resolve, reject) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(request.command, [...request.args], {
				stdio: ["pipe", "pipe", "pipe"],
				shell: false,
			});
		} catch (error) {
			reject(error);
			return;
		}
		const stdin = child.stdin;
		const stdoutStream = child.stdout;
		const stderrStream = child.stderr;
		if (!stdin || !stdoutStream || !stderrStream) {
			child.kill("SIGKILL");
			reject(new Error("Subprocess pipes were not available."));
			return;
		}

		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let settled = false;
		let failure: Error | undefined;
		let timeout: NodeJS.Timeout | undefined;
		let killTimer: NodeJS.Timeout | undefined;

		const cleanup = (): void => {
			if (timeout) clearTimeout(timeout);
			if (killTimer) clearTimeout(killTimer);
			request.signal?.removeEventListener("abort", onAbort);
		};
		const settle = (error: Error | undefined, output?: Buffer): void => {
			if (settled) return;
			settled = true;
			cleanup();
			if (error) reject(error);
			else resolve(output ?? Buffer.alloc(0));
		};
		const stop = (error: Error): void => {
			if (settled || failure) return;
			failure = error;
			try {
				child.kill("SIGTERM");
			} catch {
				// The close event will settle the request if the process has exited.
			}
			killTimer = setTimeout(() => {
				if (settled) return;
				try {
					child.kill("SIGKILL");
				} catch {
					// The close event will settle the request if the process has exited.
				}
			}, KILL_ESCALATION_MS);
			killTimer.unref();
		};
		const onAbort = (): void => {
			stop(new Error("Subprocess was cancelled."));
		};

		stdoutStream.on("data", (chunk: Buffer) => {
			stdoutBytes += chunk.byteLength;
			if (stdoutBytes > request.maxOutputBytes) {
				stop(new SubprocessOutputLimitError(`Subprocess output exceeded ${request.maxOutputBytes} bytes.`));
				return;
			}
			stdout.push(chunk);
		});
		stderrStream.on("data", (chunk: Buffer) => {
			const remaining = MAX_STDERR_BYTES - stderrBytes;
			if (remaining <= 0) return;
			const retained = chunk.subarray(0, remaining);
			stderr.push(retained);
			stderrBytes += retained.byteLength;
		});
		stdin.on("error", (error) => stop(error));
		stdoutStream.on("error", (error) => stop(error));
		stderrStream.on("error", (error) => stop(error));
		child.once("error", (error) => settle(error));
		child.once("close", (code, signal) => {
			if (failure) {
				settle(failure);
				return;
			}
			if (code !== 0) {
				const diagnostic = Buffer.concat(stderr).toString("utf8").trim();
				const status = code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`;
				settle(new Error(`${request.command} exited with ${status}${diagnostic ? `: ${diagnostic}` : ""}.`));
				return;
			}
			settle(undefined, Buffer.concat(stdout, stdoutBytes));
		});
		request.signal?.addEventListener("abort", onAbort, { once: true });
		timeout = setTimeout(() => {
			stop(new Error(`Subprocess timed out after ${timeoutMs} ms.`));
		}, timeoutMs);
		if (request.signal?.aborted) onAbort();

		if (request.stdin === undefined) stdin.end();
		else stdin.end(request.stdin);
	});
}
