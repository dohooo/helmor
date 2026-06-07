import * as SecureStore from "expo-secure-store";

import { isNativePairing, type NativePairing } from "./pairing";

const PAIRING_KEY = "helmor.native.pairing";

export async function loadPairing(): Promise<NativePairing | null> {
	const raw = await SecureStore.getItemAsync(PAIRING_KEY);
	if (!raw) return null;

	try {
		const parsed = JSON.parse(raw);
		return isNativePairing(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

export async function savePairing(pairing: NativePairing): Promise<void> {
	await SecureStore.setItemAsync(PAIRING_KEY, JSON.stringify(pairing));
}

export async function clearPairing(): Promise<void> {
	await SecureStore.deleteItemAsync(PAIRING_KEY);
}
