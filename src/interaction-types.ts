import type {
	ElicitationRequest,
	ElicitationResult,
	Options,
	PermissionUpdate,
} from "@anthropic-ai/claude-agent-sdk";
import type { ElicitationFormSupport } from "./elicitation-validation.js";
import type { AskUserQuestion, QuestionValue } from "./question-validation.js";

export type CanUseTool = NonNullable<Options["canUseTool"]>;
export type OnElicitation = NonNullable<Options["onElicitation"]>;
export type CanUseToolOptions = Parameters<CanUseTool>[2];
export type ElicitationOptions = Parameters<OnElicitation>[1];

export interface ToolNativePayload {
	toolName: string;
	input: Record<string, unknown>;
	options: CanUseToolOptions;
}

export interface ElicitationNativePayload {
	request: ElicitationRequest;
	options: ElicitationOptions;
}

export interface RequestAbortState {
	readonly aborted: boolean;
	readonly reason?: string;
}

interface PendingRequestBase<TNativePayload> {
	readonly requestId: string;
	readonly nativePayload: TNativePayload;
	readonly abort: RequestAbortState;
}

export interface PendingPermissionRequest extends PendingRequestBase<ToolNativePayload> {
	readonly kind: "permission";
	readonly toolName: string;
	readonly toolUseID: string;
	readonly input: Record<string, unknown>;
	readonly title?: string;
	readonly displayName?: string;
	readonly description?: string;
	readonly decisionReason?: string;
	readonly blockedPath?: string;
	readonly suggestions: readonly PermissionUpdate[];
	readonly canAlwaysAllow: boolean;
	readonly defaultToNo: boolean;
	readonly suppressAlwaysAllowRule: boolean;
	readonly matchedAskRule?: CanUseToolOptions["matchedAskRule"];
}

export interface PendingQuestionRequest extends PendingRequestBase<ToolNativePayload> {
	readonly kind: "question";
	readonly toolName: "AskUserQuestion";
	readonly toolUseID: string;
	readonly input: Record<string, unknown>;
	readonly questions: readonly AskUserQuestion[];
	readonly title?: string;
	readonly displayName?: string;
	readonly description?: string;
}

export interface PendingFormElicitationRequest extends PendingRequestBase<ElicitationNativePayload> {
	readonly kind: "elicitation";
	readonly mode: "form";
	readonly request: ElicitationRequest;
	readonly form: ElicitationFormSupport;
}

export interface PendingUrlElicitationRequest extends PendingRequestBase<ElicitationNativePayload> {
	readonly kind: "elicitation";
	readonly mode: "url";
	readonly request: ElicitationRequest;
	readonly url?: string;
	readonly canOpenUrl: boolean;
}

export type PendingInteraction =
	| PendingPermissionRequest
	| PendingQuestionRequest
	| PendingFormElicitationRequest
	| PendingUrlElicitationRequest;

export type PermissionAnswer =
	| { kind: "permission"; action: "allow-once" }
	| { kind: "permission"; action: "allow-suggested" }
	| { kind: "permission"; action: "deny"; message?: string }
	| { kind: "permission"; action: "cancel"; reason?: string };

export type QuestionAnswer =
	| { kind: "question"; answers: Record<string, QuestionValue> }
	| { kind: "question"; action: "cancel"; reason?: string };

export interface ElicitationAnswer {
	kind: "elicitation";
	response: ElicitationResult;
}

export type InteractionAnswer = PermissionAnswer | QuestionAnswer | ElicitationAnswer;
