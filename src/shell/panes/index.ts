// src/shell/panes/index.ts
export { PaneIdentityContext, usePaneIdentity } from "./identity-context";
export { PanesProvider, usePanes, useSyncDefaultPaneToSelection } from "./provider";
export type { PanesContextValue, PanesState } from "./provider";
export { PaneErrorBoundary } from "./error-boundary";
export { PaneShell } from "./pane-shell";
export { PanesGrid } from "./grid";
export type { Pane, PaneIdentity, PaneTarget } from "./types";
