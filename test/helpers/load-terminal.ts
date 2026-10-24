import { performance } from "node:perf_hooks";
import { FakeTerminal } from "./terminal.js";

const FRAME_END = "\u001b[?2026l";

export class LoadTerminal extends FakeTerminal {
	readonly frameWriteTimes: number[] = [];
	onFrameWrite: ((time: number) => void) | undefined;

	override write(data: string): void {
		if (!data.includes(FRAME_END)) return;
		const writtenAt = performance.now();
		this.frameWriteTimes.push(writtenAt);
		this.onFrameWrite?.(writtenAt);
	}
}
