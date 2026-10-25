import {
	query as sdkQuery,
	type AccountInfo,
	type Options,
	type Query,
	type SDKControlInitializeResponse,
	type SDKMessage,
	type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

const ACCEPTED_API_KEY_SOURCES: ReadonlySet<string> = new Set([
	"ANTHROPIC_API_KEY",
	"apiKeyHelper",
	"/login managed key",
]);

const MAX_STDERR_CAPTURE_CHARS = 16_384;

export interface SessionCallbacks {
	onMessage(message: SDKMessage): void | Promise<void>;
	onError(error: unknown): void | Promise<void>;
	onClosing?(reason: string): void;
}

export interface Session {
	query: Query;
	ready: Promise<SDKControlInitializeResponse>;
	done: Promise<void>;
	readonly stderr: string;
	send(message: SDKUserMessage): void;
	close(): Promise<void>;
}

export class ApiRouteMismatchError extends Error {
	readonly apiProvider: AccountInfo["apiProvider"];
	readonly apiKeySource: string | undefined;

	constructor(apiProvider: AccountInfo["apiProvider"], apiKeySource: string | undefined) {
		super(
			`Prompt submission requires a first-party API-key route (provider=${apiProvider ?? "unknown"}, key source=${apiKeySource ?? "unknown"})`,
		);
		this.name = "ApiRouteMismatchError";
		this.apiProvider = apiProvider;
		this.apiKeySource = apiKeySource;
	}
}

type SessionState = "open" | "closing" | "closed";
type Readiness = "pending" | "authorized" | "mismatch" | "failed";

class InputStream implements AsyncIterableIterator<SDKUserMessage> {
	private readonly messages: SDKUserMessage[] = [];
	private readonly readers: Array<(result: IteratorResult<SDKUserMessage>) => void> = [];
	private closed = false;

	[Symbol.asyncIterator](): AsyncIterableIterator<SDKUserMessage> {
		return this;
	}

	next(): Promise<IteratorResult<SDKUserMessage>> {
		const message = this.messages.shift();
		if (message !== undefined) return Promise.resolve({ done: false, value: message });
		if (this.closed) return Promise.resolve({ done: true, value: undefined });
		return new Promise((resolve) => this.readers.push(resolve));
	}

	push(message: SDKUserMessage): void {
		if (this.closed) throw new Error("Session input is closed");
		const reader = this.readers.shift();
		if (reader) {
			reader({ done: false, value: message });
		} else {
			this.messages.push(message);
		}
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.messages.length = 0;
		for (const reader of this.readers.splice(0)) {
			reader({ done: true, value: undefined });
		}
	}

	return(): Promise<IteratorResult<SDKUserMessage>> {
		this.close();
		return Promise.resolve({ done: true, value: undefined });
	}
}

export function startSession(
	options: Options,
	callbacks: SessionCallbacks,
	createQuery: typeof sdkQuery = sdkQuery,
): Session {
	const input = new InputStream();
	let capturedStderr = "";
	let state: SessionState = "open";
	let readiness: Readiness = "pending";
	let routeMismatch: ApiRouteMismatchError | undefined;
	let readerSettled = false;
	let closePromise: Promise<void> | undefined;

	const query = createQuery({
		prompt: input,
		options: {
			...options,
			stderr(data) {
				if (capturedStderr.length < MAX_STDERR_CAPTURE_CHARS) {
					const remaining = MAX_STDERR_CAPTURE_CHARS - capturedStderr.length;
					capturedStderr += data.slice(0, remaining);
				}
				options.stderr?.(data);
			},
		},
	});

	const done = (async () => {
		try {
			for await (const message of query) {
				await callbacks.onMessage(message);
			}
		} catch (error) {
			await callbacks.onError(error);
			throw error;
		} finally {
			readerSettled = true;
		}
	})();
	void done.catch(() => undefined);

	let initialization: Promise<SDKControlInitializeResponse>;
	try {
		initialization = Promise.resolve(query.initializationResult());
	} catch (error) {
		initialization = Promise.reject(error);
	}

	const ready = initialization.then(
		(response) => {
			const { apiProvider, apiKeySource } = response.account;
			if (apiProvider === "firstParty" && apiKeySource && ACCEPTED_API_KEY_SOURCES.has(apiKeySource)) {
				readiness = "authorized";
			} else {
				readiness = "mismatch";
				routeMismatch = new ApiRouteMismatchError(apiProvider, apiKeySource);
			}
			return response;
		},
		async (error: unknown) => {
			readiness = "failed";
			await callbacks.onError(error);
			throw error;
		},
	);
	void ready.catch(() => undefined);

	function send(message: SDKUserMessage): void {
		if (state !== "open") throw new Error(`Cannot send while the session is ${state}`);
		if (readerSettled) throw new Error("Cannot send after the SDK output iterator has settled");
		if (readiness === "pending") throw new Error("Cannot send before the session is ready");
		if (readiness === "failed") throw new Error("Cannot send before the session is ready because initialization failed");
		if (readiness === "mismatch") throw routeMismatch;
		input.push(message);
	}

	function close(): Promise<void> {
		if (closePromise) return closePromise;
		state = "closing";
		input.close();

		let closeError: unknown;
		closePromise = (async () => {
			const outcomes = await Promise.allSettled([ready, done]);
			state = "closed";
			if (closeError !== undefined) throw closeError;
			for (const outcome of outcomes) {
				if (outcome.status === "rejected") throw outcome.reason;
			}
		})();
		void closePromise.catch(() => undefined);

		try {
			query.close();
		} catch (error) {
			closeError = error;
		}
		try {
			callbacks.onClosing?.("Session closed");
		} catch (error) {
			closeError ??= error;
		}

		return closePromise;
	}

	return {
		query,
		ready,
		done,
		get stderr() {
			return capturedStderr;
		},
		send,
		close,
	};
}
