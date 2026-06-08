// src/shell/panes/index.ts

export { PaneErrorBoundary } from "./error-boundary";
export { PanesGrid } from "./grid";
export { PaneIdentityContext, usePaneIdentity } from "./identity-context";
export { PaneShell } from "./pane-shell";
export type { PanesContextValue, PanesState } from "./provider";
export {
	PanesProvider,
	usePanes,
	useSyncDefaultPaneToSelection,
} from "./provider";
export type { Pane, PaneIdentity, PaneTarget } from "./types";
