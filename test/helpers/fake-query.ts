import type {
	Options,
	Query,
	SDKControlInitializeResponse,
	SDKMessage,
	SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";

type QueryParameters = Parameters<typeof sdkQuery>[0];

class AsyncQueue<T> implements AsyncIterableIterator<T> {
	private readonly values: T[] = [];
	private readonly readers: Array<{
		resolve: (result: IteratorResult<T>) => void;
		reject: (error: unknown) => void;
	}> = [];
	private ended = false;
	private failure: unknown;

	[Symbol.asyncIterator](): AsyncIterableIterator<T> {
		return this;
	}

	next(): Promise<IteratorResult<T>> {
		if (this.values.length > 0) {
			return Promise.resolve({ done: false, value: this.values.shift() as T });
		}
		if (this.failure !== undefined) {
			return Promise.reject(this.failure);
		}
		if (this.ended) {
			return Promise.resolve({ done: true, value: undefined });
		}
		return new Promise((resolve, reject) => this.readers.push({ resolve, reject }));
	}

	push(value: T): void {
		if (this.ended || this.failure !== undefined) {
			throw new Error("Cannot add an item to a settled queue");
		}
		const reader = this.readers.shift();
		if (reader) {
			reader.resolve({ done: false, value });
		} else {
			this.values.push(value);
		}
	}

	close(): void {
		if (this.ended) return;
		this.ended = true;
		for (const reader of this.readers.splice(0)) {
			reader.resolve({ done: true, value: undefined });
		}
	}

	fail(error: unknown): void {
		if (this.ended || this.failure !== undefined) return;
		this.failure = error;
		for (const reader of this.readers.splice(0)) reader.reject(error);
	}
}

export function initializedResponse(
	account: { apiProvider?: string; apiKeySource?: string } = {
		apiProvider: "firstParty",
		apiKeySource: "ANTHROPIC_API_KEY",
	},
): SDKControlInitializeResponse {
	return {
		commands: [],
		agents: [],
		output_style: "default",
		available_output_styles: [],
		models: [],
		account,
	} as SDKControlInitializeResponse;
}

export class FakeQueryHarness {
	readonly receivedMessages: SDKUserMessage[] = [];
	readonly inputDone: Promise<void>;
	readonly query: Query;
	readonly createQuery: (parameters: QueryParameters) => Query;
	parameters?: QueryParameters;
	closeCalls = 0;
	interruptCalls = 0;
	mcpStatusCalls = 0;

	private readonly output = new AsyncQueue<SDKMessage>();
	private readonly initialization: Promise<SDKControlInitializeResponse>;
	private resolveInputDone!: () => void;
	private readonly inputObservers: Array<{
		count: number;
		resolve: () => void;
		reject: (error: Error) => void;
	}> = [];

	constructor(initialization: Promise<SDKControlInitializeResponse> = Promise.resolve(initializedResponse())) {
		this.initialization = initialization;
		this.inputDone = new Promise((resolve) => {
			this.resolveInputDone = resolve;
		});

		const iterator = this.readOutput();
		this.query = Object.assign(iterator, {
			initializationResult: () => this.initialization,
			mcpServerStatus: async () => {
				this.mcpStatusCalls += 1;
				return [];
			},
			interrupt: async () => {
				this.interruptCalls += 1;
				return undefined;
			},
			close: () => {
				this.closeCalls += 1;
				this.output.close();
			},
		}) as unknown as Query;

		this.createQuery = (parameters) => {
			if (this.parameters) throw new Error("Fake query may only be created once");
			this.parameters = parameters;
			if (typeof parameters.prompt === "string") {
				this.resolveInputDone();
			} else {
				void this.consumeInput(parameters.prompt);
			}
			return this.query;
		};
	}

	pushMessage(message: SDKMessage): void {
		this.output.push(message);
	}

	finishOutput(): void {
		this.output.close();
	}

	failOutput(error: unknown): void {
		this.output.fail(error);
	}

	waitForInputCount(count: number): Promise<void> {
		if (this.receivedMessages.length >= count) return Promise.resolve();
		return new Promise((resolve, reject) => {
			this.inputObservers.push({ count, resolve, reject });
		});
	}

	private async *readOutput(): AsyncGenerator<SDKMessage, void> {
		for (;;) {
			const item = await this.output.next();
			if (item.done) return;
			yield item.value;
		}
	}

	private async consumeInput(input: AsyncIterable<SDKUserMessage>): Promise<void> {
		try {
			for await (const message of input) {
				this.receivedMessages.push(message);
				this.settleInputObservers();
			}
		} finally {
			this.resolveInputDone();
			this.settleInputObservers(new Error("Input iterator settled before the requested message arrived"));
		}
	}

	private settleInputObservers(settledError?: Error): void {
		for (let index = this.inputObservers.length - 1; index >= 0; index -= 1) {
			const observer = this.inputObservers[index];
			if (!observer) continue;
			if (this.receivedMessages.length >= observer.count) {
				this.inputObservers.splice(index, 1);
				observer.resolve();
			} else if (settledError) {
				this.inputObservers.splice(index, 1);
				observer.reject(settledError);
			}
		}
	}
}

export function userMessage(text: string): SDKUserMessage {
	return {
		type: "user",
		message: { role: "user", content: text },
		parent_tool_use_id: null,
	};
}

export function sdkMessage(): SDKMessage {
	return { type: "system", subtype: "status", status: "test" } as unknown as SDKMessage;
}

export function optionCallbacks(): Pick<Options, "canUseTool" | "onElicitation" | "hooks"> {
	return {
		canUseTool: (async () => ({ behavior: "deny", message: "test" })) as NonNullable<Options["canUseTool"]>,
		onElicitation: (async () => ({ action: "decline" })) as NonNullable<Options["onElicitation"]>,
		hooks: {},
	};
}
