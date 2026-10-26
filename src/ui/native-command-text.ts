export function nativeCommandText(text: string): { kind: "command" | "output"; text: string } | undefined {
	const output = /^<local-command-(stdout|stderr)>([\s\S]*)<\/local-command-\1>(?![\s\S])/.exec(text);
	if (output) {
		const content = output[2]!;
		if (containsNativeEnvelopeTag(content)) return undefined;
		return { kind: "output", text: content };
	}

	const command = /^<command-message>([\s\S]*?)<\/command-message>\r?\n<command-name>([\s\S]*?)<\/command-name>(?:\r?\n<command-args>([\s\S]*?)<\/command-args>)?(?![\s\S])/.exec(text);
	if (!command) return undefined;

	const message = command[1]!;
	const name = command[2]!;
	const args = command[3];
	if (message.trim().length === 0 || /[<>]/.test(message) || !/^\/[^\s<>]+$/.test(name)) return undefined;
	if (args !== undefined && containsNativeEnvelopeTag(args)) return undefined;

	return { kind: "command", text: args ? `${name} ${args}` : name };
}

function containsNativeEnvelopeTag(text: string): boolean {
	return /<\/?(?:command-message|command-name|command-args|local-command-(?:stdout|stderr))>/.test(text);
}
