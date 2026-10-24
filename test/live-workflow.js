export const meta = {
	name: "phi-live-acceptance",
	description: "Run two bounded native agents for Phi live acceptance",
	phases: ["Parallel fixture probes"],
};

phase("Parallel fixture probes");

await parallel([
	() => agent("Run `sleep 90` once, then return only `phi-live-agent-stopped`. Do not edit files.", {
		label: "phi-live-agent-stopped",
	}),
	() => agent("Run `sleep 90` once, then return only `phi-live-agent-continued`. Do not edit files.", {
		label: "phi-live-agent-continued",
	}),
]);
