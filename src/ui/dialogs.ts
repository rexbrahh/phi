import {
	Input,
	Key,
	Text,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type Focusable,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type { ElicitationResult } from "@anthropic-ai/claude-agent-sdk";
import type {
	InteractionAnswer,
	PendingInteraction,
	PendingQuestionRequest,
} from "../interaction-types.js";
import { sanitizeTerminalText } from "./safe-text.js";
import { theme } from "./theme.js";

export interface DialogViewActions {
	answer(requestId: string, answer: InteractionAnswer): void;
	openUrl(url: string): void;
	error(message: string): void;
	hide?(): void;
}

export class DialogView implements Component, Focusable {
	focused = false;
	private readonly input = new Input({ prompt: "> ", placeholder: "Enter a response" });
	private request: PendingInteraction | undefined;
	private questionIndex = 0;
	private readonly questionAnswers = new Map<string, { kind: "choice"; label: string } | { kind: "choices"; labels: string[] } | { kind: "text"; text: string }>();
	private readonly selectedOptions = new Set<number>();
	private validationMessage = "";
	private scrollOffset = 0;
	private scrollMaxOffset = 0;
	private scrollPageSize = 1;
	private revealInput = false;

	constructor(
		private readonly actions: DialogViewActions,
		private readonly getMaxRows: () => number = () => Number.MAX_SAFE_INTEGER,
	) {
		this.input.onSubmit = (value) => this.submitInput(value);
	}

	setRequest(request: PendingInteraction | undefined): void {
		if (this.request !== request) {
			this.questionIndex = 0;
			this.questionAnswers.clear();
			this.selectedOptions.clear();
			this.input.setValue("");
			this.validationMessage = "";
			this.resetScroll();
		}
		this.request = request;
		this.input.focused = this.focused && this.needsTextInput();
	}

	get requestId(): string | undefined {
		return this.request?.requestId;
	}

	needsTextInput(): boolean {
		if (this.request?.kind === "question") {
			return (this.currentQuestion()?.options?.length ?? 0) === 0;
		}
		return this.request?.kind === "elicitation" && this.request.mode === "form" && this.request.form.supported;
	}

	handleKey(data: string): boolean {
		const request = this.request;
		if (!request) return false;
		if (matchesKey(data, Key.ctrl("c"))) {
			if (request.kind === "permission") this.answer({ kind: "permission", action: "cancel" });
			else if (request.kind === "question") this.answer({ kind: "question", action: "cancel" });
			else this.answer({ kind: "elicitation", response: { action: "cancel" } });
			return true;
		}
		if (matchesKey(data, Key.escape)) {
			this.actions.hide?.();
			return true;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.scrollOffset = Math.max(0, this.scrollOffset - this.scrollPageSize);
			this.revealInput = false;
			return true;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.scrollOffset = Math.min(this.scrollMaxOffset, this.scrollOffset + this.scrollPageSize);
			this.revealInput = false;
			return true;
		}
		if (this.needsTextInput()) {
			if (request.kind === "elicitation" && request.mode === "form") {
				if (data === "\u0004") {
					this.answer({ kind: "elicitation", response: { action: "decline" } });
					return true;
				}
			}
			this.input.focused = this.focused;
			this.revealInput = true;
			this.input.handleInput(data);
			return true;
		}

		if (request.kind === "permission") {
			if (data === "1" || data.toLowerCase() === "y") {
				this.answer({ kind: "permission", action: "allow-once" });
				return true;
			}
			if (data.toLowerCase() === "a" && request.canAlwaysAllow) {
				this.answer({ kind: "permission", action: "allow-suggested" });
				return true;
			}
			if (data.toLowerCase() === "d") {
				this.answer({ kind: "permission", action: "deny" });
				return true;
			}
			return true;
		}

		if (request.kind === "question") return this.handleQuestionKey(request, data);
		if (request.mode === "url") {
			if (data.toLowerCase() === "o" && request.canOpenUrl && request.url) this.actions.openUrl(request.url);
			else if (data.toLowerCase() === "a" && request.canOpenUrl) this.answer({ kind: "elicitation", response: { action: "accept" } });
			else if (data.toLowerCase() === "d") this.answer({ kind: "elicitation", response: { action: "decline" } });
			else if (data.toLowerCase() === "c") this.answer({ kind: "elicitation", response: { action: "cancel" } });
			return true;
		}

		if (request.form.supported && data.toLowerCase() === "a") {
			try {
				const content: unknown = this.input.getValue() ? JSON.parse(this.input.getValue()) : {};
				this.answer({ kind: "elicitation", response: { action: "accept", content: content as ElicitationResult["content"] } });
			} catch (error) {
				this.showValidationError(error);
			}
		} else if (data.toLowerCase() === "d") {
			this.answer({ kind: "elicitation", response: { action: "decline" } });
		} else if (data.toLowerCase() === "c") {
			this.answer({ kind: "elicitation", response: { action: "cancel" } });
		}
		return true;
	}

	handleInput(data: string): void {
		this.handleKey(data);
	}

	handleMouse(_event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return undefined;
	}

	render(width: number): string[] {
		const request = this.request;
		if (!request) return [];
		const lines = wrapLine(theme.accent(`Waiting for you · ${request.kind}`), width);
		const headerLength = lines.length;
		let footer: string[];
		let inputLine: number | undefined;
		if (request.kind === "permission") {
			lines.push(...wrapLine(theme.dim(sanitizeTerminalText(request.title ?? request.displayName ?? request.toolName)), width));
			if (request.description) lines.push(...wrapLine(sanitizeTerminalText(request.description), width));
			lines.push(...wrapLine(formatPermissionInput(request.input), width));
			footer = wrapLine("1 Allow once · d Deny" + (request.canAlwaysAllow ? " · a Allow suggested" : ""), width);
		} else if (request.kind === "question") {
			const question = this.currentQuestion();
			lines.push(...wrapLine(theme.dim(`${request.title ?? request.displayName ?? "Question"} · ${this.questionIndex + 1}/${request.questions.length}`), width));
			if (question) {
				lines.push(...wrapLine(sanitizeTerminalText(question.question), width));
				if (question.options?.length) {
					for (const [index, option] of question.options.entries()) {
						const mark = this.selectedOptions.has(index) ? "[x]" : "[ ]";
						lines.push(...wrapLine(`${mark} ${index + 1}. ${sanitizeTerminalText(option.label)}${option.description ? ` — ${sanitizeTerminalText(option.description)}` : ""}`, width));
					}
					footer = wrapLine(question.multiSelect ? "Choose numbers, then Enter." : "Choose a number.", width);
				} else {
					const inputLines = this.input.render(width);
					inputLine = lines.length - headerLength + inputLines.length - 1;
					lines.push(...inputLines);
					footer = wrapLine("Enter submits your response.", width);
				}
			} else {
				footer = wrapLine("Ctrl+C cancels.", width);
			}
		} else if (request.mode === "url") {
			lines.push(...wrapLine(sanitizeTerminalText(request.url ?? "URL unavailable"), width));
			footer = wrapLine(request.canOpenUrl ? "o Open URL · a Continue · d Decline · c Cancel" : "d Decline · c Cancel", width);
		} else {
			const formTitle = request.form.supported ? request.form.title : "Form response";
			lines.push(...wrapLine(sanitizeTerminalText(formTitle ?? "Form response"), width));
			if (request.form.supported) {
				for (const field of request.form.fields) {
					lines.push(...wrapLine(`${sanitizeTerminalText(field.title ?? field.name)}${field.required ? " *" : ""} (${field.type})`, width));
					if (field.description) lines.push(...wrapLine(theme.dim(sanitizeTerminalText(field.description)), width));
				}
				const inputLines = this.input.render(width);
				inputLine = lines.length - headerLength + inputLines.length - 1;
				lines.push(...inputLines);
				footer = wrapLine("Enter JSON accepts · Ctrl+D declines", width);
			} else {
				lines.push(...wrapLine(theme.dim(`Unsupported form: ${sanitizeTerminalText(request.form.reason)}`), width));
				footer = wrapLine("d Decline · c Cancel", width);
			}
		}
		if (this.validationMessage) lines.push(...wrapLine(theme.dim(sanitizeTerminalText(this.validationMessage)), width));
		footer.push(...wrapLine("PgUp/PgDn scroll · Esc hides · Ctrl+C cancels.", width));

		const maxRows = Math.max(1, Math.floor(this.getMaxRows()));
		const bodyRows = Math.max(0, maxRows - headerLength - footer.length);
		const body = lines.slice(headerLength);
		this.scrollMaxOffset = Math.max(0, body.length - bodyRows);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, this.scrollMaxOffset));
		this.scrollPageSize = Math.max(1, bodyRows - 1);
		if (this.revealInput && inputLine !== undefined && bodyRows > 0) {
			if (inputLine < this.scrollOffset) this.scrollOffset = inputLine;
			else if (inputLine >= this.scrollOffset + bodyRows) this.scrollOffset = inputLine - bodyRows + 1;
			this.revealInput = false;
		}
		const visibleBody = body.slice(this.scrollOffset, this.scrollOffset + bodyRows);
		return fitLines([...lines.slice(0, headerLength), ...visibleBody, ...footer], width)
			.map((line) => theme.overlayLine(line, width));
	}

	invalidate(): void {
		this.input.invalidate();
	}

	private currentQuestion(): PendingQuestionRequest["questions"][number] | undefined {
		return this.request?.kind === "question" ? this.request.questions[this.questionIndex] : undefined;
	}

	private handleQuestionKey(request: PendingQuestionRequest, data: string): boolean {
		const question = this.currentQuestion();
		if (!question) return true;
		const options = question.options ?? [];
		const number = Number(data);
		if (Number.isInteger(number) && number > 0 && number <= Math.min(options.length, 9)) {
			const selected = number - 1;
			if (question.multiSelect) {
				if (this.selectedOptions.has(selected)) this.selectedOptions.delete(selected);
				else this.selectedOptions.add(selected);
			} else {
				const label = options[selected]?.label;
				if (label !== undefined) {
					this.questionAnswers.set(question.question, { kind: "choice", label });
					this.advanceQuestion(request);
				}
			}
			return true;
		}
		if (data === "\r" || data === "\n") {
			if (question.multiSelect && this.selectedOptions.size > 0) {
				const labels = [...this.selectedOptions].flatMap((index) => options[index]?.label ? [options[index].label] : []);
				this.questionAnswers.set(question.question, { kind: "choices", labels });
				this.advanceQuestion(request);
			}
			return true;
		}
		return true;
	}

	private submitInput(value: string): void {
		const request = this.request;
		if (!request) return;
		if (request.kind === "question") {
			const question = this.currentQuestion();
			if (!question || !value.trim()) return;
			this.questionAnswers.set(question.question, { kind: "text", text: value });
			this.input.setValue("");
			this.advanceQuestion(request);
		} else if (request.kind === "elicitation" && request.mode === "form") {
			try {
				const content: unknown = value ? JSON.parse(value) : {};
				this.answer({ kind: "elicitation", response: { action: "accept", content: content as ElicitationResult["content"] } });
			} catch (error) {
				this.showValidationError(error);
				this.input.setValue(value);
			}
		}
	}

	private advanceQuestion(request: PendingQuestionRequest): void {
		this.selectedOptions.clear();
		this.input.setValue("");
		if (this.questionIndex + 1 < request.questions.length) {
			this.questionIndex += 1;
			this.resetScroll();
			return;
		}
		const answers = Object.fromEntries(this.questionAnswers);
		this.answer({ kind: "question", answers });
	}

	private answer(answer: InteractionAnswer): void {
		const requestId = this.request?.requestId;
		if (!requestId) return;
		this.actions.answer(requestId, answer);
	}

	private resetScroll(): void {
		this.scrollOffset = 0;
		this.scrollMaxOffset = 0;
		this.scrollPageSize = 1;
		this.revealInput = false;
	}

	private showValidationError(error: unknown): void {
		this.validationMessage = error instanceof Error ? error.message : String(error);
		this.actions.error(this.validationMessage);
	}
}

function wrapLine(text: string, width: number): string[] {
	return new Text(text, 0, 0).render(Math.max(1, width));
}

function formatPermissionInput(value: Record<string, unknown>): string {
	return sanitizeTerminalText(JSON.stringify(value, null, 2) ?? "{}");
}

function fitLines(lines: string[], width: number): string[] {
	const availableWidth = Math.max(1, width);
	return lines.map((line) => visibleWidth(line) <= availableWidth ? line : truncateToWidth(line, availableWidth));
}
