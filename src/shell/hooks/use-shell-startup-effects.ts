import { useEffect } from "react";
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
	openWorkspaceStart,
	closeStartContextPreview,
}: {
	lastSurface: AppSurface;
	areSettingsLoaded: boolean;
	workspaceViewMode: ShellViewMode;
	selectedWorkspaceId: string | null;
	displayedWorkspaceId: string | null;
	startRepositoryId: string | undefined;
	openWorkspaceStart: (opts?: { persist?: boolean }) => void;
	closeStartContextPreview: () => void;
}) {
	useEffect(() => {
		if (!areSettingsLoaded || lastSurface !== "workspace-start") {
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
	useEffect(() => {
		closeStartContextPreview();
	}, [startRepositoryId, closeStartContextPreview]);
}
