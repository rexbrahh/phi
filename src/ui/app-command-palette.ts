import { CombinedAutocompleteProvider, Input, SelectList, Text, TuiMainScreen, type Component, type Editor, type OverlayHandle, type SelectItem, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "./safe-text.js";
import { theme } from "./theme.js";

export interface PaletteCommandChoice extends SelectItem {
	kind: "local" | "native";
	command: string;
}

interface LocalPaletteCommand {
	command: string;
	description: string;
	shortAlias?: boolean;
}

const LOCAL_COMMANDS: readonly LocalPaletteCommand[] = [
	{ command: "help", description: "Show local Phi commands" },
	{ command: "status", description: "Show session status" },
	{ command: "diagnostics", description: "Show complete diagnostic messages" },
	{ command: "details", description: "Expand or collapse retained tool details" },
	{ command: "editor", description: "Edit the draft in VISUAL or EDITOR" },
	{ command: "context", description: "Show SDK context usage" },
	{ command: "model", description: "Choose a model", shortAlias: true },
	{ command: "effort", description: "Choose an effort level", shortAlias: true },
	{ command: "permissions", description: "Choose a permission mode" },
	{ command: "tasks", description: "Open the Tasks inspector" },
	{ command: "workflows", description: "Open workflow task details" },
	{ command: "transcript", description: "Open transcript history" },
	{ command: "copy", description: "Copy the last answer or selected output" },
	{ command: "sessions", description: "Find and resume a saved session" },
	{ command: "new", description: "Start a new session" },
	{ command: "fork", description: "Fork the current session" },
	{ command: "rewind", description: "Preview the latest file checkpoint" },
	{ command: "worktrees", description: "Open the workspace inspector" },
	{ command: "shell", description: "Open local shell mode" },
	{ command: "mcp", description: "Show MCP server status" },
	{ command: "reload", description: "Reload native plugins, skills, and commands" },
	{ command: "palette", description: "Open the command palette" },
	{ command: "ultracode", description: "Show ultracode status" },
	{ command: "workflow-size", description: "Show workflow size" },
	{ command: "questions", description: "Reopen a hidden native question or permission" },
	{ command: "quit", description: "Exit Phi" },
];

export function localAutocompleteCommands(): import("@earendil-works/pi-tui").SlashCommand[] {
	const aliases = LOCAL_COMMANDS.filter((entry) => entry.shortAlias)
		.map((entry) => ({ name: entry.command, description: entry.description }));
	return [
		...aliases,
		{
			name: "phi",
			description: "Local Phi commands",
			getArgumentCompletions(argumentPrefix) {
				const prefix = argumentPrefix.trimStart();
				if (/\s/u.test(prefix)) return null;
				const local = LOCAL_COMMANDS.map((entry) => ({
					value: entry.command,
					label: entry.command,
					description: entry.description,
				}));
				const argumentControls = [
					{ value: "resume", label: "resume", description: "<id> — Resume an SDK session" },
					{ value: "attach", label: "attach", description: "<path> — Attach an image" },
					{ value: "send", label: "send", description: "<text> — Submit literal text" },
				].filter((item) => !LOCAL_COMMANDS.some((entry) => entry.command === item.value));
				return [...local, ...argumentControls].filter((item) => item.value.startsWith(prefix));
			},
		},
	];
}

export class PhiAutocompleteProvider extends CombinedAutocompleteProvider {
	override getSuggestions(lines: string[], cursorLine: number, cursorCol: number, options: { signal: AbortSignal; force?: boolean }) {
		const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
		// pi-tui requests file completion on Tab after a slash command's first space.
		const localSubcommand = /^\s*\/phi +[^\s]*$/u.test(beforeCursor);
		return super.getSuggestions(lines, cursorLine, cursorCol, localSubcommand ? { ...options, force: false } : options);
	}
}

class CommandPaletteView implements Component {
	private readonly filter = new Input({ prompt: "Find: ", placeholder: "Type to filter commands" });
	private choices: PaletteCommandChoice[] = [];
	private list: SelectList;
	private listVisibleRows = 0;
	private listStartRow = 0;

	constructor(
		private readonly tui: TuiMainScreen,
		private readonly onSelect: (choice: PaletteCommandChoice) => void,
		private readonly onCancel: () => void,
	) {
		this.filter.focused = true;
		this.list = this.createList(this.visibleRows());
	}

	setChoices(choices: PaletteCommandChoice[]): void {
		const selectedValue = this.list.getSelectedItem()?.value;
		this.choices = choices;
		this.list = this.createList(this.visibleRows());
		const visible = this.filteredChoices();
		const selectedIndex = visible.findIndex((choice) => choice.value === selectedValue);
		if (selectedIndex >= 0) this.list.setSelectedIndex(selectedIndex);
	}

	resetFilter(): void {
		this.filter.setValue("");
		this.list = this.createList(this.visibleRows());
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.up) || matchesKey(data, Key.down) || matchesKey(data, Key.enter)
			|| matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.list.handleInput(data);
			return;
		}
		this.filter.handleInput(data);
		this.list = this.createList(this.visibleRows());
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.y < this.listStartRow) return undefined;
		return this.list.handleMouse({ ...event, y: event.y - this.listStartRow });
	}

	invalidate(): void {
		this.filter.invalidate();
		this.list.invalidate();
	}

	render(width: number): string[] {
		this.ensureListSize();
		const title = new Text(theme.accent("Command palette"), 0, 0).render(width);
		const description = new Text(theme.dim("SDK commands and local Phi controls"), 0, 0).render(width);
		const filter = this.filter.render(width);
		this.listStartRow = title.length + description.length + filter.length;
		return [...title, ...description, ...filter, ...this.list.render(width),
			...new Text(theme.dim("Up/Down move · Enter run · Esc close"), 0, 0).render(width)]
			.map((line) => theme.overlayLine(line, width));
	}

	private ensureListSize(): void {
		const visibleRows = this.visibleRows();
		if (visibleRows === this.listVisibleRows) return;
		const selectedValue = this.list.getSelectedItem()?.value;
		this.list = this.createList(visibleRows);
		const selectedIndex = this.filteredChoices().findIndex((choice) => choice.value === selectedValue);
		if (selectedIndex >= 0) this.list.setSelectedIndex(selectedIndex);
	}

	private visibleRows(): number {
		const terminalRows = Math.max(1, this.tui.terminal.rows);
		const overlayHeight = Math.max(1, Math.min(Math.floor(terminalRows * 0.8), terminalRows - 2));
		return Math.max(1, Math.min(12, overlayHeight - 5));
	}

	private createList(maxVisible: number): SelectList {
		this.listVisibleRows = maxVisible;
		const list = new SelectList(this.filteredChoices(), maxVisible, theme.selectList);
		list.onSelect = (item) => this.onSelect(item as PaletteCommandChoice);
		list.onCancel = this.onCancel;
		return list;
	}

	private filteredChoices(): PaletteCommandChoice[] {
		const query = this.filter.getValue().trim().toLowerCase();
		return this.choices.filter((choice) => `${choice.label} ${choice.description ?? ""}`.toLowerCase().includes(query));
	}
}

