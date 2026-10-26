import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const markerPath = process.env.PHI_PTY_EDITOR_MARKERS;
const gatePath = process.env.PHI_PTY_EDITOR_GATE;
const writesPath = process.env.PHI_PTY_EDITOR_WRITES;
const promptPath = process.argv[2];
const helperMode = process.argv[2] === "--helper";

if (!markerPath || !gatePath || !writesPath || (!promptPath && !helperMode)) throw new Error("PTY editor marker, gate, writes, and prompt paths are required");

function record(event, detail = {}) {
	appendFileSync(markerPath, `${JSON.stringify({ event, ...detail })}\n`, "utf8");
}

if (helperMode) {
	process.on("SIGTERM", () => record("helper-terminated", { pid: process.pid, signal: "SIGTERM" }));
	const write = () => appendFileSync(writesPath, `${Date.now()}\n`, "utf8");
	write();
	setInterval(write, 20);
	record("helper-started", { pid: process.pid });
} else {
	const helper = process.env.PHI_PTY_EDITOR_HELPER === "1"
		? spawn(process.execPath, [process.argv[1], "--helper"], { stdio: "inherit" })
		: undefined;

	record("editor-started", {
		pid: process.pid,
		...(helper ? { helperPid: helper.pid } : {}),
		promptPath,
		content: readFileSync(promptPath, "utf8"),
	});

	let input = "";
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk) => {
		input += chunk;
		const newline = input.indexOf("\n");
		if (newline < 0) return;
		record("editor-input", { content: input.slice(0, newline) });
		input = input.slice(newline + 1);
	});

	process.on("SIGTERM", () => {
		record("editor-terminated", { pid: process.pid, signal: "SIGTERM" });
		process.exit(143);
	});

	const deadline = Date.now() + 8_000;
	while (!existsSync(gatePath)) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for the PTY editor release gate");
		await delay(10);
	}

	const content = "edited draft first\nedited draft second";
	writeFileSync(promptPath, content, "utf8");
	record("editor-edited", { content });
	process.exit(0);
}
