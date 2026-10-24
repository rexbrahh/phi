export function formatErrorText(error: unknown, selectedApiKey?: string): string {
	const message = error instanceof Error ? error.message : String(error);
	return selectedApiKey ? message.split(selectedApiKey).join("[redacted API key]") : message;
}
