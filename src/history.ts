import { Worker } from "node:worker_threads";
import type {
	GetSessionMessagesOptions,
	GetSubagentMessagesOptions,
	ListSessionsOptions,
	ListSubagentsOptions,
	SDKSessionInfo,
	SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { HistoryOperation, HistoryRequest } from "./history-worker.js";

export interface HistoryReader {
	list(options: ListSessionsOptions): Promise<SDKSessionInfo[]>;
	messages(sessionId: string, options: GetSessionMessagesOptions): Promise<SessionMessage[]>;
	agents(sessionId: string, options: ListSubagentsOptions): Promise<string[]>;
	agentMessages(
		sessionId: string,
		agentId: string,
		options: GetSubagentMessagesOptions,
	): Promise<SessionMessage[]>;
	close(): Promise<void>;
}

export interface HistoryReaderOptions {
	configRoot?: string;
	workerFactory?: (configRoot: string | undefined) => Worker;
}

type PendingRequest = {
	resolve(value: unknown): void;
	reject(error: Error): void;
};

function defaultWorkerFactory(configRoot: string | undefined): Worker {
	const env = configRoot
		? { ...process.env, CLAUDE_CONFIG_DIR: configRoot }
		: undefined;
	return new Worker(new URL("./history-worker.js", import.meta.url), {
		workerData: { configRoot },
		...(env ? { env } : {}),
	});
}

function toError(name: string, message: string): Error {
	const error = new Error(message);
	error.name = name;
	return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

class NativeHistoryReader implements HistoryReader {
	private readonly worker: Worker;
	private readonly pending = new Map<number, PendingRequest>();
	private nextRequestId = 1;
	private closed = false;
	private failure: Error | undefined;
	private closePromise: Promise<void> | undefined;

	constructor(options: HistoryReaderOptions) {
		this.worker = (options.workerFactory ?? defaultWorkerFactory)(options.configRoot);
		this.worker.on("message", (message: unknown) => this.onMessage(message));
		this.worker.on("error", (error: Error) => this.fail(error));
		this.worker.on("messageerror", () => this.fail(new Error("History worker returned an unreadable response")));
		this.worker.on("exit", (code: number) => {
			if (!this.closed) this.fail(new Error(`History worker exited unexpectedly with code ${code}`));
		});
	}

	list(options: ListSessionsOptions): Promise<SDKSessionInfo[]> {
		return this.request({ kind: "list", options });
	}

	messages(sessionId: string, options: GetSessionMessagesOptions): Promise<SessionMessage[]> {
		return this.request({ kind: "messages", sessionId, options });
	}

	agents(sessionId: string, options: ListSubagentsOptions): Promise<string[]> {
		return this.request({ kind: "agents", sessionId, options });
	}

	agentMessages(
		sessionId: string,
		agentId: string,
		options: GetSubagentMessagesOptions,
	): Promise<SessionMessage[]> {
		return this.request({ kind: "agentMessages", sessionId, agentId, options });
	}

	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closed = true;
		this.rejectPending(new Error("History reader is closed"));
		this.closePromise = this.worker.terminate().then(() => undefined);
		void this.closePromise.catch(() => undefined);
		return this.closePromise;
	}

	private request<T>(operation: HistoryOperation): Promise<T> {
		if (this.closed) return Promise.reject(this.failure ?? new Error("History reader is closed"));
		if ((operation.options as { sessionStore?: unknown }).sessionStore !== undefined) {
			return Promise.reject(
				new TypeError("History worker does not support SDK sessionStore callbacks across its worker boundary"),
			);
		}
		if (this.nextRequestId > Number.MAX_SAFE_INTEGER) {
			if (this.pending.size > 0) {
				return Promise.reject(new Error("History request identifiers are exhausted"));
			}
			this.nextRequestId = 1;
		}

		const id = this.nextRequestId++;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, {
				resolve: (value) => resolve(value as T),
				reject,
			});
			try {
				this.worker.postMessage({ id, operation } satisfies HistoryRequest);
			} catch (error) {
				this.pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	private onMessage(message: unknown): void {
		if (!isRecord(message) || !Number.isSafeInteger(message.id)) return;
		const id = message.id as number;
		const pending = this.pending.get(id);
		if (!pending) return;
		this.pending.delete(id);
		if (message.ok === true && "value" in message) {
			pending.resolve(message.value);
		} else if (
			message.ok === false &&
			isRecord(message.error) &&
			typeof message.error.name === "string" &&
			typeof message.error.message === "string"
		) {
			pending.reject(toError(message.error.name, message.error.message));
		} else {
			pending.reject(new Error("History worker returned a malformed response"));
		}
	}

	private fail(error: Error): void {
		if (this.closed) return;
		this.closed = true;
		this.failure = error;
		this.rejectPending(error);
	}

	private rejectPending(error: Error): void {
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
	}
}

export function createHistoryReader(options: HistoryReaderOptions = {}): HistoryReader {
	return new NativeHistoryReader(options);
}
