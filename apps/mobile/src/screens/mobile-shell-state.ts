import type { NativePairing } from "../lib/pairing";

export type MobileShellRoute = "booting" | "paired" | "connectionGuide";

type MobileShellStateInput = {
	booting: boolean;
	pairing: NativePairing | null;
};

export function resolveMobileShellRoute({
	booting,
	pairing,
}: MobileShellStateInput): MobileShellRoute {
	if (booting) return "booting";
	if (pairing) return "paired";
	return "connectionGuide";
}
