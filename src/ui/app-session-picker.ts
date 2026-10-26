import { Input, Key, matchesKey, SelectList, Text, TuiMainScreen, type Component, type Editor, type OverlayHandle } from "@earendil-works/pi-tui";
import type { SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import { sanitizeTerminalText } from "./safe-text.js";
import { theme } from "./theme.js";

class SessionPickerView implements Component {
	private readonly filter = new Input({ prompt: "Find: ", placeholder: "Search title, branch, or session ID" });
	private sessions: SDKSessionInfo[] = [];
	private currentSessionId: string | undefined;
	private message = "Loading sessions…";
	private loading = true;
	private list: SelectList;
	private listVisibleRows = 0;

	constructor(
		private readonly tui: TuiMainScreen,
		private readonly onSelect: (sessionId: string) => void,
		private readonly onCancel: () => void,
	) {
		this.filter.focused = true;
		this.list = this.createList(this.visibleRows());
	}

	setLoading(): void {
		this.sessions = [];
		this.currentSessionId = undefined;
		this.message = "Loading sessions…";
		this.loading = true;
		this.filter.setValue("");
		this.list = this.createList(this.visibleRows());
	}

	setSessions(sessions: SDKSessionInfo[], currentSessionId?: string): void {
		this.sessions = [...sessions];
		this.currentSessionId = currentSessionId;
		this.loading = false;
		this.message = sessions.length ? `${sessions.length} session${sessions.length === 1 ? "" : "s"} · search title, branch, or ID` : "No sessions found.";
		this.list = this.createList(this.visibleRows());
	}

	setError(message: string): void {
		this.loading = false;
		this.message = `Could not load sessions: ${sanitizeTerminalText(message)}`;
	}

	setMessage(message: string): void {
		this.message = sanitizeTerminalText(message);
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.up) || matchesKey(data, Key.down) || matchesKey(data, Key.enter)) {
			this.list.handleInput(data);
			return;
		}
		// SelectList 1.4.0 has no page-key handling; keep those terminal sequences out of the filter.
		if (data === "\u001b[5~" || data === "\u001b[6~") return;
		const previous = this.filter.getValue();
		this.filter.handleInput(data);
		const value = this.filter.getValue();
		const safeValue = sanitizeTerminalText(value);
		if (safeValue !== value) this.filter.setValue(safeValue);
		if (safeValue !== previous) this.list = this.createList(this.visibleRows());
	}

	render(width: number): string[] {
		this.ensureListSize();
		const title = new Text(theme.accent("Phi sessions"), 0, 0).render(width).slice(0, 1);
		const status = new Text(theme.dim(this.message), 0, 0).render(width).slice(0, 1);
		const filter = this.filter.render(width).slice(0, 1);
		const rows = this.loading || this.sessions.length === 0
			? []
			: this.filteredSessions().length === 0
				? new Text(theme.dim("No matching sessions."), 0, 0).render(width).slice(0, 1)
				: this.list.render(width);
		const footer = new Text(theme.dim("↑/↓ move · Enter select · Esc/Ctrl+C close"), 0, 0).render(width).slice(0, 1);
		return [...title, ...status, ...filter, ...rows, ...footer].map((line) => theme.overlayLine(line, width));
	}

	invalidate(): void {
		this.filter.invalidate();
		this.list.invalidate();
	}

	private ensureListSize(): void {
		const visibleRows = this.visibleRows();
		if (visibleRows === this.listVisibleRows) return;
		const selectedId = this.list.getSelectedItem()?.value;
		this.list = this.createList(visibleRows);
		const selectedIndex = this.filteredSessions().findIndex((session) => session.sessionId === selectedId);
		if (selectedIndex >= 0) this.list.setSelectedIndex(selectedIndex);
	}

	private visibleRows(): number {
		const terminalRows = Math.max(1, this.tui.terminal.rows);
		const overlayRows = Math.max(1, Math.min(Math.floor(terminalRows * 0.8), terminalRows - 2));
		// Reserve four fixed lines and one possible SelectList scroll counter.
		return Math.max(1, overlayRows - 5);
	}

	private createList(maxVisible: number): SelectList {
		this.listVisibleRows = maxVisible;
		const items = this.filteredSessions().map((session) => {
			const customTitle = sanitizeTerminalText(session.customTitle ?? "").replace(/\s+/gu, " ").trim();
			const summary = sanitizeTerminalText(session.summary).replace(/\s+/gu, " ").trim();
			const title = customTitle || summary || "Untitled session";
			const current = session.sessionId === this.currentSessionId;
			const branch = session.gitBranch ? sanitizeTerminalText(session.gitBranch).replace(/\s+/gu, " ") : "";
			const modified = Number.isFinite(session.lastModified)
				? new Date(session.lastModified).toLocaleString()
				: "Unknown time";
			return {
				value: session.sessionId,
				label: `${current ? "● Current · " : ""}${title}`,
				description: [sanitizeTerminalText(modified), branch].filter(Boolean).join(" · "),
			};
		});
		const list = new SelectList(items, maxVisible, theme.selectList);
		list.onSelect = (item) => this.onSelect(item.value);
		list.onCancel = this.onCancel;
		return list;
	}

	private filteredSessions(): SDKSessionInfo[] {
		const query = sanitizeTerminalText(this.filter.getValue()).trim().toLowerCase();
		if (!query) return this.sessions;
		return this.sessions.filter((session) => [session.summary, session.customTitle ?? "", session.gitBranch ?? "", session.sessionId]
			.map((value) => sanitizeTerminalText(value).toLowerCase()).join(" ").includes(query));
	}
}

