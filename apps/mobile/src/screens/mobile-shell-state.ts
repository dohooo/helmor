import type { NativePairing } from "../lib/pairing";

export type MobileShellRoute = "booting" | "paired" | "onboarding" | "pairing";

type MobileShellStateInput = {
	booting: boolean;
	onboardingCompleted: boolean;
	pairing: NativePairing | null;
};

export function resolveMobileShellRoute({
	booting,
	onboardingCompleted,
	pairing,
}: MobileShellStateInput): MobileShellRoute {
	if (booting) return "booting";
	if (pairing) return "paired";
	if (!onboardingCompleted) return "onboarding";
	return "pairing";
}
