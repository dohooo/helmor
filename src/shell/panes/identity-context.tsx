// src/shell/panes/identity-context.tsx
import { createContext, useContext } from "react";
import type { PaneIdentity } from "./types";

export const PaneIdentityContext = createContext<PaneIdentity | null>(null);

export function usePaneIdentity(): PaneIdentity {
	const value = useContext(PaneIdentityContext);
	if (!value) {
		throw new Error(
			"usePaneIdentity must be used inside <PaneShell>. Check that <PanesProvider> + <PanesGrid> wrap this subtree.",
		);
	}
	return value;
}
