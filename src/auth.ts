import { ensurePhiHome, readPhiApiKey, savePhiApiKey } from "./home.js";

export type PhiAuthPrompt = () => Promise<string | undefined>;

export async function preparePhiAuth(
	home: string,
	environment: NodeJS.ProcessEnv,
	prompt: PhiAuthPrompt,
): Promise<NodeJS.ProcessEnv | undefined> {
	await ensurePhiHome(home);

	const environmentKey = environment.ANTHROPIC_API_KEY;
	if (isValidApiKey(environmentKey)) return withApiKey(environment, environmentKey);

	const savedKey = await readPhiApiKey(home);
	if (savedKey !== undefined) return withApiKey(environment, savedKey);

	const promptedKey = await requestApiKey(prompt);
	if (promptedKey === undefined) return undefined;
	await savePhiApiKey(home, promptedKey);
	return withApiKey(environment, promptedKey);
}

export async function loginPhiAuth(home: string, prompt: PhiAuthPrompt): Promise<boolean> {
	const promptedKey = await requestApiKey(prompt);
	if (promptedKey === undefined) return false;
	await savePhiApiKey(home, promptedKey);
	return true;
}

export async function phiAuthSource(
	home: string,
	environment: NodeJS.ProcessEnv,
): Promise<"environment" | "saved" | "missing"> {
	if (isValidApiKey(environment.ANTHROPIC_API_KEY)) return "environment";
	return (await readPhiApiKey(home)) === undefined ? "missing" : "saved";
}

async function requestApiKey(prompt: PhiAuthPrompt): Promise<string | undefined> {
	try {
		return await prompt();
	} catch {
		throw new Error("Unable to prompt for Phi API key");
	}
}

function withApiKey(environment: NodeJS.ProcessEnv, apiKey: string): NodeJS.ProcessEnv {
	return { ...environment, ANTHROPIC_API_KEY: apiKey };
}

function isValidApiKey(apiKey: unknown): apiKey is string {
	return typeof apiKey === "string" && apiKey.length > 0 && !/[\s\p{Cc}]/u.test(apiKey);
}
