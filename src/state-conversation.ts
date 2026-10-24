import type {
	SDKAssistantMessage,
	SDKMessage,
	SDKPartialAssistantMessage,
	SDKResultMessage,
	SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { PhiState, ProvisionalBlock, ToolReceipt } from "./state.js";
import {
	addUnique,
	boundedPreview,
	getContentType,
	getDisplayText,
	getObjectProperty,
	getProperty,
	getStringProperty,
	parseInputObject,
	previewUnknown,
} from "./state-utils.js";
import {
	attachWorkflowResult,
	getOrCreateToolReceipt,
	getStructuredWorkflowResult,
	hasToolResultError,
	hasWorkflowError,
	isDetachedToolCall,
	readToolResultIds,
	readToolResultPreview,
	readUserText,
} from "./state-tools.js";
import { markConsumedInputs } from "./state-inputs.js";

type AssistantContentBlock = SDKAssistantMessage["message"]["content"][number];

export function applyAssistantMessage(state: PhiState, message: SDKAssistantMessage): void {
	removeSupersededMessages(state, message.supersedes ?? []);
	markConsumedInputs(state, message.user_message_uuid, message.user_message_uuids);

	const content = message.message.content;
	const groupId = message.agent_id ?? message.parent_tool_use_id ?? undefined;
	const childText: string[] = [];
	const childToolUseIds: string[] = [];

	for (let index = 0; index < content.length; index += 1) {
		const block = content[index];
		if (!block) continue;
		const contentType = getContentType(block);
		const toolUseId = contentType === "tool_use" ? getStringProperty(block, "id") : undefined;
		const provisional = findProvisionalBlock(state, message.message.id, index, contentType, toolUseId, block);
		if (provisional) state.provisionalBlocks.delete(provisional.id);

		if (contentType === "tool_use" && toolUseId) {
			const toolName = getStringProperty(block, "name") ?? "unknown";
			const input = getObjectProperty(block, "input");
			const prior = state.toolReceipts.get(toolUseId);
			const receipt: ToolReceipt = {
				toolUseId,
				toolName,
				inputComplete: !message.aborted,
				executionState: message.aborted ? "not_started" : "requested",
				sourceEnvelopeIds: addUnique(prior?.sourceEnvelopeIds ?? [], message.uuid),
			};
			if (input) receipt.input = input;
			if (message.aborted && prior?.partialInputJson) receipt.partialInputJson = prior.partialInputJson;
			state.toolReceipts.set(toolUseId, receipt);
			if (groupId) childToolUseIds.push(toolUseId);
		}

		if (groupId) {
			const blockText = getDisplayText(block);
			if (blockText) childText.push(blockText);
			continue;
		}

		state.conversationBlocks.push({
			id: `${message.uuid}:${index}`,
			envelopeId: message.uuid,
			messageId: message.message.id,
			role: "assistant",
			content: block,
			aborted: message.aborted === true,
		});
	}

	if (groupId) {
		state.childMessages.set(groupId, {
			groupId,
			sourceEnvelopeId: message.uuid,
			messageId: message.message.id,
			text: boundedPreview(childText.join("\n")),
			toolUseIds: childToolUseIds,
		});
	}
}

export function applyStreamEvent(state: PhiState, message: SDKPartialAssistantMessage): void {
	if (message.parent_tool_use_id !== null) return;
	const event = message.event;

	if (event.type === "message_start") {
		state.activeStreamMessageId = event.message.id;
		return;
	}
	if (event.type === "content_block_start") {
		const messageId = state.activeStreamMessageId;
		if (!messageId) return;
		const contentType = getContentType(event.content_block);
		const toolUseId = contentType === "tool_use" ? getStringProperty(event.content_block, "id") : undefined;
		const id = `${messageId}:${event.index}`;
		const provisional: ProvisionalBlock = {
			id,
			messageId,
			index: event.index,
			contentType,
			text: getDisplayText(event.content_block),
			partialInputJson: "",
			toolInput: getObjectProperty(event.content_block, "input"),
			closed: false,
		};
		if (toolUseId) provisional.toolUseId = toolUseId;
		state.provisionalBlocks.set(id, provisional);
		if (toolUseId) {
			const toolName = getStringProperty(event.content_block, "name") ?? "unknown";
			state.toolReceipts.set(toolUseId, {
				toolUseId,
				toolName,
				inputComplete: false,
				executionState: "not_started",
				sourceEnvelopeIds: [message.uuid],
			});
		}
		return;
	}
	if (event.type === "content_block_delta") {
		const messageId = state.activeStreamMessageId;
		const provisional = messageId ? state.provisionalBlocks.get(`${messageId}:${event.index}`) : undefined;
		if (!provisional) return;
		if (event.delta.type === "text_delta") {
			provisional.text = boundedPreview(provisional.text + event.delta.text);
		} else if (event.delta.type === "thinking_delta") {
			provisional.text = boundedPreview(provisional.text + event.delta.thinking);
		} else if (event.delta.type === "input_json_delta") {
			provisional.partialInputJson = boundedPreview(provisional.partialInputJson + event.delta.partial_json);
			if (provisional.toolUseId) {
				const receipt = state.toolReceipts.get(provisional.toolUseId);
				if (receipt) receipt.partialInputJson = provisional.partialInputJson;
			}
		}
		return;
	}
	if (event.type === "content_block_stop") {
		const messageId = state.activeStreamMessageId;
		const provisional = messageId ? state.provisionalBlocks.get(`${messageId}:${event.index}`) : undefined;
		if (provisional?.toolUseId) {
			const receipt = state.toolReceipts.get(provisional.toolUseId);
			const parsedInput = provisional.partialInputJson
				? parseInputObject(provisional.partialInputJson)
				: provisional.toolInput;
			if (receipt && parsedInput) {
				receipt.input = parsedInput;
				receipt.inputComplete = true;
				if (receipt.executionState === "not_started") receipt.executionState = "requested";
			}
		}
		if (provisional && (provisional.contentType === "text" || provisional.contentType === "thinking") && !provisional.text) {
			state.provisionalBlocks.delete(provisional.id);
		} else if (provisional) {
			provisional.closed = true;
		}
		return;
	}
	if (event.type === "message_stop" && state.activeStreamMessageId) {
		state.activeStreamMessageId = undefined;
	}
}

export function applyUserMessage(state: PhiState, message: SDKUserMessage): void {
	if (message.uuid && !("isReplay" in message && message.isReplay)) {
		const receipt = state.inputReceipts.get(message.uuid);
		if (receipt && receipt.status === "submitted") receipt.status = "received";
	}
	const toolResultIds = readToolResultIds(message);
	const detached = isDetachedToolCall(message.tool_use_result);
	const structuredPreview = message.tool_use_result === undefined ? undefined : previewUnknown(message.tool_use_result);
	const resultPreview = readToolResultPreview(message);

	for (const toolUseId of toolResultIds) {
		const receipt = getOrCreateToolReceipt(state, toolUseId);
		receipt.sourceEnvelopeIds = addUnique(receipt.sourceEnvelopeIds, message.uuid ?? "");
		receipt.resultEnvelopeId = message.uuid;
		if (detached) {
			receipt.executionState = "running";
			continue;
		}
		const structured = getStructuredWorkflowResult(message.tool_use_result);
		const failed = hasToolResultError(message, toolUseId) ||
			(structured !== undefined && hasWorkflowError(message.tool_use_result));
		if (structured) {
			attachWorkflowResult(state, receipt, structured);
			if (failed) {
				const task = state.tasks.get(structured.taskId);
				if (task) {
					task.status = "failed";
					const error = getProperty(message.tool_use_result, "error");
					if (typeof error === "string") task.error = error;
				}
			}
		}
		receipt.executionState = failed ? "failed" : "completed";
		receipt.resultIsError = failed;
		receipt.resultPreview = structuredPreview ?? resultPreview;
	}

	if (toolResultIds.length > 0 || message.tool_use_result !== undefined) return;
	if (message.parent_tool_use_id !== null || message.agent_id) {
		const groupId = message.agent_id ?? message.parent_tool_use_id ?? "unknown-child";
		state.childMessages.set(groupId, {
			groupId,
			sourceEnvelopeId: message.uuid ?? "",
			messageId: message.uuid ?? "",
			text: boundedPreview(readUserText(message)),
			toolUseIds: [],
		});
		return;
	}

	const content = message.message.content;
	if (typeof content === "string") {
		state.conversationBlocks.push({
			id: message.uuid ?? `user:${state.conversationBlocks.length}`,
			envelopeId: message.uuid ?? "",
			messageId: message.uuid ?? "",
			role: "user",
			content,
			aborted: false,
		});
		return;
	}
	for (let index = 0; index < content.length; index += 1) {
		const block = content[index];
		if (!block || getContentType(block) === "tool_result") continue;
		state.conversationBlocks.push({
			id: `${message.uuid ?? "user"}:${index}`,
			envelopeId: message.uuid ?? "",
			messageId: message.uuid ?? "",
			role: "user",
			content: block,
			aborted: false,
		});
	}
}

export function applyResultMessage(state: PhiState, message: SDKResultMessage): void {
	markConsumedInputs(state, message.user_message_uuid, message.user_message_uuids);
	const cost = (message as SDKResultMessage & { total_cost_usd?: unknown }).total_cost_usd;
	state.usage = {
		envelopeId: message.uuid,
		totalCostUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
		modelUsage: message.modelUsage ?? null,
		mainLoopTurnUsage: message.usage ?? null,
	};
	state.effectiveStatus.lastResult = { envelopeId: message.uuid, subtype: message.subtype };
}

export function resetConversation(state: PhiState, message: Extract<SDKMessage, { type: "conversation_reset" }>): void {
	state.conversationId = message.new_conversation_id;
	state.conversationBlocks.length = 0;
	state.provisionalBlocks.clear();
	state.toolReceipts.clear();
	state.childMessages.clear();
	state.notices.length = 0;
	state.activeStreamMessageId = undefined;
	if (message.trigger === "clear") state.usage = null;
}

export function removeSupersededMessages(state: PhiState, envelopeIds: readonly string[]): void {
	if (envelopeIds.length === 0) return;
	const superseded = new Set(envelopeIds);
	state.conversationBlocks = state.conversationBlocks.filter((block) => !superseded.has(block.envelopeId));
	for (const [groupId, child] of state.childMessages) {
		if (superseded.has(child.sourceEnvelopeId)) state.childMessages.delete(groupId);
	}
	for (const [toolUseId, receipt] of state.toolReceipts) {
		if (receipt.sourceEnvelopeIds.some((id) => superseded.has(id))) state.toolReceipts.delete(toolUseId);
	}
}

export function findProvisionalBlock(
	state: PhiState,
	messageId: string,
	index: number,
	contentType: string,
	toolUseId?: string,
	finalBlock?: AssistantContentBlock,
): ProvisionalBlock | undefined {
	const candidates = [...state.provisionalBlocks.values()]
		.filter((block) => block.messageId === messageId && block.contentType === contentType)
		.filter((block) => !toolUseId || block.toolUseId === toolUseId)
		.sort((left, right) => left.index - right.index);
	const finalText = finalBlock ? getDisplayText(finalBlock) : "";
	const sequenceMatch = candidates.find((block) => block.index === index);
	if (sequenceMatch && (sequenceMatch.text.length > 0 || !finalText)) return sequenceMatch;
	if (finalText) {
		const matchingText = candidates.find(
			(block) => block.text.length > 0 && finalText.startsWith(block.text),
		);
		if (matchingText) return matchingText;
	}
	return sequenceMatch ?? candidates[0];
}
