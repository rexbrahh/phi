import { Markdown, Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { ConversationBlock, PhiState, ProvisionalBlock, ToolReceipt } from "../state.js";
import { boundedPreviewValue, getContentType, getDisplayText, getProperty, getStringProperty, parseInputObject } from "../state-utils.js";
import { sanitizeTerminalText } from "./safe-text.js";
import { markdownTheme } from "./theme.js";

interface CachedBlock {
	fingerprint: string;
	component: Component;
	renderedLines?: {
		width: number;
		fingerprint: string;
		lines: string[];
	};
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
	private noticeCount = -1;
	private noticeTail: PhiState["notices"][number] | undefined;
	private groupedNotices: DisplayBlock[] = [];
	private showToolDetails = false;

	constructor(
		private readonly state: PhiState,
		private readonly formatDiagnostic: (text: string) => string = (text) => text,
	) {}

	diagnosticsText(): string {
		return this.displayNotices().map((notice) => `${notice.role}:\n${notice.text}`).join("\n\n") || "No diagnostics reported.";
	}

	get toolDetailsVisible(): boolean {
		return this.showToolDetails;
	}

	toggleToolDetails(): boolean {
		this.showToolDetails = !this.showToolDetails;
		this.invalidate();
		this.fittedLines = undefined;
		return this.showToolDetails;
	}

	latestAssistantText(): string | undefined {
		const messages = new Map<string, string[]>();
		for (const block of this.state.conversationBlocks) {
			if (block.role !== "assistant" || block.aborted) continue;
			const type = typeof block.content === "string" ? "text" : getContentType(block.content);
			if (type !== "text") continue;
			const text = typeof block.content === "string" ? block.content : getDisplayText(block.content);
			const message = messages.get(block.messageId);
			if (message) message.push(text);
			else messages.set(block.messageId, [text]);
		}

		for (const textBlocks of [...messages.values()].reverse()) {
			if (textBlocks.some((text) => text.length > 0)) return textBlocks.join("\n");
		}
		return undefined;
	}

	render(width: number): string[] {
		const lines: string[] = [];
		const currentKeys = new Set<string>();

		for (const block of this.state.conversationBlocks) {
			const display = this.displayConversationBlock(block, width);
			if (!display) continue;
			this.appendBlock(lines, display, width, currentKeys);
		}

		for (const block of this.state.provisionalBlocks.values()) {
			const display = this.displayProvisionalBlock(block, width);
			if (display) this.appendBlock(lines, display, width, currentKeys);
		}

		const notices = this.displayNotices();
		for (const display of notices.slice(-2)) {
			const preview = new Text(display.text.slice(0, 8_192), 0, 0).render(Math.max(1, width));
			const clipped = preview.length > 2 || display.text.length > 8_192;
			const text = preview.slice(0, 2);
			if (clipped) text[text.length - 1] = `${truncateToWidth(text.at(-1) ?? "", Math.max(0, width - 1), "")}…`;
			this.appendBlock(lines, { ...display, text: text.join("\n") }, width, currentKeys);
		}
		if (notices.length > 0) lines.push(...new Text(`${notices.length} diagnostic${notices.length === 1 ? "" : "s"} · /phi diagnostics for details`, 0, 0).render(width));

		for (const key of this.renderedBlocks.keys()) {
			if (!currentKeys.has(key)) this.renderedBlocks.delete(key);
		}

		if (lines.length === 0) lines.push(...new Text("Waiting for a message. Type a prompt below.", 0, 0).render(width));
		const result = fitLines(lines, width, this.fittedLines);
		this.fittedLines = result.cache;
		return result.lines;
	}

	invalidate(): void {
		for (const cached of this.renderedBlocks.values()) {
			cached.component.invalidate();
			cached.renderedLines = undefined;
		}
	}

	private appendBlock(
		lines: string[],
		display: DisplayBlock,
		width: number,
		currentKeys: Set<string>,
	): void {
		currentKeys.add(display.key);
		const component = this.componentFor(display);
		const fingerprint = `${display.role}\0${component.fingerprint}`;
		const rendered = component.renderedLines;
		if (rendered?.width === width && rendered.fingerprint === fingerprint) {
			if (lines.length > 0) lines.push("");
			lines.push(...rendered.lines);
			return;
		}

		const renderedLines = [
			...new Text(`${display.role}:`, 0, 0).render(width),
			...component.component.render(width),
		];
		component.renderedLines = { width, fingerprint, lines: renderedLines };
		if (lines.length > 0) lines.push("");
		lines.push(...renderedLines);
	}

	private componentFor(display: DisplayBlock): CachedBlock {
		const safeText = sanitizeTerminalText(display.text);
		const fingerprint = `${display.markdown ? "markdown" : "text"}\0${safeText}`;
		const cached = this.renderedBlocks.get(display.key);
		if (cached?.fingerprint === fingerprint) return cached;

		const component = display.markdown
			? new Markdown(safeText, 0, 0, markdownTheme)
			: new Text(safeText, 0, 0);
		const next = { fingerprint, component };
		this.renderedBlocks.set(display.key, next);
		return next;
	}

	private displayNotices(): DisplayBlock[] {
		const tail = this.state.notices.at(-1);
		if (this.noticeCount === this.state.notices.length && this.noticeTail === tail) return this.groupedNotices;
		const groups = new Map<string, { display: DisplayBlock; count: number }>();
		for (const notice of this.state.notices) {
			const display = displayNotice(notice);
			if (!display) continue;
			const signature = `${display.role}\0${display.text}`;
			const group = groups.get(signature);
			if (group) {
				group.count += 1;
				groups.delete(signature);
				groups.set(signature, group);
			}
			else groups.set(signature, { display: { ...display, text: sanitizeTerminalText(this.formatDiagnostic(display.text)) }, count: 1 });
		}
		this.noticeCount = this.state.notices.length;
		this.noticeTail = tail;
		this.groupedNotices = [...groups.values()].map(({ display, count }) => count === 1
			? display
			: { ...display, text: `×${count} ${display.text}` });
		return this.groupedNotices;
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
			const preview = receipt && !this.showToolDetails ? this.toolResultPreview(receipt, width) : undefined;
			return {
				key: block.id,
				role: "Tool",
				text: formatToolReceipt(block.content, receipt, preview, width, this.showToolDetails),
				markdown: false,
			};
		}
		if (type === "tool_result") {
			const id = getStringProperty(block.content, "tool_use_id");
			const receipt = id ? this.state.toolReceipts.get(id) : undefined;
			const output = receipt?.resultPreview ?? getDisplayText(block.content) ?? "Tool output is available in the SDK history.";
			return {
				key: block.id,
				role: `Tool result${receipt?.resultIsError ? " · failed" : ""}`,
				text: this.showToolDetails && output
					? `Retained output (bounded preview):\n${output}`
					: output,
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

	private displayProvisionalBlock(block: ProvisionalBlock, width: number): DisplayBlock | undefined {
		if (block.contentType === "text") {
			return { key: `partial:${block.id}`, role: "Phi · streaming", text: block.text, markdown: true };
		}
		if (block.contentType === "tool_use") {
			const receipt = block.toolUseId ? this.state.toolReceipts.get(block.toolUseId) : undefined;
			const name = receipt?.toolName ?? "tool";
			const input = block.partialInputJson
				? parseInputObject(block.partialInputJson) ?? block.partialInputJson
				: block.toolInput;
			const details = this.showToolDetails
				? retainedToolInput(input)
				: compactToolInputSummary(input, width);
			return {
				key: `partial:${block.id}`,
				role: "Tool · streaming",
				text: [String(name), details].filter(Boolean).join("\n"),
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

function formatToolReceipt(
	content: unknown,
	receipt: ToolReceipt | undefined,
	preview: string | undefined,
	width: number,
	detailsVisible: boolean,
): string {
	const name = getStringProperty(content, "name") ?? receipt?.toolName ?? "Unknown tool";
	const input = receipt?.input ?? (receipt?.partialInputJson || getProperty(content, "input"));
	const state = receipt?.executionState ?? "requested";
	if (detailsVisible) {
		return [
			`${name} · ${state}`,
			retainedToolInput(input),
			receipt?.resultPreview
				? `Retained output (bounded preview${receipt.resultIsError ? ", error" : ""}):\n${receipt.resultPreview}`
				: "",
		].filter(Boolean).join("\n");
	}
	const summary = compactToolInputSummary(input, width);
	return [
		`${name} · ${state}`,
		summary,
		preview ? `\n${preview}` : "",
	].filter(Boolean).join("\n");
}

function compactToolInputSummary(input: unknown, width: number): string {
	if (input === undefined) return "";
	let summary: string | undefined;
	for (const field of ["command", "file_path", "path", "pattern", "description"]) {
		const value = getStringProperty(input, field);
		if (value?.trim()) {
			summary = `${field}: ${value}`;
			break;
		}
	}
	const safeSummary = sanitizeTerminalText(summary ?? boundedPreviewValue(input)).replace(/\s+/gu, " ").trim();
	return safeSummary ? truncateToWidth(safeSummary, Math.max(1, width)) : "";
}

function retainedToolInput(input: unknown): string {
	if (input === undefined) return "";
	const preview = boundedPreviewValue(input);
	return preview ? `Retained input (bounded preview):\n${preview}` : "";
}

function displayNotice(notice: PhiState["notices"][number]): DisplayBlock | undefined {
	const message = notice.sourceMessage;
	const key = `notice:${notice.id}`;
	if (message.type === "system") {
		switch (message.subtype) {
			case "init":
			case "hook_started":
			case "hook_progress":
			case "control_request_progress":
			case "commands_changed":
			case "compact_boundary":
			case "session_state_changed":
			case "status":
			case "task_started":
			case "task_updated":
			case "task_progress":
			case "task_notification":
			case "background_tasks_changed":
			case "permission_denied":
			case "memory_recall":
				return undefined;
			case "hook_response":
				if (message.outcome === "success") return undefined;
				const detail = message.stderr || message.output || message.stdout;
				return {
					key,
					role: message.outcome === "error" ? "Hook failed" : "Hook cancelled",
					text: [
						`${message.hook_name}${message.exit_code === undefined ? "" : ` · exit ${message.exit_code}`}`,
						detail,
					].filter(Boolean).join("\n"),
					markdown: false,
				};
			case "informational":
				if (message.level !== "warning" && message.level !== "suggestion" && !message.prevent_continuation) return undefined;
				return {
					key,
					role: message.prevent_continuation ? "Blocked" : message.level === "warning" ? "Warning" : "Suggestion",
					text: message.content,
					markdown: false,
				};
			case "plugin_install":
				if (message.status !== "failed") return undefined;
				return {
					key,
					role: "Plugin error",
					text: [message.name, message.error].filter(Boolean).join(": ") || "Plugin installation failed.",
					markdown: false,
				};
			case "api_retry":
				return {
					key,
					role: "Request retry",
					text: `${message.attempt}/${message.max_retries}${message.error_status === null ? "" : ` · HTTP ${message.error_status}`} · ${message.error}`,
					markdown: false,
				};
			case "model_refusal_fallback":
				return {
					key,
					role: "Model fallback",
					text: `${message.original_model} → ${message.fallback_model}\n${message.content}`,
					markdown: false,
				};
			case "model_refusal_no_fallback":
				return { key, role: "Request refused", text: message.content, markdown: false };
			case "mirror_error":
				return { key, role: "Transcript save error", text: message.error, markdown: false };
			case "files_persisted":
				if (message.failed.length === 0) return undefined;
				return {
					key,
					role: "File save error",
					text: message.failed.map((failure) => `${failure.filename}: ${failure.error}`).join("\n"),
					markdown: false,
				};
			case "notification":
				if (message.priority !== "high" && message.priority !== "immediate") return undefined;
				return { key, role: "Notice", text: message.text, markdown: false };
			case "local_command_output":
				return { key, role: "Phi", text: message.content, markdown: false };
			default: {
				const error = getStringProperty(message, "error");
				return {
					key,
					role: error ? "SDK error" : "System",
					text: error ?? notice.text,
					markdown: false,
				};
			}
		}
	}
	if (message.type === "auth_status") {
		return message.error
			? { key, role: "Authentication error", text: message.error, markdown: false }
			: undefined;
	}
	if (message.type === "rate_limit_event") {
		const info = message.rate_limit_info;
		if (info.status === "allowed" && info.overageStatus !== "allowed_warning" && info.overageStatus !== "rejected") return undefined;
		return { key, role: "Rate limit", text: `${info.status}${info.overageStatus ? ` · overage ${info.overageStatus}` : ""}`, markdown: false };
	}
	if (message.type === "prompt_suggestion") {
		return { key, role: "Suggestion", text: message.suggestion, markdown: false };
	}
	if (message.type === "tool_use_summary") {
		return { key, role: "Tool summary", text: message.summary, markdown: false };
	}
	const error = getStringProperty(message, "error");
	return {
		key,
		role: error ? "SDK error" : "Notice",
		text: error ?? notice.text,
		markdown: false,
	};
}
