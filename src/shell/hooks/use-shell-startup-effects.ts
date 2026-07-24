import { useEffect, useRef } from "react";
import type { AppSurface } from "@/lib/settings";
import type { ShellViewMode } from "@/shell/controllers/use-selection-controller";

/**
 * Two AppShell startup side-effects, extracted verbatim (Phase 2 split):
 *
 * 1. `lastSurface` restore — after settings load, if the user's persisted
 *    surface was `workspace-start`, re-open the start surface (without
 *    re-persisting) unless we're already sitting on a clean start view.
 * 2. start-preview close — whenever the start surface's selected repository
 *    changes, dismiss any open start context preview card.
 *
 * Pure side-effect carrier: it owns no state and returns nothing. The pivot
 * actions `openWorkspaceStart` (selection.openStart) and
 * `closeStartContextPreview` stay owned by their controllers and are threaded
 * in. Dependency arrays are preserved exactly as the original inline effects.
 */
export function useShellStartupEffects({
	lastSurface,
	areSettingsLoaded,
	workspaceViewMode,
	selectedWorkspaceId,
	displayedWorkspaceId,
	startRepositoryId,
	lastWorkspaceId,
	workspaceGroupsSettled,
	hasAnyWorkspace,
	openWorkspaceStart,
	closeStartContextPreview,
}: {
	lastSurface: AppSurface;
	areSettingsLoaded: boolean;
	workspaceViewMode: ShellViewMode;
	selectedWorkspaceId: string | null;
	displayedWorkspaceId: string | null;
	startRepositoryId: string | undefined;
	/** Persisted last-selected workspace (boot-restore target), if any. */
	lastWorkspaceId: string | null;
	/** True once the workspace-groups query has SUCCEEDED (not loading/error). */
	workspaceGroupsSettled: boolean;
	hasAnyWorkspace: boolean;
	openWorkspaceStart: (opts?: { persist?: boolean }) => void;
	closeStartContextPreview: () => void;
}) {
	// One-shot boot restore. The persisted `lastSurface` says WHICH surface to
	// restore, but persistence is now the async single `onResolved` settings
	// writer, so `appSettings.lastSurface` lags a synchronous router navigation
	// by a tick. Re-running this on every dep change therefore bounced the user
	// back to Start the instant they navigated AWAY from it: the router-derived
	// `workspaceViewMode` flips to "conversation" synchronously while
	// `lastSurface` is still "workspace-start", so the effect re-fired
	// `openWorkspaceStart`. This is a startup decision — make it exactly once
	// (after settings load), then never again, so it is timing-independent.
	const bootStartRestoreAppliedRef = useRef(false);
	useEffect(() => {
		if (bootStartRestoreAppliedRef.current || !areSettingsLoaded) {
			return;
		}
		bootStartRestoreAppliedRef.current = true;
		if (lastSurface !== "workspace-start") {
			return;
		}
		if (
			workspaceViewMode === "start" &&
			selectedWorkspaceId === null &&
			displayedWorkspaceId === null
		) {
			return;
		}
		openWorkspaceStart({ persist: false });
	}, [
		lastSurface,
		areSettingsLoaded,
		displayedWorkspaceId,
		openWorkspaceStart,
		selectedWorkspaceId,
		workspaceViewMode,
	]);
	// WP7 Gate 4: brand-new user (no persisted selection, no workspaces) must
	// land on the Start surface ("new chat"), not the empty `/` boot index with
	// a dead composer. Decided EXACTLY ONCE, and only after BOTH settings and
	// the workspace-groups query have settled — deciding while groups are still
	// loading would hijack a returning user to Start before their data arrives
	// (`workspaceGroupsSettled` is `isSuccess`, so loading AND error both wait).
	const bootEmptyStartAppliedRef = useRef(false);
	useEffect(() => {
		if (
			bootEmptyStartAppliedRef.current ||
			!areSettingsLoaded ||
			!workspaceGroupsSettled
		) {
			return;
		}
		// Both inputs settled — this boot decision is now final either way.
		bootEmptyStartAppliedRef.current = true;
		if (lastWorkspaceId !== null || hasAnyWorkspace) return;
		if (
			workspaceViewMode === "start" &&
			selectedWorkspaceId === null &&
			displayedWorkspaceId === null
		) {
			return;
		}
		openWorkspaceStart({ persist: false });
	}, [
		areSettingsLoaded,
		workspaceGroupsSettled,
		lastWorkspaceId,
		hasAnyWorkspace,
		workspaceViewMode,
		selectedWorkspaceId,
		displayedWorkspaceId,
		openWorkspaceStart,
	]);
	useEffect(() => {
		closeStartContextPreview();
	}, [startRepositoryId, closeStartContextPreview]);
}
