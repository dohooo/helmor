// src/shell/panes/types.ts

/**
 * Where a pane lives. `"main"` = a cell in the main window's grid.
 * `{ window: <label> }` = a detached Tauri WebviewWindow (PR 4+).
 */
export type PaneTarget = "main" | { window: string };

/**
 * One open chat surface. PR 1 only ever creates a single pane with
 * id `"default"` and target `"main"`. The fields are shaped for the full
 * multi-pane feature so later PRs can fill them out without renaming.
 */
export interface Pane {
	id: string;
	workspaceId: string | null;
	sessionId: string | null;
	target: PaneTarget;
}

/**
 * Subset of `Pane` exposed to descendants of `<PaneShell>` via context. Kept
 * narrow so future fields on `Pane` don't ripple into every consumer.
 */
export interface PaneIdentity {
	paneId: string;
	workspaceId: string | null;
	sessionId: string | null;
}
