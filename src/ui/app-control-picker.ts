import { Key, matchesKey, SelectList, Text, TuiMainScreen, type Component, type Editor, type OverlayHandle, type SelectItem } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "./safe-text.js";
import { theme } from "./theme.js";

export type ControlPickerKind = "model" | "effort";

export interface ControlPickerContent {
	kind: ControlPickerKind;
	title: string;
	detail: string;
	items: readonly SelectItem[];
	selectedValue?: string;
	loading?: boolean;
	emptyMessage?: string;
}

export type ControlPickerApplyResult =
	| { accepted: true }
	| { accepted: false; message: string }
	| undefined;

export class AppControlPickerController {
	private overlay: OverlayHandle | undefined;
	private isVisible = false;
	private requestId = 0;
	private applying = false;
	private readonly view: ControlPickerView;

	constructor(
		private readonly tui: TuiMainScreen,
		private readonly editor: Editor,
		private readonly apply: (kind: ControlPickerKind, value: string, isCurrent: () => boolean) => Promise<ControlPickerApplyResult>,
		private readonly onChange: () => void,
	) {
		this.view = new ControlPickerView(tui, (value) => void this.applySelection(value), () => this.hide());
	}

	get visible(): boolean {
		return this.isVisible;
	}

	show(content: ControlPickerContent): number {
		const requestId = ++this.requestId;
		this.applying = false;
		this.view.setContent(content);
		if (!this.overlay) {
			this.overlay = this.tui.showOverlay(this.view, {
				width: "88%",
				maxHeight: "80%",
				anchor: "center",
				margin: 1,
			});
		} else {
			this.overlay.setHidden(false);
			this.overlay.focus();
		}
		this.isVisible = true;
		this.onChange();
		return requestId;
	}

	update(requestId: number, content: ControlPickerContent): boolean {
		if (!this.isVisible || requestId !== this.requestId) return false;
		this.view.setContent(content);
		this.onChange();
		return true;
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
		if (!this.overlay || !this.isVisible) return;
		this.requestId += 1;
		this.isVisible = false;
		this.applying = false;
		this.overlay.setHidden(true);
		this.overlay.unfocus({ target: this.editor });
		this.onChange();
	}

	dismiss(): void {
		this.hide();
	}

	private async applySelection(value: string): Promise<void> {
		if (!this.isVisible || this.applying) return;
		const requestId = this.requestId;
		const content = this.view.content;
		if (!content.items.some((item) => item.value === value)) return;
		this.applying = true;
		this.view.setMessage(`Applying ${content.kind}…`);
		this.onChange();
		let result: ControlPickerApplyResult;
		try {
			result = await this.apply(content.kind, value, () => this.isVisible && requestId === this.requestId);
		} catch (error) {
			result = { accepted: false, message: `Could not set ${content.kind}: ${errorText(error)}` };
		}
		if (!this.isVisible || requestId !== this.requestId) return;
		this.applying = false;
		if (result?.accepted) {
			this.hide();
			return;
		}
		if (result && !result.accepted) this.view.setMessage(result.message);
		this.onChange();
	}
}

class ControlPickerView implements Component {
	content: ControlPickerContent = { kind: "model", title: "Choose model", detail: "Loading SDK models…", items: [], loading: true };
	private message: string | undefined;
	private list: SelectList;
	private listVisibleRows = 0;

	constructor(
		private readonly tui: TuiMainScreen,
		private readonly onSelect: (value: string) => void,
		private readonly onCancel: () => void,
	) {
		this.list = this.createList(1);
	}

	setContent(content: ControlPickerContent): void {
		this.content = content;
		this.message = undefined;
		this.list = this.createList(this.visibleRows());
	}

	setMessage(message: string): void {
		this.message = message;
	}

	invalidate(): void {
		this.list.invalidate();
	}

	handleInput(data: string): void {
		this.list.handleInput(data);
	}

	render(width: number): string[] {
		this.ensureListSize();
		const title = this.line(theme.accent(this.content.title), width);
		const detail = this.line(theme.dim(this.message ?? this.content.detail), width);
		const footer = this.line(theme.dim("↑/↓ move · Enter apply · Esc/Ctrl+C close"), width);
		let rows: string[];
		if (this.content.loading) rows = [];
		else if (this.content.items.length === 0) rows = this.line(theme.dim(this.content.emptyMessage ?? "No supported choices reported by the SDK."), width);
		else rows = this.list.render(width);
		return [...title, ...detail, ...rows, ...footer].map((line) => theme.overlayLine(line, width));
	}

	private ensureListSize(): void {
		const visibleRows = this.visibleRows();
		if (visibleRows === this.listVisibleRows) return;
		const selectedValue = this.list.getSelectedItem()?.value ?? this.content.selectedValue;
		this.list = this.createList(visibleRows);
		const selectedIndex = this.content.items.findIndex((item) => item.value === selectedValue);
		if (selectedIndex >= 0) this.list.setSelectedIndex(selectedIndex);
	}

	private visibleRows(): number {
		const terminalRows = Math.max(1, this.tui.terminal.rows);
		const overlayHeight = Math.max(1, Math.min(Math.floor(terminalRows * 0.8), terminalRows - 2));
		// Reserve one row for SelectList's scroll counter when the SDK returns many choices.
		return Math.max(1, overlayHeight - 4);
	}

	private createList(maxVisible: number): SelectList {
		this.listVisibleRows = maxVisible;
		const items = this.content.items.map((item) => ({
			...item,
			...(item.value === this.content.selectedValue && !item.label.startsWith("✓ ")
				? { label: `✓ ${item.label}` }
				: {}),
		}));
		const list = new SelectList(items, maxVisible, theme.selectList);
		list.onSelect = (item) => this.onSelect(item.value);
		list.onCancel = this.onCancel;
		const selectedIndex = items.findIndex((item) => item.value === this.content.selectedValue);
		if (selectedIndex >= 0) list.setSelectedIndex(selectedIndex);
		return list;
	}

	private line(value: string, width: number): string[] {
		const safeWidth = Math.max(1, width);
		return new Text(sanitizeTerminalText(value), 0, 0).render(safeWidth).slice(0, 1);
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
