import { useCallback, useEffect, useMemo, useRef } from "react";
import {
	type QuickSwitchControls,
	type QuickSwitchSnapshot,
	useQuickSwitch,
	WorkspaceMruStack,
} from "@/features/quick-switch";
import type { WorkspaceGroup, WorkspaceRow } from "@/lib/api";
import { flattenWorkspaceRows } from "@/shell/layout";

/**
 * Ctrl+Tab quick-switch + the MRU stack that orders it. Extracted verbatim
 * from AppShell (Phase 2 split).
 *
 * Owns the in-memory `WorkspaceMruStack` (resets on restart by design) and the
 * single effect that touches it whenever `selectedWorkspaceId` changes — every
 * selection entry point flows through that id, so one effect covers them all.
 * `liveWorkspaceRowMap` is returned for the overlay's `getRow` lookup;
 * `quickSwitch` drives the overlay + the quick-switch shortcut handlers. The
 * pivot setter `handleSelectWorkspace` stays in AppShell's orchestration layer
 * and is threaded in as `onCommit`. Dependency arrays are preserved exactly as
 * the original inline callbacks/effects.
 */
export function useWorkspaceQuickSwitch({
	workspaceGroups,
	selectedWorkspaceId,
	handleSelectWorkspace,
}: {
	workspaceGroups: WorkspaceGroup[];
	selectedWorkspaceId: string | null;
	handleSelectWorkspace: (workspaceId: string | null) => void;
}): {
	quickSwitch: QuickSwitchControls;
	liveWorkspaceRowMap: Map<string, WorkspaceRow>;
} {
	// MRU stack of workspace ids — drives Ctrl+Tab quick switch order.
	// In-memory only; resets on app restart by design.
	const workspaceMruRef = useRef<WorkspaceMruStack>(new WorkspaceMruStack());

	// Map workspace id -> live row (excluding archived). Used by the
	// quick-switch overlay to render cards and by buildSnapshot to filter
	// stale MRU ids.
	const liveWorkspaceRowMap = useMemo(() => {
		const map = new Map<string, WorkspaceRow>();
		for (const group of workspaceGroups) {
			for (const row of group.rows) map.set(row.id, row);
		}
		return map;
	}, [workspaceGroups]);

	// Whenever the selection changes, mark the workspace as most-recently-used.
	// All entry points (sidebar click, navigation hotkeys, quick-switch itself,
	// session restore) flow through `selection.selectedWorkspaceId`, so a
	// single effect here covers them all.
	useEffect(() => {
		if (selectedWorkspaceId) workspaceMruRef.current.touch(selectedWorkspaceId);
	}, [selectedWorkspaceId]);

	// MRU-ordered, archived-filtered, deduped list, capped at 4 cards
	// (current + 3 most recent). Live workspaces never touched by MRU are
	// appended in sidebar order so the overlay can still reach them on a
	// cold MRU.
	const buildQuickSwitchSnapshot = useCallback(
		(direction: "next" | "previous"): QuickSwitchSnapshot | null => {
			const QUICK_SWITCH_MAX_CARDS = 4;
			const orderedLive = flattenWorkspaceRows(workspaceGroups, []).map(
				(row) => row.id,
			);
			const liveSet = new Set(orderedLive);
			const mruIds = workspaceMruRef.current
				.list()
				.filter((id) => liveSet.has(id));
			const seen = new Set(mruIds);
			const tailIds = orderedLive.filter((id) => !seen.has(id));
			const ids = [...mruIds, ...tailIds].slice(0, QUICK_SWITCH_MAX_CARDS);
			if (ids.length < 2) return null;
			// MRU[0] is the current workspace (touched most recently); start
			// at index 1 for "next" so a single Ctrl+Tab tap commits the
			// previous workspace, exactly like Cmd+Tab.
			const initialIndex = direction === "next" ? 1 : ids.length - 1;
			return { ids, initialIndex };
		},
		[workspaceGroups],
	);

	const handleQuickSwitchCommit = useCallback(
		(workspaceId: string) => {
			handleSelectWorkspace(workspaceId);
		},
		[handleSelectWorkspace],
	);

	const quickSwitch = useQuickSwitch({
		buildSnapshot: buildQuickSwitchSnapshot,
		onCommit: handleQuickSwitchCommit,
	});

	return { quickSwitch, liveWorkspaceRowMap };
}
