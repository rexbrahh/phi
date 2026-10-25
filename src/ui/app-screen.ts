import { Text, truncateToWidth, visibleWidth, VStack, type Component, type TUI } from "@earendil-works/pi-tui";
import type { Editor } from "@earendil-works/pi-tui";
import type { PhiState } from "../state.js";
import type { ImageAttachment } from "../attachments.js";
import type { ShellPreview } from "../shell.js";
import type { WorkspaceInfo } from "../workspace.js";
import { sanitizeTerminalText } from "./safe-text.js";
import type { InspectorView } from "./inspectors.js";
import type { TranscriptView } from "./transcript.js";
import { theme } from "./theme.js";

export interface ScreenUpdate {
	workspace?: WorkspaceInfo;
	notice?: string;
	shellMode: boolean;
	shellCwd?: string;
	shellPreview?: ShellPreview;
	shellJob?: { jobId: string; command: string; cwd: string };
	attachments: readonly ImageAttachment[];
}

export class MainScreen {
	readonly root: VStack;
	private readonly editorView: Component;
	private readonly heading = new Text();
	private readonly notice = new Text();
	private readonly attachmentLine = new Text();
	private readonly activity = new Text();
	private readonly footer = new Text();

	constructor(
		private readonly tui: TUI,
		private readonly state: PhiState,
		readonly transcript: TranscriptView,
		readonly inspector: InspectorView,
		readonly editor: Editor,
	) {
		this.editorView = new WidthSafeEditor(editor);
		this.root = new WidthSafeVStack([
			this.heading,
			this.transcript,
			this.inspector,
			this.notice,
			this.attachmentLine,
			this.activity,
			this.editorView,
			this.footer,
		]);
	}

	update(values: ScreenUpdate): void {
		const workspace = values.workspace;
		let workspaceLabel = "";
		if (workspace?.kind === "repository") {
			workspaceLabel = ` · ${workspace.branch ?? "detached HEAD"}${workspace.dirty ? "*" : ""}`;
		} else if (workspace?.kind === "not-repository") {
			workspaceLabel = " · not a Git repository";
		} else if (workspace?.kind === "error") {
			workspaceLabel = " · Git status unavailable";
		}
		this.heading.setText(theme.accent(`Phi · ${sanitizeTerminalText(this.state.cwd)}${workspaceLabel}`));
		this.notice.setText(values.notice ? theme.dim(sanitizeTerminalText(values.notice)) : "");
		this.attachmentLine.setText(values.attachments.length
			? `Images: ${values.attachments.map((attachment) => sanitizeTerminalText(attachment.name)).join(" · ")} · Alt+Backspace removes the last image`
			: "");

		const activity = [statusLabel(this.state)];
		if (this.state.usage) {
			const cost = this.state.usage.totalCostUsd;
			if (cost !== null) activity.push(`cost $${cost.toFixed(4)}`);
			const usage = this.state.usage.mainLoopTurnUsage;
			if (usage) activity.push(`${usage.input_tokens + usage.output_tokens} tokens`);
		}
		if (values.shellMode) activity.push(`shell mode · cwd ${sanitizeTerminalText(values.shellCwd ?? this.state.cwd)}`);
		if (values.shellJob) {
			activity.push(`Local shell job ${sanitizeTerminalText(values.shellJob.jobId)} · ${sanitizeTerminalText(values.shellJob.command)} · cwd ${sanitizeTerminalText(values.shellJob.cwd)}`);
		}
		if (values.shellPreview) {
			activity.push(values.shellPreview.stdoutTruncated ? "shell stdout preview truncated" : "shell running");
			if (values.shellPreview.stdout) activity.push(sanitizeTerminalText(values.shellPreview.stdout));
			if (values.shellPreview.stderr) activity.push(theme.dim(sanitizeTerminalText(values.shellPreview.stderr)));
		}
		this.activity.setText(activity.join(" · "));
		this.footer.setText(theme.dim("Enter send · Ctrl+T tasks · Ctrl+B background · Ctrl+R history · Ctrl+W workspace · Ctrl+V image · Ctrl+C interrupt or exit · Esc close view"));
		this.tui.requestRender();
	}
}

class WidthSafeEditor implements Component {
	constructor(private readonly editor: Editor) {}

	render(width: number): string[] {
		return fitLines(this.editor.render(Math.max(3, width)), width);
	}

	invalidate(): void {
		this.editor.invalidate();
	}
}

class WidthSafeVStack extends VStack {
	override render(width: number): string[] {
		return fitLines(super.render(width), width);
	}
}

function fitLines(lines: string[], width: number): string[] {
	const availableWidth = Math.max(1, width);
	return lines.map((line) => visibleWidth(line) <= availableWidth ? line : truncateToWidth(line, availableWidth));
}

function statusLabel(state: PhiState): string {
	const { foreground, phase, busyBackgroundTaskCount } = state.effectiveStatus;
	const label = foreground === "requires_action" ? "waiting for you" : foreground;
	const phaseLabel = phase ? ` · ${phase}` : "";
	const backgroundLabel = busyBackgroundTaskCount > 0 ? ` · ${busyBackgroundTaskCount} background task${busyBackgroundTaskCount === 1 ? "" : "s"}` : "";
	return `${label}${phaseLabel}${backgroundLabel}`;
}
