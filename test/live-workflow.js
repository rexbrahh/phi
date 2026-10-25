export const meta = {
	name: "phi-live-acceptance",
	description: "Run two bounded native agents for Phi live acceptance",
	phases: ["Parallel fixture probes"],
};

const LIVE_MODEL = "claude-haiku-5-5";
const STOPPED_MONITOR_INPUT = {
	description: "Wait for the stopped agent release file",
	timeout_ms: 60000,
	command: "until [ -f .phi-live-agent-stopped.release ]; do sleep 1; done",
};
const CONTINUED_MONITOR_INPUT = {
	description: "Wait for the continued agent release file",
	timeout_ms: 60000,
	command: "until [ -f .phi-live-agent-continued.release ]; do sleep 1; done",
};

phase("Parallel fixture probes");

await parallel([
	() => agent(
		`Call Monitor exactly once with this input: ${JSON.stringify(STOPPED_MONITOR_INPUT)}. Wait for the Monitor call to finish. Then return only phi-live-agent-stopped. Do not use other tools or edit files.`,
		{
			label: "phi-live-agent-stopped",
			model: LIVE_MODEL,
		},
	),
	() => agent(
		`Call Monitor exactly once with this input: ${JSON.stringify(CONTINUED_MONITOR_INPUT)}. Wait for the Monitor call to finish. Then return only phi-live-agent-continued. Do not use other tools or edit files.`,
		{
			label: "phi-live-agent-continued",
			model: LIVE_MODEL,
		},
	),
]);
