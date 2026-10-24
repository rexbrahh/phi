import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { PhiState, TaskRecord } from "./state.js";

const MAX_PREVIEW_CHARS = 8_192;
const MAX_PREVIEW_LINES = 12;

export function addNotice(state: PhiState, message: SDKMessage, text: string): void {
	const type = typeof message === "object" && message !== null && "type" in message
		? String((message as { type: unknown }).type)
		: "unknown";
	const subtype = typeof message === "object" && message !== null && "subtype" in message
		? String((message as { subtype: unknown }).subtype)
		: undefined;
	const id = getEnvelopeId(message) ?? `${type}:${state.notices.length}`;
	state.notices.push({ id, type, subtype, text, sourceMessage: message });
}

export function getEnvelopeId(message: SDKMessage): string | undefined {
	if (typeof message !== "object" || message === null || !("uuid" in message)) return undefined;
	return typeof message.uuid === "string" ? message.uuid : undefined;
}

export function getContentType(value: unknown): string {
	return getStringProperty(value, "type") ?? "unknown";
}

export function getStringProperty(value: unknown, key: string): string | undefined {
	const property = getProperty(value, key);
	return typeof property === "string" ? property : undefined;
}

export function getObjectProperty(value: unknown, key: string): Record<string, unknown> | undefined {
	const property = getProperty(value, key);
	return property && typeof property === "object" && !Array.isArray(property)
		? property as Record<string, unknown>
		: undefined;
}

export function parseInputObject(value: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(value);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? parsed as Record<string, unknown>
			: undefined;
	} catch {
		return undefined;
	}
}

export function getProperty(value: unknown, key: string): unknown {
	return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

export function getDisplayText(value: unknown): string {
	const type = getContentType(value);
	if (type === "text") return getStringProperty(value, "text") ?? "";
	if (type === "thinking") return getStringProperty(value, "thinking") ?? "";
	return "";
}

export function boundedPreview(value: string): string {
	const clippedByCharacters = value.length > MAX_PREVIEW_CHARS;
	const characterBounded = clippedByCharacters ? value.slice(0, MAX_PREVIEW_CHARS) : value;
	const lines = characterBounded.split("\n");
	const clippedByLines = lines.length > MAX_PREVIEW_LINES;
	let preview = clippedByLines ? lines.slice(0, MAX_PREVIEW_LINES).join("\n") : characterBounded;
	if (!clippedByCharacters && !clippedByLines) return preview;
	if (preview.length >= MAX_PREVIEW_CHARS) preview = preview.slice(0, MAX_PREVIEW_CHARS - 1);
	if (preview.split("\n").length >= MAX_PREVIEW_LINES || clippedByCharacters) {
		return `${preview}…`;
	}
	return `${preview}${preview.endsWith("\n") ? "" : "\n"}…`;
}

export function boundedPreviewFromParts(parts: Iterable<string>): string | undefined {
	let preview = "";
	let characters = 0;
	let lines = 1;
	let hasPart = false;
	let clipped = false;

	const append = (value: string): void => {
		let offset = 0;
		while (offset < value.length && !clipped) {
			if (characters >= MAX_PREVIEW_CHARS + 1) {
				clipped = true;
				return;
			}
			const availableCharacters = MAX_PREVIEW_CHARS + 1 - characters;
			const newline = value.indexOf("\n", offset);
			if (newline === -1 || newline - offset >= availableCharacters) {
				const end = Math.min(value.length, offset + availableCharacters);
				const chunk = value.slice(offset, end);
				preview += chunk;
				characters += chunk.length;
				if (end < value.length) clipped = true;
				return;
			}

			const end = newline + 1;
			const chunk = value.slice(offset, end);
			preview += chunk;
			characters += chunk.length;
			lines += 1;
			offset = end;
			if (lines > MAX_PREVIEW_LINES) clipped = true;
		}
	};

	for (const part of parts) {
		if (!part) continue;
		if (hasPart) append("\n");
		if (clipped) break;
		hasPart = true;
		append(part);
		if (clipped) break;
	}

	return hasPart ? boundedPreview(preview) : undefined;
}

export function addUnique(values: string[], value: string): string[] {
	return value && !values.includes(value) ? [...values, value] : values;
}

export function getOrCreateTask(state: PhiState, taskId: string): TaskRecord {
	const existing = state.tasks.get(taskId);
	if (existing) return existing;
	const task: TaskRecord = { taskId, status: "pending", ambient: false };
	state.tasks.set(taskId, task);
	return task;
}
