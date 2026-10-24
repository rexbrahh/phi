import { Key, matchesKey } from "@earendil-works/pi-tui";
import type { PhiState } from "../state.js";
import { AppAttachmentController } from "./app-attachments.js";
import type { AppShellController } from "./app-shell.js";
import type { AppViews } from "./app.js";
import type { InspectorPanel } from "./inspectors.js";

export interface AppKeyboardActions {
	dialogVisible(): boolean;
	handleDialogInput(data: string): void;
	hideDialog(): void;
	reopenDialog(): void;
	leaveShellMode(): void;
	interruptForeground(): void;
	close(): void;
	suspendTerminal(): void;
	refreshWorkspace(): void;
	showInspector(panel: InspectorPanel | null): void;
	searchLoadedHistory(query: string): void;
	selectTask(taskId: string): void;
	selectChild(agentId: string): void;
	render(): void;
}

export class AppKeyboardController {
	private readonly inlinePastes: string[] = [];
	private currentPaste = "";
	private capturingPaste = false;

	constructor(
		private readonly views: AppViews,
		private readonly state: PhiState,
		private readonly shell: AppShellController,
		private readonly attachments: AppAttachmentController,
		private readonly actions: AppKeyboardActions,
	) {}

	onInput(data: string): { consume?: boolean } | undefined {
		this.captureInlinePaste(data);
		if (this.actions.dialogVisible()) {
			if (matchesKey(data, Key.ctrl("c"))) {
				this.actions.close();
				return { consume: true };
			}
			if (matchesKey(data, Key.escape)) {
				this.actions.hideDialog();
				return { consume: true };
			}
			this.actions.handleDialogInput(data);
			this.actions.render();
			return { consume: true };
		}
		if (matchesKey(data, Key.escape)) {
			if (this.views.editor.isShowingAutocomplete()) return undefined;
			if (this.shell.mode) {
				this.actions.leaveShellMode();
				return { consume: true };
			}
			if (this.views.active !== "transcript") {
				this.actions.showInspector(null);
				this.views.tui.setFocus(this.views.editor);
				return { consume: true };
			}
			if (this.state.effectiveStatus.foreground === "running") {
				this.actions.interruptForeground();
				return { consume: true };
			}
			return undefined;
		}
		if (matchesKey(data, Key.ctrl("c"))) {
			if (this.shell.running) this.shell.cancel();
			else if (this.state.effectiveStatus.foreground === "running") this.actions.interruptForeground();
			else this.actions.close();
			return { consume: true };
		}
		if (matchesKey(data, Key.ctrl("z"))) {
			this.actions.suspendTerminal();
			return { consume: true };
		}
		if (matchesKey(data, Key.ctrl("t"))) {
			this.toggleInspector("tasks");
			return { consume: true };
		}
		if (matchesKey(data, Key.ctrl("r"))) {
			this.toggleInspector("history");
			return { consume: true };
		}
		if (matchesKey(data, Key.ctrl("w"))) {
			this.toggleInspector("workspace");
			return { consume: true };
		}
		if (matchesKey(data, Key.ctrl("g"))) {
			this.actions.refreshWorkspace();
			return { consume: true };
		}
		if (matchesKey(data, Key.ctrl("f"))) {
			this.actions.showInspector("history");
			this.actions.searchLoadedHistory(this.views.editor.getText());
			return { consume: true };
		}
		if (matchesKey(data, Key.ctrl("y"))) {
			void this.attachments.copySelectedOutput();
			return { consume: true };
		}
		if (matchesKey(data, Key.ctrl("v"))) {
			this.attachments.loadClipboardImage();
			return { consume: true };
		}
		if (matchesKey(data, Key.ctrl("o"))) {
			this.actions.reopenDialog();
			return { consume: true };
		}
		if (matchesKey(data, Key.alt("backspace"))) {
			this.attachments.removeLatest();
			this.actions.render();
			return { consume: true };
		}
		if (this.views.active === "history" && matchesKey(data, Key.pageUp)) {
			void this.views.inspectors.loadHistoryPage(Math.max(0, this.views.inspectors.model.historyOffset - 200));
			return { consume: true };
		}
		if (this.views.active === "history" && matchesKey(data, Key.pageDown)) {
			void this.views.inspectors.loadHistoryPage(this.views.inspectors.model.historyOffset + 200);
			return { consume: true };
		}
		if (this.views.active === "tasks" && matchesKey(data, Key.tab)) {
			this.selectNextInspectorItem();
			return { consume: true };
		}
		if (this.views.active === "tasks" && matchesKey(data, Key.enter)) {
			const model = this.views.inspectors.model;
			if (model.selectedChildId) this.actions.selectChild(model.selectedChildId);
			else if (model.selectedTaskId) this.actions.selectTask(model.selectedTaskId);
			return { consume: true };
		}
		if (data === "!" && this.views.editor.getText().length === 0 && !this.shell.mode) {
			this.shell.enter(this.state.cwd);
			return { consume: true };
		}
		return undefined;
	}

	pendingInlinePastes(): string[] {
		return [...this.inlinePastes];
	}

	clearInlinePastes(): void {
		this.inlinePastes.length = 0;
	}

	private captureInlinePaste(data: string): void {
		const start = "\u001b[200~";
		const end = "\u001b[201~";
		let cursor = 0;
		while (cursor < data.length) {
			if (!this.capturingPaste) {
				const startAt = data.indexOf(start, cursor);
				if (startAt < 0) return;
				this.capturingPaste = true;
				this.currentPaste = "";
				cursor = startAt + start.length;
			}
			const endAt = data.indexOf(end, cursor);
			const chunk = data.slice(cursor, endAt < 0 ? data.length : endAt);
			if (this.currentPaste.length < 200_000) this.currentPaste += chunk.slice(0, 200_000 - this.currentPaste.length);
			if (endAt < 0) return;
			if (this.currentPaste.trim() && this.inlinePastes.length < 100) this.inlinePastes.push(this.currentPaste);
			this.currentPaste = "";
			this.capturingPaste = false;
			cursor = endAt + end.length;
		}
	}

	private toggleInspector(panel: InspectorPanel): void {
		this.actions.showInspector(this.views.active === panel ? null : panel);
		this.views.tui.setFocus(this.views.editor);
	}

	private selectNextInspectorItem(): void {
		const model = this.views.inspectors.model;
		const taskIds = [...this.state.tasks.values()].filter((task) => !task.ambient).map((task) => task.taskId);
		const items = [...taskIds, ...model.childAgentIds];
		if (items.length === 0) return;
		const current = model.selectedChildId ?? model.selectedTaskId;
		const index = items.indexOf(current ?? "");
		const next = items[(index + 1) % items.length];
		if (!next) return;
		if (taskIds.includes(next)) this.actions.selectTask(next);
		else this.actions.selectChild(next);
	}
}