export class AppCommandPaletteController {
	private overlay: OverlayHandle | undefined;
	private isVisible = false;
	private restoreDialogOnDismiss = false;
	private nativeCommands: readonly SlashCommand[] = [];
	private readonly view: CommandPaletteView;

	constructor(
		private readonly tui: TuiMainScreen,
		private readonly editor: Editor,
		private readonly onSelect: (choice: PaletteCommandChoice) => void,
		private readonly onClose: (restoreDialog: boolean) => void,
		private readonly onChange: () => void,
	) {
		this.view = new CommandPaletteView(
			tui,
			(choice) => {
				this.hide();
				this.onSelect(choice);
			},
			() => this.hide(),
		);
		this.view.setChoices(this.choices());
	}

	get visible(): boolean {
		return this.isVisible;
	}

	setNativeCommands(commands: readonly SlashCommand[]): void {
		this.nativeCommands = [...commands];
		this.view.setChoices(this.choices());
		if (this.isVisible) {
			this.tui.requestRender();
			this.onChange();
		}
	}

	show(restoreDialog: boolean): void {
		this.restoreDialogOnDismiss = restoreDialog;
		this.view.resetFilter();
		this.view.setChoices(this.choices());
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
	}

	handleInput(data: string): void {
		if (!this.isVisible) return;
		this.view.handleInput(data);
		this.onChange();
	}

	hide(restoreDialog = this.restoreDialogOnDismiss): void {
		if (!this.overlay || !this.isVisible) return;
		this.isVisible = false;
		this.overlay.setHidden(true);
		this.overlay.unfocus({ target: this.editor });
		this.onClose(restoreDialog);
		this.onChange();
	}

	private choices(): PaletteCommandChoice[] {
		const local = LOCAL_COMMANDS.map((entry) => {
			const command = entry.shortAlias ? `/${entry.command}` : `/phi ${entry.command}`;
			return {
				value: entry.shortAlias ? entry.command : `phi ${entry.command}`,
				label: command,
				description: entry.description,
				kind: "local" as const,
				command,
			};
		});
		const nativeNames = this.nativeCommands.flatMap((entry) => [entry.name, ...(entry.aliases ?? [])]);
		const seen = new Set<string>();
		const native = nativeNames.flatMap((name) => {
			if (!name || /[\r\n\u0000]/u.test(name) || seen.has(name) || name === "model" || name === "effort") return [];
			seen.add(name);
			const command = this.nativeCommands.find((entry) => entry.name === name || entry.aliases?.includes(name));
			const details = [command?.argumentHint, command?.description].filter((value): value is string => Boolean(value));
			return [{
				value: name,
				label: `/${sanitizeTerminalText(name)}`,
				description: details.map(sanitizeTerminalText).join(" · ") || "SDK command",
				kind: "native" as const,
				command: name,
			}];
		});
		return [...native, ...local];
	}
}
