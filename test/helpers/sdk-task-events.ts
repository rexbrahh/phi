import type {
	SDKBackgroundTasksChangedMessage,
	SDKCompactBoundaryMessage,
	SDKConversationResetMessage,
	SDKMessage,
	SDKModelRefusalFallbackMessage,
	SDKSessionStateChangedMessage,
	SDKStatusMessage,
	SDKTaskNotificationMessage,
	SDKTaskStartedMessage,
	SDKTaskUpdatedMessage,
	SDKToolProgressMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { nativeUuid } from "./sdk-event-core.js";

const SESSION_ID = "session-1";

export function taskStarted(options: {
	envelopeId: string;
	taskId: string;
	runId?: string;
	toolUseId?: string;
	description?: string;
	taskType?: string;
	ambient?: boolean;
	isBackgrounded?: boolean;
}): SDKTaskStartedMessage {
	return {
		type: "system",
		subtype: "task_started",
		task_id: options.taskId,
		run_id: options.runId,
		tool_use_id: options.toolUseId,
		description: options.description ?? "task",
		task_type: options.taskType,
		ambient: options.ambient,
		is_backgrounded: options.isBackgrounded,
		uuid: nativeUuid(options.envelopeId),
		session_id: SESSION_ID,
	};
}

export function taskUpdated(options: {
	envelopeId: string;
	taskId: string;
	runId?: string;
	status: "pending" | "running" | "completed" | "failed" | "killed" | "paused";
}): SDKTaskUpdatedMessage {
	return {
		type: "system",
		subtype: "task_updated",
		task_id: options.taskId,
		run_id: options.runId,
		patch: { status: options.status },
		uuid: nativeUuid(options.envelopeId),
		session_id: SESSION_ID,
	};
}

export function taskNotification(options: {
	envelopeId: string;
	taskId: string;
	runId?: string;
	toolUseId?: string;
	status: "completed" | "failed" | "stopped";
	resourceLinks?: SDKTaskNotificationMessage["resource_links"];
}): SDKTaskNotificationMessage {
	return {
		type: "system",
		subtype: "task_notification",
		task_id: options.taskId,
		run_id: options.runId,
		tool_use_id: options.toolUseId,
		status: options.status,
		output_file: `/tmp/${options.taskId}.txt`,
		summary: "task finished",
		resource_links: options.resourceLinks,
		uuid: nativeUuid(options.envelopeId),
		session_id: SESSION_ID,
	};
}

export function toolProgressMessage(options: {
	envelopeId: string;
	toolUseId: string;
	toolName: string;
}): SDKToolProgressMessage {
	return {
		type: "tool_progress",
		tool_use_id: options.toolUseId,
		tool_name: options.toolName,
		parent_tool_use_id: null,
		elapsed_time_seconds: 1,
		uuid: nativeUuid(options.envelopeId),
		session_id: SESSION_ID,
	};
}

export function backgroundTasksChanged(options: {
	envelopeId: string;
	tasks: SDKBackgroundTasksChangedMessage["tasks"];
}): SDKBackgroundTasksChangedMessage {
	return {
		type: "system",
		subtype: "background_tasks_changed",
		tasks: options.tasks,
		uuid: nativeUuid(options.envelopeId),
		session_id: SESSION_ID,
	};
}

export function sessionStateChanged(
	state: SDKSessionStateChangedMessage["state"],
	envelopeId: string,
): SDKSessionStateChangedMessage {
	return {
		type: "system",
		subtype: "session_state_changed",
		state,
		uuid: nativeUuid(envelopeId),
		session_id: SESSION_ID,
	};
}

export function sdkStatus(status: SDKStatusMessage["status"], envelopeId: string): SDKStatusMessage {
	return {
		type: "system",
		subtype: "status",
		status,
		uuid: nativeUuid(envelopeId),
		session_id: SESSION_ID,
	};
}

export function compactBoundary(envelopeId: string): SDKCompactBoundaryMessage {
	return {
		type: "system",
		subtype: "compact_boundary",
		compact_metadata: {
			trigger: "manual",
			pre_tokens: 100,
			preserved_messages: { anchor_uuid: nativeUuid("anchor"), uuids: [nativeUuid("preserved")] },
		},
		uuid: nativeUuid(envelopeId),
		session_id: SESSION_ID,
	};
}

export function refusalFallbackMessage(options: {
	envelopeId: string;
	retractedMessageIds: string[];
}): SDKModelRefusalFallbackMessage {
	return {
		type: "system",
		subtype: "model_refusal_fallback",
		trigger: "refusal",
		direction: "retry",
		original_model: "claude-sonnet-4-5-20250929",
		fallback_model: "claude-opus-4-1-20250805",
		request_id: null,
		retracted_message_uuids: options.retractedMessageIds.map(nativeUuid),
		content: "retrying on fallback model",
		uuid: nativeUuid(options.envelopeId),
		session_id: SESSION_ID,
	};
}

export function conversationReset(envelopeId: string, userMessageUuid?: string): SDKConversationResetMessage {
	return {
		type: "conversation_reset",
		uuid: nativeUuid(envelopeId),
		new_conversation_id: nativeUuid(`${envelopeId}-new`),
		session_id: SESSION_ID,
		trigger: "clear",
		user_message_uuid: userMessageUuid ? nativeUuid(userMessageUuid) : undefined,
	};
}

export function asSdkMessage(message: SDKMessage): SDKMessage {
	return message;
}
