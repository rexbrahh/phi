import type { PhiState } from "./state.js";

export function recordSubmittedInput(state: PhiState, uuid: string): void {
	if (!state.inputReceipts.has(uuid)) state.inputReceipts.set(uuid, { uuid, status: "submitted" });
}

export function markInputsDeliveryUnknown(state: PhiState, uuids: readonly string[]): void {
	for (const uuid of uuids) {
		const receipt = state.inputReceipts.get(uuid);
		if (receipt && receipt.status !== "consumed") receipt.status = "delivery_unknown";
	}
}

export function markConsumedInputs(state: PhiState, single?: string, multiple?: string[]): void {
	const ids = multiple?.length ? multiple : single ? [single] : [];
	for (const uuid of ids) {
		const receipt = state.inputReceipts.get(uuid);
		if (receipt) receipt.status = "consumed";
	}
}
