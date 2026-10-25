import { Markdown, Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { ConversationBlock, PhiState, ProvisionalBlock, ToolReceipt } from "../state.js";
import { boundedPreviewValue, getContentType, getDisplayText, getProperty, getStringProperty } from "../state-utils.js";
import { sanitizeTerminalText } from "./safe-text.js";
import { markdownTheme } from "./theme.js";

interface CachedBlock {
	fingerprint: string;
	component: Component;
}

interface FittedLinesCache {
	width: number;
	source: string[];
	lines: string[];
}

interface CachedPreview {
	width: number;
	source: string;
	text: string;
}

interface DisplayBlock {
	key: string;
	role: string;
	text: string;
	markdown: boolean;
}

const MAX_TOOL_RESULT_DISPLAY_LINES = 4;

export class TranscriptView implements Component {
	private readonly renderedBlocks = new Map<string, CachedBlock>();
	private readonly toolResultPreviews = new WeakMap<ToolReceipt, CachedPreview>();
	private fittedLines: FittedLinesCache | undefined;

	constructor(private readonly state: PhiState) {}

	render(width: number): string[] {
		const lines: string[] = [];
		const currentKeys = new Set<string>();

		for (const block of this.state.conversationBlocks) {
			const display = this.displayConversationBlock(block, width);
			if (!display) continue;
			this.appendBlock(lines, display, width, currentKeys);
		}

		for (const block of this.state.provisionalBlocks.values()) {
			const display = this.displayProvisionalBlock(block);
			if (display) this.appendBlock(lines, display, width, currentKeys);
		}

		for (const notice of this.state.notices.slice(-20)) {
			const display = {
				key: `notice:${notice.id}`,
				role: "Notice",
				text: `${notice.text}\n${safeMessageDetails(notice.sourceMessage)}`.trim(),
				markdown: false,
			};
			this.appendBlock(lines, display, width, currentKeys);
		}

		for (const key of this.renderedBlocks.keys()) {
			if (!currentKeys.has(key)) this.renderedBlocks.delete(key);
		}

		if (lines.length === 0) lines.push(...new Text("Waiting for a message. Type a prompt below.").render(width));
		const result = fitLines(lines, width, this.fittedLines);
		this.fittedLines = result.cache;
		return result.lines;
	}

	invalidate(): void {
		for (const cached of this.renderedBlocks.values()) cached.component.invalidate();
	}

	private appendBlock(
		lines: string[],
		display: DisplayBlock,
		width: number,
		currentKeys: Set<string>,
	): void {
		currentKeys.add(display.key);
		lines.push(...new Text(`${display.role}:`).render(width));
		const component = this.componentFor(display);
		lines.push(...component.render(width));
		lines.push("");
	}

	private componentFor(display: DisplayBlock): Component {
		const safeText = sanitizeTerminalText(display.text);
		const fingerprint = `${display.markdown ? "markdown" : "text"}\0${safeText}`;
		const cached = this.renderedBlocks.get(display.key);
		if (cached?.fingerprint === fingerprint) return cached.component;

		const component = display.markdown
			? new Markdown(safeText, 0, 0, markdownTheme)
			: new Text(safeText);
		this.renderedBlocks.set(display.key, { fingerprint, component });
		return component;
	}

	private displayConversationBlock(block: ConversationBlock, width: number): DisplayBlock | undefined {
		if (typeof block.content === "string") {
			return { key: block.id, role: block.role === "assistant" ? "Phi" : "You", text: block.content, markdown: block.role === "assistant" };
		}

		const type = getContentType(block.content);
		if (type === "text") {
			return {
				key: block.id,
				role: block.role === "assistant" ? "Phi" : "You",
				text: getDisplayText(block.content),
				markdown: block.role === "assistant",
			};
		}
		if (type === "tool_use") {
			const id = getStringProperty(block.content, "id");
			const receipt = id ? this.state.toolReceipts.get(id) : undefined;
			return {
				key: block.id,
				role: "Tool",
				text: formatToolReceipt(block.content, receipt, receipt ? this.toolResultPreview(receipt, width) : undefined),
				markdown: false,
			};
		}
		if (type === "tool_result") {
			const id = getStringProperty(block.content, "tool_use_id");
			const receipt = id ? this.state.toolReceipts.get(id) : undefined;
			return {
				key: block.id,
				role: "Tool result",
				text: receipt?.resultPreview ?? getDisplayText(block.content) ?? "Tool output is available in the SDK history.",
				markdown: false,
			};
		}
		if (type === "image") {
			return { key: block.id, role: "You", text: "[Image attachment]", markdown: false };
		}
		if (type === "thinking" || type === "redacted_thinking") return undefined;
		return { key: block.id, role: "Content", text: `[${type || "unknown"} block]`, markdown: false };
	}

	private toolResultPreview(receipt: ToolReceipt, width: number): string | undefined {
		const source = receipt.resultPreview;
		if (!source) return undefined;

		const cached = this.toolResultPreviews.get(receipt);
		if (cached?.width === width && cached.source === source) return cached.text;

		const text = renderToolResultPreview(source, Math.max(1, width - 2));
		this.toolResultPreviews.set(receipt, { width, source, text });
		return text;
	}

	private displayProvisionalBlock(block: ProvisionalBlock): DisplayBlock | undefined {
		if (block.contentType === "text") {
			return { key: `partial:${block.id}`, role: "Phi · streaming", text: block.text, markdown: true };
		}
		if (block.contentType === "tool_use") {
			const name = block.toolInput?.name ?? "tool";
			const input = block.toolInput?.input ?? block.partialInputJson;
			return {
				key: `partial:${block.id}`,
				role: "Tool · streaming",
				text: `${String(name)}\n${boundedPreviewValue(input)}`,
				markdown: false,
			};
		}
		return undefined;
	}
}

function fitLines(lines: string[], width: number, previous?: FittedLinesCache): { lines: string[]; cache: FittedLinesCache } {
	const availableWidth = Math.max(1, width);
	let fittedLines: string[] | undefined;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		const fitted = previous?.width === availableWidth && previous.source[index] === line
			? previous.lines[index] ?? line
			: visibleWidth(line) <= availableWidth ? line : truncateToWidth(line, availableWidth);
		if (fitted !== line) {
			fittedLines ??= lines.slice();
			fittedLines[index] = fitted;
		}
	}
	const output = fittedLines ?? lines;
	return { lines: output, cache: { width: availableWidth, source: lines, lines: output } };
}

