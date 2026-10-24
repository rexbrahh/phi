import { stripTerminalSequences } from "@earendil-works/pi-tui";

const DISALLOWED_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

export function sanitizeTerminalText(value: string): string {
	return stripTerminalSequences(value).replace(DISALLOWED_CONTROLS, "");
}
