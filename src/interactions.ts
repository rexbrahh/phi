import type {
	ElicitationRequest,
	ElicitationResult,
	PermissionResult,
	PermissionUpdate,
} from "@anthropic-ai/claude-agent-sdk";
import {
	inspectElicitationForm,
	isHttpElicitationUrl,
	validateElicitationResponse,
	type ElicitationFormSupport,
} from "./elicitation-validation.js";
import type {
	CanUseTool,
	CanUseToolOptions,
	ElicitationOptions,
	InteractionAnswer,
	OnElicitation,
	PendingFormElicitationRequest,
	PendingInteraction,
	PendingPermissionRequest,
	PendingQuestionRequest,
	PendingUrlElicitationRequest,
	PermissionAnswer,
	QuestionAnswer,
	ToolNativePayload,
} from "./interaction-types.js";
import {
	InteractionValidationError,
	parseAskUserQuestions,
	validateQuestionAnswers,
	type AskUserQuestion,
} from "./question-validation.js";

export { isHttpElicitationUrl };

export * from "./interaction-types.js";

type RequestKind = PendingInteraction["kind"];
type NativeInteractionResult = PermissionResult | ElicitationResult;

interface ActiveRequest {
	readonly pending: PendingInteraction;
	readonly promise: Promise<NativeInteractionResult>;
	readonly resolve: (result: NativeInteractionResult) => void;
	readonly abortListeners: Map<AbortSignal, () => void>;
	settled: boolean;
}

interface SettledRequest {
	readonly kind: RequestKind;
	readonly promise: Promise<NativeInteractionResult>;
}

export class InteractionQueue {
	readonly canUseTool: CanUseTool;
	readonly onElicitation: OnElicitation;

	private readonly activeRequests = new Map<string, ActiveRequest>();
	private readonly settledRequests = new Map<string, SettledRequest>();
	private closedReason: string | undefined;

	constructor() {
		this.canUseTool = (toolName, input, options) => this.enqueueTool(toolName, input, options);
		this.onElicitation = (request, options) => this.enqueueElicitation(request, options);
	}

	get pending(): readonly PendingInteraction[] {
		return [...this.activeRequests.values()].map((active) => active.pending);
	}

	answer(requestId: string, response: InteractionAnswer): boolean {
		const active = this.activeRequests.get(requestId);
		if (!active || active.settled) return false;
		assertInteractionAnswer(response);

		let result: NativeInteractionResult;
		if (active.pending.kind === "permission") {
			if (response.kind !== "permission") return this.rejectResponseType("permission");
			result = this.answerPermission(active.pending, response);
		} else if (active.pending.kind === "question") {
			if (response.kind !== "question") return this.rejectResponseType("question");
			result = this.answerQuestion(active.pending, response);
		} else {
			if (response.kind !== "elicitation") return this.rejectResponseType("elicitation");
			result = validateElicitationResponse(
				active.pending.request,
				active.pending.mode === "form" ? active.pending.form : undefined,
				active.pending.mode === "url" && active.pending.canOpenUrl,
				response.response,
			);
		}

		return this.settle(active, result);
	}

	cancelAll(reason: string): void {
		const cancellation = normalizeReason(reason, "Session closed");
		this.closedReason ??= cancellation;
		for (const active of [...this.activeRequests.values()]) {
			this.cancel(active, cancellation, true);
		}
	}

