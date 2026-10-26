import { indexedColor, styleText, visibleWidth, type MarkdownTheme, type SelectListTheme } from "@earendil-works/pi-tui";
import type { EditorTheme } from "@earendil-works/pi-tui";

const accent = (text: string): string => styleText(text, { fg: indexedColor(81), bold: true }, "256color");
const dim = (text: string): string => styleText(text, { fg: indexedColor(245) }, "256color");
const code = (text: string): string => styleText(text, { fg: indexedColor(220) }, "256color");
const plain = (text: string): string => text;

export const markdownTheme: MarkdownTheme = {
	heading: accent,
	link: accent,
	linkUrl: dim,
	code,
	codeBlock: plain,
	codeBlockBorder: dim,
	quote: dim,
	quoteBorder: dim,
	hr: dim,
	listBullet: accent,
	bold: (text) => styleText(text, { bold: true }, "256color"),
	italic: (text) => styleText(text, { italic: true }, "256color"),
	strikethrough: (text) => styleText(text, { strikethrough: true }, "256color"),
	underline: (text) => styleText(text, { underline: true }, "256color"),
};

export const selectListTheme: SelectListTheme = {
	selectedPrefix: accent,
	selectedText: accent,
	description: dim,
	scrollInfo: dim,
	noMatch: dim,
};

export const editorTheme: EditorTheme = {
	borderColor: dim,
	selectList: selectListTheme,
};

export const theme = {
	accent,
	dim,
	overlayLine: (line: string, width: number): string => styleText(
		line + " ".repeat(Math.max(0, width - visibleWidth(line))),
		{ fg: indexedColor(252), bg: indexedColor(236) }, "256color",
	),
	markdown: markdownTheme,
	selectList: selectListTheme,
	editor: editorTheme,
};
