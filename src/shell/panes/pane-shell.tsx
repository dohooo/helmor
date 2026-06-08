// src/shell/panes/pane-shell.tsx
import { type ReactNode, useMemo } from "react";
import { PaneErrorBoundary } from "./error-boundary";
import { PaneIdentityContext } from "./identity-context";
import type { Pane, PaneIdentity } from "./types";

interface PaneShellProps {
	pane: Pane;
	children: ReactNode;
}

export function PaneShell({ pane, children }: PaneShellProps) {
	const identity = useMemo<PaneIdentity>(
		() => ({
			paneId: pane.id,
			workspaceId: pane.workspaceId,
			sessionId: pane.sessionId,
		}),
		[pane.id, pane.workspaceId, pane.sessionId],
	);

	return (
		<PaneIdentityContext.Provider value={identity}>
			<PaneErrorBoundary>{children}</PaneErrorBoundary>
		</PaneIdentityContext.Provider>
	);
}