	private enqueueTool(
		toolName: string,
		input: Record<string, unknown>,
		options: CanUseToolOptions,
	): Promise<PermissionResult | null> {
		const kind = toolName === "AskUserQuestion" ? "question" : "permission";
		if (this.closedReason) return Promise.resolve(denyPermission(options.toolUseID, this.closedReason));
		const existing = this.findExisting(options.requestId, kind, options.signal);
		if (existing) return existing as Promise<PermissionResult>;
		if (this.hasRequestId(options.requestId)) {
			return Promise.resolve(denyPermission(options.toolUseID, "Conflicting native request identifier"));
		}

		const nativePayload: ToolNativePayload = { toolName, input, options };
		if (kind === "question") {
			let questions: AskUserQuestion[];
			try {
				questions = parseAskUserQuestions(input);
			} catch (error) {
				const message = error instanceof Error ? error.message : "AskUserQuestion input is invalid";
				return Promise.resolve(denyPermission(options.toolUseID, message));
			}
			const pending: PendingQuestionRequest = {
				kind: "question",
				requestId: options.requestId,
				nativePayload,
				abort: newAbortState(),
				toolName: "AskUserQuestion",
				toolUseID: options.toolUseID,
				input,
				questions,
				...(options.title === undefined ? {} : { title: options.title }),
				...(options.displayName === undefined ? {} : { displayName: options.displayName }),
				...(options.description === undefined ? {} : { description: options.description }),
			};
			const active = this.createActive(pending);
			this.activeRequests.set(options.requestId, active);
			this.watchAbort(active, options.signal);
			return active.promise as Promise<PermissionResult>;
		}

		const suggestions = options.suggestions ?? [];
		const canAlwaysAllow = suggestions.length > 0 &&
			options.suppressAlwaysAllowRule !== true &&
			options.matchedAskRule === undefined;
		const pending: PendingPermissionRequest = {
			kind: "permission",
			requestId: options.requestId,
			nativePayload,
			abort: newAbortState(),
			toolName,
			toolUseID: options.toolUseID,
			input,
			title: options.title,
			displayName: options.displayName,
			description: options.description,
			decisionReason: options.decisionReason,
			blockedPath: options.blockedPath,
			suggestions,
			canAlwaysAllow,
			defaultToNo: options.defaultToNo === true,
			suppressAlwaysAllowRule: options.suppressAlwaysAllowRule === true,
			...(options.matchedAskRule === undefined ? {} : { matchedAskRule: options.matchedAskRule }),
		};
		const active = this.createActive(pending);
		this.activeRequests.set(options.requestId, active);
		this.watchAbort(active, options.signal);
		return active.promise as Promise<PermissionResult>;
	}

	private enqueueElicitation(
		request: ElicitationRequest,
		options: ElicitationOptions,
	): Promise<ElicitationResult | null> {
		if (this.closedReason) return Promise.resolve({ action: "cancel" });
		const existing = this.findExisting(options.requestId, "elicitation", options.signal);
		if (existing) return existing as Promise<ElicitationResult>;
		if (this.hasRequestId(options.requestId)) {
			return Promise.resolve({ action: "cancel" });
		}

		const nativePayload = { request, options };
		let pending: PendingFormElicitationRequest | PendingUrlElicitationRequest;
		if (request.mode === "url") {
			pending = {
				kind: "elicitation",
				mode: "url",
				requestId: options.requestId,
				nativePayload,
				abort: newAbortState(),
				request,
				...(request.url === undefined ? {} : { url: request.url }),
				canOpenUrl: isHttpElicitationUrl(request.url),
			};
		} else {
			pending = {
				kind: "elicitation",
				mode: "form",
				requestId: options.requestId,
				nativePayload,
				abort: newAbortState(),
				request,
				form: inspectElicitationForm(request.requestedSchema),
			};
		}
		const active = this.createActive(pending);
		this.activeRequests.set(options.requestId, active);
		this.watchAbort(active, options.signal);
		return active.promise as Promise<ElicitationResult>;
	}

	private findExisting(requestId: string, kind: RequestKind, signal: AbortSignal): Promise<NativeInteractionResult> | undefined {
		const active = this.activeRequests.get(requestId);
		if (active) {
			if (active.pending.kind !== kind) return undefined;
			this.watchAbort(active, signal);
			return active.promise;
		}
		const settled = this.settledRequests.get(requestId);
		if (settled?.kind === kind) return settled.promise;
		return undefined;
	}

	private hasRequestId(requestId: string): boolean {
		return this.activeRequests.has(requestId) || this.settledRequests.has(requestId);
	}

	private createActive(pending: PendingInteraction): ActiveRequest {
		let resolve!: (result: NativeInteractionResult) => void;
		const promise = new Promise<NativeInteractionResult>((settle) => {
			resolve = settle;
		});
		return {
			pending,
			promise,
			resolve,
			abortListeners: new Map(),
			settled: false,
		};
	}

