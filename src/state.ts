import type {
	SDKAssistantMessage,
	SDKMessage,
	SDKResultMessage,
	SDKTaskNotificationMessage,
	SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
	applyAssistantMessage,
	applyResultMessage,
	applyStreamEvent,
	applyUserMessage,
	resetConversation,
} from "./state-conversation.js";
import { markConsumedInputs } from "./state-inputs.js";
import { applySystemEvent } from "./state-tasks.js";
import { getEnvelopeId } from "./state-utils.js";

export { markInputsDeliveryUnknown, recordSubmittedInput } from "./state-inputs.js";

type AssistantContentBlock = SDKAssistantMessage["message"]["content"][number];
type UserContentBlock = Exclude<SDKUserMessage["message"]["content"], string>[number];

export type ConversationContent = AssistantContentBlock | UserContentBlock | string;

export interface ConversationBlock {
	id: string;
	envelopeId: string;
	messageId: string;
	role: "assistant" | "user";
	content: ConversationContent;
	aborted: boolean;
}

export interface ProvisionalBlock {
	id: string;
	messageId: string;
	index: number;
	contentType: string;
	toolUseId?: string;
	text: string;
	partialInputJson: string;
	toolInput?: Record<string, unknown>;
	closed: boolean;
}

export type ToolExecutionState =
	| "not_started"
	| "requested"
	| "running"
	| "completed"
	| "failed"
	| "stopped"
	| "permission_denied";

export interface ToolReceipt {
	toolUseId: string;
	toolName: string;
	inputComplete: boolean;
	input?: Record<string, unknown>;
	partialInputJson?: string;
	executionState: ToolExecutionState;
	sourceEnvelopeIds: string[];
	resultEnvelopeId?: string;
	resultPreview?: string;
	resultIsError?: boolean;
	resourceLinks?: SDKTaskNotificationMessage["resource_links"];
	workflowRunId?: string;
	taskId?: string;
}

export interface ChildMessagePreview {
	groupId: string;
	sourceEnvelopeId: string;
	messageId: string;
	text: string;
	toolUseIds: string[];
}

export interface TaskRecord {
	taskId: string;
	taskRunId?: string;
	workflowRunId?: string;
	taskType?: string;
	toolUseId?: string;
	subagentType?: string;
	workflowName?: string;
	spawnDepth?: number;
	description?: string;
	status: "pending" | "running" | "completed" | "failed" | "killed" | "paused" | "stopped";
	ambient: boolean;
	isBackgrounded?: boolean;
	skipTranscript?: boolean;
	parentTaskId?: string;
	progressSummary?: string;
	lastToolName?: string;
	usage?: SDKTaskNotificationMessage["usage"];
	resourceLinks?: SDKTaskNotificationMessage["resource_links"];
	outputFile?: string;
	error?: string;
}

export interface InputReceipt {
	uuid: string;
	status: "submitted" | "received" | "consumed" | "delivery_unknown";
}

export interface EffectiveStatus {
	foreground: "idle" | "running" | "requires_action";
	phase: "compacting" | "requesting" | null;
	busyBackgroundTaskCount: number;
	lastResult?: { envelopeId: string; subtype: SDKResultMessage["subtype"] };
}

export interface UsageSnapshot {
	envelopeId: string;
	totalCostUsd: number | null;
	modelUsage: SDKResultMessage["modelUsage"] | null;
	mainLoopTurnUsage: SDKResultMessage["usage"] | null;
}

export interface StateNotice {
	id: string;
	type: string;
	subtype?: string;
	text: string;
	sourceMessage: SDKMessage;
}

export interface PhiState {
	cwd: string;
	conversationId?: string;
	conversationBlocks: ConversationBlock[];
	provisionalBlocks: Map<string, ProvisionalBlock>;
	toolReceipts: Map<string, ToolReceipt>;
	childMessages: Map<string, ChildMessagePreview>;
	tasks: Map<string, TaskRecord>;
	liveBackgroundTaskIds: Set<string>;
	inputReceipts: Map<string, InputReceipt>;
	effectiveStatus: EffectiveStatus;
	usage: UsageSnapshot | null;
	notices: StateNotice[];
	seenEnvelopeIds: Set<string>;
	activeStreamMessageId?: string;
}

export function createState(cwd: string): PhiState {
	return {
		cwd,
		conversationBlocks: [],
		provisionalBlocks: new Map(),
		toolReceipts: new Map(),
		childMessages: new Map(),
		tasks: new Map(),
		liveBackgroundTaskIds: new Set(),
		inputReceipts: new Map(),
		effectiveStatus: {
			foreground: "idle",
			phase: null,
			busyBackgroundTaskCount: 0,
		},
		usage: null,
		notices: [],
		seenEnvelopeIds: new Set(),
	};
}
export function applySdkMessage(state: PhiState, message: SDKMessage): void {
	const envelopeId = getEnvelopeId(message);
	if (envelopeId && state.seenEnvelopeIds.has(envelopeId)) return;
	if (envelopeId) state.seenEnvelopeIds.add(envelopeId);

	if (message.type === "assistant") {
		applyAssistantMessage(state, message);
		return;
	}
	if (message.type === "stream_event") {
		applyStreamEvent(state, message);
		return;
	}
	if (message.type === "user") {
		applyUserMessage(state, message);
		return;
	}
	if (message.type === "result") {
		applyResultMessage(state, message);
		return;
	}
	if (message.type === "conversation_reset") {
		markConsumedInputs(state, message.user_message_uuid);
		resetConversation(state, message);
		return;
	}
	if (message.type === "system" && message.subtype === "session_state_changed") {
		state.effectiveStatus.foreground = message.state;
		return;
	}
	if (message.type === "system" && message.subtype === "status") {
		state.effectiveStatus.phase = message.status;
		return;
	}

	applySystemEvent(state, message);
}
