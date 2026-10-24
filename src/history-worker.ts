import { parentPort, workerData } from "node:worker_threads";
import type {
	GetSessionMessagesOptions,
	GetSubagentMessagesOptions,
	ListSessionsOptions,
	ListSubagentsOptions,
} from "@anthropic-ai/claude-agent-sdk";

export type HistoryOperation =
	| { kind: "list"; options: ListSessionsOptions }
	| { kind: "messages"; sessionId: string; options: GetSessionMessagesOptions }
	| { kind: "agents"; sessionId: string; options: ListSubagentsOptions }
	| {
			kind: "agentMessages";
			sessionId: string;
			agentId: string;
			options: GetSubagentMessagesOptions;
	  };

export interface HistoryRequest {
	id: number;
	operation: HistoryOperation;
}

export type HistoryResponse =
	| { id: number; ok: true; value: unknown }
	| { id: number; ok: false; error: { name: string; message: string } };

interface WorkerData {
	configRoot?: unknown;
}

interface HistorySdk {
	listSessions(options: ListSessionsOptions): Promise<unknown>;
	getSessionMessages(sessionId: string, options: GetSessionMessagesOptions): Promise<unknown>;
	listSubagents(sessionId: string, options: ListSubagentsOptions): Promise<unknown>;
	getSubagentMessages(
		sessionId: string,
		agentId: string,
		options: GetSubagentMessagesOptions,
	): Promise<unknown>;
}

function isHistoryOperation(value: unknown): value is HistoryOperation {
	if (typeof value !== "object" || value === null || !("kind" in value)) return false;
	const kind = value.kind;
	return kind === "list" || kind === "messages" || kind === "agents" || kind === "agentMessages";
}

function errorResponse(id: number, error: unknown): HistoryResponse {
	if (error instanceof Error) {
		return { id, ok: false, error: { name: error.name, message: error.message } };
	}
	return { id, ok: false, error: { name: "Error", message: String(error) } };
}

async function dispatch(sdk: HistorySdk, request: HistoryRequest): Promise<HistoryResponse> {
	try {
		let value: unknown;
		switch (request.operation.kind) {
			case "list":
				value = await sdk.listSessions(request.operation.options);
				break;
			case "messages":
				value = await sdk.getSessionMessages(request.operation.sessionId, request.operation.options);
				break;
			case "agents":
				value = await sdk.listSubagents(request.operation.sessionId, request.operation.options);
				break;
			case "agentMessages":
				value = await sdk.getSubagentMessages(
					request.operation.sessionId,
					request.operation.agentId,
					request.operation.options,
				);
				break;
		}
		return { id: request.id, ok: true, value };
	} catch (error) {
		return errorResponse(request.id, error);
	}
}

if (parentPort) {
	const data = workerData as WorkerData;
	if (typeof data.configRoot === "string" && data.configRoot.length > 0) {
		process.env.CLAUDE_CONFIG_DIR = data.configRoot;
	}

	const sdk = (await import("@anthropic-ai/claude-agent-sdk")) as HistorySdk;
	let queue = Promise.resolve();
	parentPort.on("message", (request: unknown) => {
		if (
			typeof request !== "object" ||
			request === null ||
			!("id" in request) ||
			typeof request.id !== "number" ||
			!Number.isSafeInteger(request.id) ||
			!("operation" in request) ||
			!isHistoryOperation(request.operation)
		) {
			if (
				typeof request === "object" &&
				request !== null &&
				"id" in request &&
				typeof request.id === "number" &&
				Number.isSafeInteger(request.id)
			) {
				parentPort?.postMessage(errorResponse(request.id, new TypeError("Unsupported history operation")));
			}
			return;
		}
		const validRequest = request as HistoryRequest;
		queue = queue
			.then(async () => {
				const response = await dispatch(sdk, validRequest);
				try {
					parentPort?.postMessage(response);
				} catch (error) {
					parentPort?.postMessage(errorResponse(validRequest.id, error));
				}
			})
			.catch(() => undefined);
	});
}
