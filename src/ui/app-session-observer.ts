import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { InteractionQueue } from "../interactions.js";
import { applySdkMessage, type PhiState } from "../state.js";
import type { AppInspectorController } from "./app-inspectors.js";

export interface AppSessionCallbacks {
	canUseTool: NonNullable<Options["canUseTool"]>;
	onElicitation: NonNullable<Options["onElicitation"]>;
	hooks: NonNullable<Options["hooks"]>;
	onMessage(message: SDKMessage): void;
	onError(error: unknown): void;
	onClosing(reason: string): void;
}

export class AppSessionObserver {
	constructor(
		private readonly state: PhiState,
		private readonly interactions: InteractionQueue,
		private readonly inspectors: AppInspectorController,
		private readonly syncInteractions: () => void,
		private readonly setSessionId: (sessionId: string) => void,
		private readonly render: () => void,
		private readonly showNotice: (message: string) => void,
		private readonly isClosing: () => boolean,
	) {}

	callbacks(): AppSessionCallbacks {
		return {
			canUseTool: (toolName, input, options) => {
				const pending = this.interactions.canUseTool(toolName, input, options);
				this.syncInteractions();
				return pending;
			},
			onElicitation: (request, options) => {
				const pending = this.interactions.onElicitation(request, options);
				this.syncInteractions();
				return pending;
			},
			hooks: {
				CwdChanged: [{ hooks: [async (input) => {
					if (input.hook_event_name === "CwdChanged") {
						this.state.cwd = input.new_cwd;
						this.inspectors.scheduleWorkspaceRefresh(input.new_cwd);
						this.render();
					}
					return { continue: true };
				}] }],
				PostToolUse: [{ hooks: [async () => {
					this.inspectors.scheduleWorkspaceRefresh(this.state.cwd);
					return { continue: true };
				}] }],
			},
			onMessage: (message) => this.onMessage(message),
			onError: (error) => {
				if (!this.isClosing()) this.showNotice(`SDK error: ${errorText(error)}`);
			},
			onClosing: (reason) => this.interactions.cancelAll(reason),
		};
	}

	private onMessage(message: SDKMessage): void {
		if (this.isClosing()) return;
		applySdkMessage(this.state, message);
		if ("session_id" in message && typeof message.session_id === "string") {
			this.setSessionId(message.session_id);
			this.inspectors.setSession(message.session_id);
		}
		this.inspectors.onSdkMessage(message);
		this.syncInteractions();
		this.render();
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
