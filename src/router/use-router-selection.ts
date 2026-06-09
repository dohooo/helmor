// Stage 3b: select-narrowed router reads for the panes.
//
// The router is now the single source of truth for navigation INTENT
// (`viewMode`, `selectedWorkspaceId`, `selectedSessionId`). Panes read it
// through these `useRouterState({ select })` hooks instead of subscribing to
// the selection store. The router is created with `defaultStructuralSharing:
// true`, so `useRouterState`'s `replaceEqualDeep` keeps the returned slice
// referentially stable when the underlying values are unchanged — both for
// primitive selectors and the combined `{ workspaceId, sessionId, viewMode }`
// object. That stability is what preserves the perf model (no re-render when an
// unrelated location field changes; P1-A header memo identity holds inside the
// `"use no memo"` conversation subtree).
//
// `displayed*` and `reselectTick` stay in the selection store (the paint track
// + mark-read signal) — they are NOT in the URL and are read separately.

import { useRouterState } from "@tanstack/react-router";
import {
	type LocationSelection,
	locationToSelection,
} from "./location-mapping";

// The full selection intent, structurally shared so identity is stable across
// renders unless one of the three values changes.
export function useRouterSelection(): LocationSelection {
	return useRouterState({
		select: (state) =>
			locationToSelection({
				pathname: state.location.pathname,
				search: state.location.search as { view?: string },
			}),
	});
}

// Primitive selectors for panes that only need one bit of the location. Each
// returns a primitive, so structural sharing is irrelevant — referential
// equality already gates the re-render.
export function useRouterSelectedWorkspaceId(): string | null {
	return useRouterState({
		select: (state) =>
			locationToSelection({
				pathname: state.location.pathname,
				search: state.location.search as { view?: string },
			}).workspaceId,
	});
}

export function useRouterIsStart(): boolean {
	return useRouterState({
		select: (state) => state.location.pathname === "/start",
	});
}

export function useRouterIsEditor(): boolean {
	return useRouterState({
		select: (state) =>
			(state.location.search as { view?: string }).view === "editor",
	});
}
