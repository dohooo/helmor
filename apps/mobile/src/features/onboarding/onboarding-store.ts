import * as SecureStore from "expo-secure-store";

const ONBOARDING_COMPLETED_KEY = "helmor.native.onboarding_completed_v1";

export async function loadOnboardingCompleted(): Promise<boolean> {
	try {
		return (
			(await SecureStore.getItemAsync(ONBOARDING_COMPLETED_KEY)) === "true"
		);
	} catch {
		return false;
	}
}

export async function saveOnboardingCompleted(): Promise<void> {
	await SecureStore.setItemAsync(ONBOARDING_COMPLETED_KEY, "true");
}
