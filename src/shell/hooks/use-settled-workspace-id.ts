// Rapid-switch settle gate for the per-workspace DATA load (the forge/detail/
// git query cluster + the inspector's git-diff). The selection HIGHLIGHT must
// track the router param on every keypress (it's cheap), but the heavy data
// cluster keyed off that same id fires 5 React Query IPCs + a git-diff +
// synchronous inspector render PER intermediate workspace during a held burst.
// This hook returns a workspace id that lags the live router selection just
// enough that only the workspace the user SETTLES on pays the load.
//
// Conservative, single-switch-preserving rules:
//   - `null` (Start surface) settles INSTANTLY — clearing the inspector is cheap
//     and must never lag.
//   - A target whose workspace detail is ALREADY cached settles INSTANTLY, in
//     the SAME render as the highlight — re-visiting a warm workspace shows its
//     cached data with no added delay or extra render, exactly as before.
//   - A genuinely COLD (never-visited) target settles after a short trailing
//     window. A SINGLE/slow cold switch has no further keypress to reset the
//     timer, so it fires after one window (~a frame or two) — imperceptible. A
//     held burst keeps resetting the timer, so the cluster only fires for the id
//     the user lands on.
//   - While `selectedWorkspaceId` DIVERGES from `displayedWorkspaceId` (a
//     deferred or held displayed flip is in flight) the gate keeps returning
//     the previous settled id — the inspector must swap in the SAME commit as
//     the held content, so neither warm targets nor the cold timer may advance
//     it mid-hold. Convergence re-applies the warm/cold rules above.
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { WorkspaceDetail } from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";

// Trailing window for cold targets only. Short enough that a single cold switch
// feels immediate; long enough to coalesce a held Cmd+Opt+Down burst (keys
// arrive ~tens of ms apart while held).
const COLD_SETTLE_DELAY_MS = 140;

export function useSettledWorkspaceId(
	selectedWorkspaceId: string | null,
	displayedWorkspaceId: string | null,
): string | null {
	const queryClient = useQueryClient();

	const isDiverged = selectedWorkspaceId !== displayedWorkspaceId;

	// Warm = the cheap path (Start, or a workspace whose detail is already in the
	// cache). Read synchronously in render so a warm/single/slow switch resolves
	// in the SAME commit as the highlight — no extra render, no perceived lag.
	const isWarm =
		selectedWorkspaceId === null ||
		queryClient.getQueryData<WorkspaceDetail | null>(
			helmorQueryKeys.workspaceDetail(selectedWorkspaceId),
		) !== undefined;

	// Fallback id shown while a COLD target is still settling. Held in a ref so
	// warm switches can advance it during render WITHOUT triggering an extra
	// render; the cold timer below bumps `coldSettleTick` to force the re-render
	// when the deferred load is finally allowed to start.
	const coldFallbackRef = useRef(selectedWorkspaceId);
	const [, setColdSettleTick] = useState(0);
	if (isWarm && !isDiverged) {
		// A warm target is safe to load immediately — keep the cold fallback
		// pointed at it so a subsequent cold switch falls back to the latest warm
		// id. Ref write during render is a pure cache update (idempotent).
		coldFallbackRef.current = selectedWorkspaceId;
	}

	const settledWorkspaceId =
		isWarm && !isDiverged ? selectedWorkspaceId : coldFallbackRef.current;

	useEffect(() => {
		// Warm targets already committed synchronously above — nothing to defer.
		// A diverged target must not start the cold timer either: the settled id
		// holds until the displayed flip lands (convergence re-runs this effect).
		if (isWarm || isDiverged) return;
		// Cold target: defer to the trailing edge. A newer keypress re-runs this
		// effect and clears the pending timer, so only the settled id advances.
		const timer = window.setTimeout(() => {
			coldFallbackRef.current = selectedWorkspaceId;
			setColdSettleTick((tick) => tick + 1);
		}, COLD_SETTLE_DELAY_MS);
		return () => window.clearTimeout(timer);
	}, [selectedWorkspaceId, isWarm, isDiverged]);

	return settledWorkspaceId;
}
