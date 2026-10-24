import { Input, SelectList, Text, TuiMainScreen, type Component, type Editor, type OverlayHandle, type SelectItem, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
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
}

const LOCAL_COMMANDS: readonly LocalPaletteCommand[] = [
	{ command: "help", description: "Show local Phi commands" },
	{ command: "status", description: "Show session status" },
	{ command: "context", description: "Show SDK context usage" },
	{ command: "model", description: "Choose a model" },
	{ command: "effort", description: "Choose an effort level" },
	{ command: "permissions", description: "Choose a permission mode" },
	{ command: "tasks", description: "Open the Tasks inspector" },
	{ command: "workflows", description: "Open workflow task details" },
	{ command: "transcript", description: "Open transcript history" },
	{ command: "copy", description: "Copy selected output" },
	{ command: "sessions", description: "List SDK sessions" },
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

class CommandPaletteView implements Component {
	private readonly filter = new Input({ prompt: "Find: ", placeholder: "Type to filter commands" });
	private choices: PaletteCommandChoice[] = [];
	private list = this.createList();
	private listStartRow = 0;

	constructor(
		private readonly onSelect: (choice: PaletteCommandChoice) => void,
		private readonly onCancel: () => void,
	) {
		this.filter.focused = true;
	}

	setChoices(choices: PaletteCommandChoice[]): void {
		const selectedValue = this.list.getSelectedItem()?.value;
		this.choices = choices;
		this.list = this.createList();
		this.list.setFilter(this.filter.getValue());
		const visible = this.choices.filter((choice) => choice.value.toLowerCase().startsWith(this.filter.getValue().toLowerCase()));
		const selectedIndex = visible.findIndex((choice) => choice.value === selectedValue);
		if (selectedIndex >= 0) this.list.setSelectedIndex(selectedIndex);
	}

	resetFilter(): void {
		this.filter.setValue("");
		this.list.setFilter("");
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.up) || matchesKey(data, Key.down) || matchesKey(data, Key.enter)
			|| matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.list.handleInput(data);
			return;
		}
		this.filter.handleInput(data);
		this.list.setFilter(this.filter.getValue());
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
		const title = new Text(theme.accent("Command palette")).render(width);
		const description = new Text(theme.dim("SDK commands and local Phi controls")).render(width);
		const filter = this.filter.render(width);
		this.listStartRow = title.length + description.length + filter.length;
		return [...title, ...description, ...filter, ...this.list.render(width),
			...new Text(theme.dim("Up/Down move · Enter run · Esc close")).render(width)];
	}

	private createList(): SelectList {
		const list = new SelectList(this.choices, 12, theme.selectList);
		list.onSelect = (item) => this.onSelect(item as PaletteCommandChoice);
		list.onCancel = this.onCancel;
		return list;
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
			(choice) => {
				this.hide(false);
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
		const local = LOCAL_COMMANDS.map((entry) => ({
			value: `phi ${entry.command}`,
			label: `/phi ${entry.command}`,
			description: entry.description,
			kind: "local" as const,
			command: `/phi ${entry.command}`,
		}));
		const nativeNames = this.nativeCommands.flatMap((entry) => [entry.name, ...(entry.aliases ?? [])]);
		const seen = new Set<string>();
		const native = nativeNames.flatMap((name) => {
			if (!name || /[\r\n\u0000]/u.test(name) || seen.has(name)) return [];
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