export class AppSessionPickerController {
	private overlay: OverlayHandle | undefined;
	private isVisible = false;
	private requestId = 0;
	private sessionIds = new Set<string>();
	private readonly view: SessionPickerView;

	constructor(
		private readonly tui: TuiMainScreen,
		private readonly editor: Editor,
		private readonly onSelect: (sessionId: string) => void,
		private readonly onChange: () => void,
	) {
		this.view = new SessionPickerView(tui, (id) => {
			if (this.sessionIds.has(id)) this.onSelect(id);
		}, () => this.hide());
	}

	get visible(): boolean {
		return this.isVisible;
	}

	show(load: () => Promise<SDKSessionInfo[]>, currentSessionId?: string): void {
		const requestId = ++this.requestId;
		this.sessionIds.clear();
		this.view.setLoading();
		if (!this.overlay) {
			this.overlay = this.tui.showOverlay(this.view, { width: "88%", maxHeight: "80%", anchor: "center", margin: 1 });
		} else {
			this.overlay.setHidden(false);
			this.overlay.focus();
		}
		this.isVisible = true;
		this.onChange();
		void this.loadSessions(requestId, load, currentSessionId);
	}

	handleInput(data: string): void {
		if (!this.isVisible) return;
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.hide();
			return;
		}
		this.view.handleInput(data);
		this.onChange();
	}

	hide(): void {
		this.requestId += 1;
		if (!this.overlay || !this.isVisible) return;
		this.isVisible = false;
		this.sessionIds.clear();
		this.overlay.setHidden(true);
		this.overlay.unfocus({ target: this.editor });
		this.onChange();
	}

	setMessage(text: string): void {
		if (!this.isVisible) return;
		this.view.setMessage(text);
		this.onChange();
	}

	private async loadSessions(requestId: number, load: () => Promise<SDKSessionInfo[]>, currentSessionId?: string): Promise<void> {
		try {
			const sessions = await load();
			if (!this.isCurrent(requestId)) return;
			this.sessionIds = new Set(sessions.map((session) => session.sessionId));
			this.view.setSessions(sessions, currentSessionId);
		} catch (error) {
			if (!this.isCurrent(requestId)) return;
			this.view.setError(error instanceof Error ? error.message : String(error));
		}
		if (this.isCurrent(requestId)) this.onChange();
	}

	private isCurrent(requestId: number): boolean {
		return this.isVisible && requestId === this.requestId;
	}
}