	private watchAbort(active: ActiveRequest, signal: AbortSignal): void {
		if (active.settled || active.abortListeners.has(signal)) return;
		if (signal.aborted) {
			this.cancel(active, abortReason(signal.reason), true);
			return;
		}
		const listener = () => this.cancel(active, abortReason(signal.reason), true);
		signal.addEventListener("abort", listener, { once: true });
		active.abortListeners.set(signal, () => signal.removeEventListener("abort", listener));
	}

	private answerPermission(pending: PendingPermissionRequest, answer: PermissionAnswer): PermissionResult {
		if (answer.action === "allow-once") {
			return {
				behavior: "allow",
				toolUseID: pending.toolUseID,
				decisionClassification: "user_temporary",
			};
		}
		if (answer.action === "allow-suggested") {
			if (!pending.canAlwaysAllow || pending.suggestions.length === 0) {
				throw new InteractionValidationError("Suggested permission updates are unavailable for this request");
			}
			return {
				behavior: "allow",
				toolUseID: pending.toolUseID,
				updatedPermissions: pending.suggestions as PermissionUpdate[],
				decisionClassification: "user_permanent",
			};
		}
		if (answer.action === "deny") {
			return denyPermission(pending.toolUseID, answer.message);
		}
		if (answer.action === "cancel") {
			return denyPermission(pending.toolUseID, answer.reason ?? "Permission request cancelled");
		}
		throw new InteractionValidationError("Permission response must allow once, allow with suggested updates, deny, or cancel");
	}

	private answerQuestion(pending: PendingQuestionRequest, answer: QuestionAnswer): PermissionResult {
		if ("action" in answer) {
			if (answer.action !== "cancel" || "answers" in answer) {
				throw new InteractionValidationError("Question response only supports an explicit cancel action");
			}
			return denyPermission(pending.toolUseID, answer.reason ?? "Question request cancelled");
		}
		const answers = validateQuestionAnswers(pending.questions, answer.answers);
		return {
			behavior: "allow",
			toolUseID: pending.toolUseID,
			updatedInput: { ...pending.input, answers },
			decisionClassification: "user_temporary",
		};
	}

	private rejectResponseType(expected: string): never {
		throw new InteractionValidationError(`Response type does not match the pending ${expected} request`);
	}

	private cancel(active: ActiveRequest, reason: string, aborted: boolean): void {
		if (active.settled) return;
		if (aborted) {
			const state = active.pending.abort as { aborted: boolean; reason?: string };
			state.aborted = true;
			state.reason = reason;
		}
		const result = active.pending.kind === "elicitation"
			? { action: "cancel" as const }
			: denyPermission(active.pending.toolUseID, reason);
		this.settle(active, result);
	}

	private settle(active: ActiveRequest, result: NativeInteractionResult): boolean {
		if (active.settled || this.activeRequests.get(active.pending.requestId) !== active) return false;
		active.settled = true;
		this.activeRequests.delete(active.pending.requestId);
		for (const removeListener of active.abortListeners.values()) removeListener();
		active.abortListeners.clear();
		this.settledRequests.set(active.pending.requestId, {
			kind: active.pending.kind,
			promise: active.promise,
		});
		active.resolve(result);
		return true;
	}
}

function denyPermission(toolUseID: string, message?: string): PermissionResult {
	return {
		behavior: "deny",
		message: normalizeReason(message, "Permission denied by user"),
		toolUseID,
		decisionClassification: "user_reject",
	};
}

function newAbortState(): { aborted: boolean; reason?: string } {
	return { aborted: false };
}

function abortReason(reason: unknown): string {
	if (reason instanceof Error) return normalizeReason(reason.message, "Request aborted");
	if (typeof reason === "string") return normalizeReason(reason, "Request aborted");
	return "Request aborted";
}

function normalizeReason(reason: string | undefined, fallback: string): string {
	return typeof reason === "string" && reason.trim().length > 0 ? reason : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertInteractionAnswer(value: unknown): asserts value is InteractionAnswer {
	if (!isRecord(value) || (value.kind !== "permission" && value.kind !== "question" && value.kind !== "elicitation")) {
		throw new InteractionValidationError("An interaction response must include a valid request kind");
	}
}