function renderToolResultPreview(source: string, width: number): string {
	if (source.trim() === "") return source;

	const rendered: string[] = [];
	const sourceLines = source.split("\n");
	for (let index = 0; index < sourceLines.length; index += 1) {
		const sourceLine = sourceLines[index] ?? "";
		const remainingRows = MAX_TOOL_RESULT_DISPLAY_LINES + 1 - rendered.length;
		if (remainingRows <= 0) return clippedToolResultPreview(rendered);

		const boundedLine = truncateToWidth(sourceLine, (width + 2) * remainingRows, "");
		const normalizedLine = sourceLine.replace(/\t/g, "   ");
		const wrappedLines = normalizedLine.trim() === ""
			? [normalizedLine + " ".repeat(Math.max(0, width - visibleWidth(normalizedLine)))]
			: new Text(boundedLine, 0, 0).render(width);
		rendered.push(...wrappedLines.slice(0, remainingRows));

		if (boundedLine !== sourceLine || wrappedLines.length > remainingRows || rendered.length > MAX_TOOL_RESULT_DISPLAY_LINES) {
			return clippedToolResultPreview(rendered);
		}
	}

	return source;
}

function clippedToolResultPreview(lines: string[]): string {
	return `${lines.slice(0, MAX_TOOL_RESULT_DISPLAY_LINES - 1).join("\n")}\n…`;
}

function formatToolReceipt(content: unknown, receipt: ToolReceipt | undefined, preview: string | undefined): string {
	const name = getStringProperty(content, "name") ?? receipt?.toolName ?? "Unknown tool";
	const input = getProperty(content, "input") ?? receipt?.input;
	const state = receipt?.executionState ?? "requested";
	return [
		`${name} · ${state}`,
		input === undefined ? "" : boundedPreviewValue(input),
		preview ? `\n${preview}` : "",
	].filter(Boolean).join("\n");
}

function safeMessageDetails(message: PhiState["notices"][number]["sourceMessage"]): string {
	if (message.type === "system" && (message.subtype === "hook_response" || message.subtype === "plugin_install")) {
		return boundedPreviewValue(message);
	}
	if (message.type === "system" && message.subtype === "informational") {
		return boundedPreviewValue(message);
	}
	return "";
}
