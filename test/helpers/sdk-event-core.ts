import type {
	SDKAssistantMessage,
	SDKMessage,
	SDKPartialAssistantMessage,
	SDKResultMessage,
	SDKUserMessage,
	SDKUserMessageReplay,
} from "@anthropic-ai/claude-agent-sdk";

const SESSION_ID = "session-1";

export function nativeUuid(label: string): SDKAssistantMessage["uuid"] {
	let hash = 0n;
	for (const character of label) {
		hash = ((hash * 131n) + BigInt(character.codePointAt(0) ?? 0)) & 0xffffffffffffn;
	}
	return `00000000-0000-4000-8000-${hash.toString(16).padStart(12, "0")}` as SDKAssistantMessage["uuid"];
}

export type AssistantContent = SDKAssistantMessage["message"]["content"][number];
export type StreamEvent = SDKPartialAssistantMessage["event"];

export function textBlock(text: string): AssistantContent {
	return { type: "text", text, citations: [] };
}

export function toolUseBlock(
	id: string,
	name: string,
	input: Record<string, unknown> = {},
): AssistantContent {
	return { type: "tool_use", id, name, input };
}

export function assistantMessage(options: {
	envelopeId: string;
	modelMessageId: string;
	content: AssistantContent[];
	parentToolUseId?: string | null;
	agentId?: string;
	aborted?: boolean;
	supersedes?: string[];
	userMessageUuid?: string;
	userMessageUuids?: string[];
}): SDKAssistantMessage {
	return {
		type: "assistant",
		uuid: nativeUuid(options.envelopeId),
		session_id: SESSION_ID,
		parent_tool_use_id: options.parentToolUseId ?? null,
		agent_id: options.agentId,
		aborted: options.aborted ? true : undefined,
		supersedes: options.supersedes?.map(nativeUuid),
		user_message_uuid: options.userMessageUuid ? nativeUuid(options.userMessageUuid) : undefined,
		user_message_uuids: options.userMessageUuids?.map(nativeUuid),
		message: {
			id: options.modelMessageId,
			container: null,
			content: options.content,
			context_management: null,
			diagnostics: null,
			model: "claude-sonnet-4-5-20250929",
			role: "assistant",
			stop_details: null,
			stop_reason: options.aborted ? null : "end_turn",
			stop_sequence: null,
			type: "message",
			usage: {
				cache_creation: null,
				cache_creation_input_tokens: null,
				cache_read_input_tokens: null,
				fallback_credit: null,
				inference_geo: null,
				input_tokens: 0,
				iterations: null,
				output_tokens: 0,
				output_tokens_details: null,
				server_tool_use: null,
				service_tier: "standard",
				speed: "standard",
			},
		},
	};
}

export function streamEvent(
	options: { envelopeId: string; event: StreamEvent; parentToolUseId?: string | null },
): SDKPartialAssistantMessage {
	return {
		type: "stream_event",
		uuid: nativeUuid(options.envelopeId),
		session_id: SESSION_ID,
		parent_tool_use_id: options.parentToolUseId ?? null,
		event: options.event,
	};
}

export function textStreamStart(modelMessageId: string, index = 0): StreamEvent[] {
	const message = assistantMessage({
		envelopeId: `frame-${modelMessageId}`,
		modelMessageId,
		content: [],
	}).message;
	return [
		{ type: "message_start", message },
		{
			type: "content_block_start",
			index,
			content_block: { type: "text", text: "", citations: [] },
		},
	];
}

export function textDelta(index: number, text: string): StreamEvent {
	return { type: "content_block_delta", index, delta: { type: "text_delta", text } };
}

export function toolJsonStart(options: {
	modelMessageId: string;
	toolUseId: string;
	toolName: string;
	index?: number;
}): StreamEvent[] {
	const message = assistantMessage({
		envelopeId: `frame-${options.modelMessageId}`,
		modelMessageId: options.modelMessageId,
		content: [],
	}).message;
	return [
		{ type: "message_start", message },
		{
			type: "content_block_start",
			index: options.index ?? 0,
			content_block: {
				type: "tool_use",
				id: options.toolUseId,
				name: options.toolName,
				input: {},
			},
		},
	];
}

export function inputJsonDelta(index: number, partialJson: string): StreamEvent {
	return {
		type: "content_block_delta",
		index,
		delta: { type: "input_json_delta", partial_json: partialJson },
	};
}

export function toolResultMessage(options: {
	envelopeId: string;
	toolUseId: string;
	text: string;
	toolUseResult?: unknown;
	error?: boolean;
}): SDKUserMessage {
	return {
		type: "user",
		uuid: nativeUuid(options.envelopeId),
		session_id: SESSION_ID,
		parent_tool_use_id: null,
		tool_use_result: options.toolUseResult,
		message: {
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: options.toolUseId,
					content: options.text,
					is_error: options.error ?? false,
				},
			],
		},
	};
}

export function userTextMessage(options: {
	inputUuid: string;
	text: string;
}): SDKUserMessage {
	return {
		type: "user",
		uuid: nativeUuid(options.inputUuid),
		session_id: SESSION_ID,
		parent_tool_use_id: null,
		message: { role: "user", content: options.text },
	};
}

export function replayUserMessage(options: {
	inputUuid: string;
	text: string;
}): SDKUserMessageReplay {
	return {
		type: "user",
		uuid: nativeUuid(options.inputUuid),
		session_id: SESSION_ID,
		parent_tool_use_id: null,
		isReplay: true,
		message: { role: "user", content: options.text },
	};
}

export function resultMessage(options: {
	envelopeId: string;
	cost?: number;
	userMessageUuid?: string;
	userMessageUuids?: string[];
	inputTokens?: number;
	outputTokens?: number;
	modelCost?: number;
}): SDKResultMessage {
	const result: SDKResultMessage = {
		type: "result",
		subtype: "success",
		duration_ms: 1,
		duration_api_ms: 1,
		is_error: false,
		num_turns: 1,
		result: "complete",
		stop_reason: "end_turn",
		total_cost_usd: options.cost ?? 0,
		usage: {
			cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
			cache_creation_input_tokens: 0,
			cache_read_input_tokens: 0,
			fallback_credit: null,
			inference_geo: "us",
			input_tokens: options.inputTokens ?? 0,
			iterations: [],
			output_tokens: options.outputTokens ?? 0,
			output_tokens_details: { thinking_tokens: 0 },
			server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
			service_tier: "standard",
			speed: "standard",
		},
		modelUsage: {
			"claude-sonnet-4-5-20250929": {
				inputTokens: options.inputTokens ?? 0,
				outputTokens: options.outputTokens ?? 0,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				webSearchRequests: 0,
				costUSD: options.modelCost ?? 0,
				contextWindow: 200_000,
				maxOutputTokens: 64_000,
			},
		},
		permission_denials: [],
		user_message_uuid: options.userMessageUuid ? nativeUuid(options.userMessageUuid) : undefined,
		user_message_uuids: options.userMessageUuids?.map(nativeUuid),
		uuid: nativeUuid(options.envelopeId),
		session_id: SESSION_ID,
	};
	if (options.cost === undefined) delete (result as { total_cost_usd?: number }).total_cost_usd;
	return result;
}
