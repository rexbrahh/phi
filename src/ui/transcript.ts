import { Markdown, Text, type Component } from "@earendil-works/pi-tui";
import type { ConversationBlock, PhiState, ProvisionalBlock, ToolReceipt } from "../state.js";
import { boundedPreviewValue, getContentType, getDisplayText, getProperty, getStringProperty } from "../state-utils.js";
import { sanitizeTerminalText } from "./safe-text.js";
import { markdownTheme } from "./theme.js";

interface CachedBlock {
	fingerprint: string;
	component: Component;
}

interface DisplayBlock {
	key: string;
	role: string;
	text: string;
	markdown: boolean;
}

export class TranscriptView implements Component {
	private readonly renderedBlocks = new Map<string, CachedBlock>();

	constructor(private readonly state: PhiState) {}

	render(width: number): string[] {
		const lines: string[] = [];
		const currentKeys = new Set<string>();

		for (const block of this.state.conversationBlocks) {
			const display = this.displayConversationBlock(block);
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

		if (lines.length === 0) return new Text("Waiting for a message. Type a prompt below.").render(width);
		return lines;
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

	private displayConversationBlock(block: ConversationBlock): DisplayBlock | undefined {
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
				text: formatToolReceipt(block.content, receipt),
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

function formatToolReceipt(content: unknown, receipt: ToolReceipt | undefined): string {
	const name = getStringProperty(content, "name") ?? receipt?.toolName ?? "Unknown tool";
	const input = getProperty(content, "input") ?? receipt?.input;
	const state = receipt?.executionState ?? "requested";
	const preview = receipt?.resultPreview;
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
