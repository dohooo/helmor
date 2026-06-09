// Pure, side-effect-free mapping between the selection triple
// (`viewMode`, `selectedWorkspaceId`, `selectedSessionId`) and the router's
// in-memory location. No React, no router, no Tauri — just data math, so it can
// be unit-tested in isolation and reused by the Stage 1 mirror, the Stage 3
// persistence writer, and the Stage 4 boot seeder.
//
// FULL viewMode representation (Stage 3a). `ShellViewMode` has three values —
// "conversation" | "editor" | "start" — and the router now encodes all three:
//
//   - "start"               → `/start`            (a DISTINCT route, NOT `/`)
//   - "conversation" + ws   → `/w/<ws>[/s/<sid>]` (no `?view`)
//   - "editor"      + ws    → `/w/<ws>[/s/<sid>]?view=editor`
//   - no workspace selected → `/`                 (transient boot index)
//
// Two things this fixes versus Stage 1, which only distinguished
// start-vs-workspace:
//   1. "start" no longer collapses onto `/`; it has its own `/start` route, so
//      it is no longer CONFLATED with "conversation + no workspace yet".
//   2. editor-vs-conversation is now encoded via the `?view` search param.
//
// `/` is reserved as the transient pre-auto-select boot index (a non-"start"
// selection with no workspace). Encoding contract for ids: the router
// interpolates path params with plain `encodeURIComponent` (it is created
// WITHOUT `pathParamsAllowedCharacters`), so the pathname produced here is
// byte-for-byte equal to `router.state.location.pathname` after a matching
// navigation. For ids with URL-reserved chars TanStack normalises the stored
// pathname with `decodeURI`, so structural comparison via `pathToSelection`
// (below) is the robust gate.

import type { AppSettings } from "@/lib/settings";
import type { ShellViewMode } from "@/shell/controllers/use-selection-controller";
import type { WorkspaceSearch } from "./index";

export type SelectionLocationInput = {
	viewMode: ShellViewMode;
	workspaceId: string | null;
	sessionId: string | null;
};

export type PathSelection = {
	workspaceId: string | null;
	sessionId: string | null;
};

// A `router.navigate`-ready target. `to` plus typed `params` and the FULL
// validated `search` (`{ view }`). Conversation passes `{ view: "conversation" }`
// — the `stripSearchParams({ view: "conversation" })` route middleware then
// removes that default from the URL, so the stored search is `{}` for
// conversation and `{ view: "editor" }` for editor (verified round-trip). The
// search is the full schema rather than a `Partial` so it satisfies navigate's
// required-search typing directly.
export type SelectionLocation =
	| { to: "/" }
	| { to: "/start" }
	| {
			to: "/w/$workspaceId";
			params: { workspaceId: string };
			search: WorkspaceSearch;
	  }
	| {
			to: "/w/$workspaceId/s/$sessionId";
			params: { workspaceId: string; sessionId: string };
			search: WorkspaceSearch;
	  };

// Editor carries `view: "editor"`; everything non-editor is "conversation"
// (which the route's strip middleware keeps out of the URL).
function viewSearch(viewMode: ShellViewMode): WorkspaceSearch {
	return { view: viewMode === "editor" ? "editor" : "conversation" };
}

/**
 * Compute the `router.navigate` target that mirrors the given selection.
 *
 * - `viewMode === "start"` → `{ to: "/start" }`
 * - workspace + session → `/w/<ws>/s/<sid>` (+ `?view=editor` when editor)
 * - workspace only → `/w/<ws>` (+ `?view=editor` when editor)
 * - otherwise (no workspace, non-start) → `{ to: "/" }` (transient boot index)
 */
export function selectionToLocation({
	viewMode,
	workspaceId,
	sessionId,
}: SelectionLocationInput): SelectionLocation {
	if (viewMode === "start") return { to: "/start" };
	if (!workspaceId) return { to: "/" };
	if (sessionId) {
		return {
			to: "/w/$workspaceId/s/$sessionId",
			params: { workspaceId, sessionId },
			search: viewSearch(viewMode),
		};
	}
	return {
		to: "/w/$workspaceId",
		params: { workspaceId },
		search: viewSearch(viewMode),
	};
}

/**
 * Compute just the pathname that mirrors the given selection (no search).
 *
 * Retained for the mirror's pathname fast-path gate and round-trip tests:
 * `selectionToLocation` is the navigate target, this is the bare path. Note
 * `viewMode === "start"` maps to `/start` here too — distinct from `/`.
 */
export function selectionToPath({
	viewMode,
	workspaceId,
	sessionId,
}: SelectionLocationInput): string {
	if (viewMode === "start") return "/start";
	if (!workspaceId) return "/";
	const encodedWorkspace = encodeURIComponent(workspaceId);
	if (sessionId) {
		return `/w/${encodedWorkspace}/s/${encodeURIComponent(sessionId)}`;
	}
	return `/w/${encodedWorkspace}`;
}

/**
 * Parse a router pathname back into the workspace/session it represents.
 *
 * Recognises `/w/:wid/s/:sid`, `/w/:wid`, `/start`, and `/`. Anything else
 * yields `{ workspaceId: null, sessionId: null }`. Ids are
 * `decodeURIComponent`-d so this is the exact inverse of `selectionToPath` for
 * the workspace/session fields. (`/start` and `/` both have no workspace, so
 * they map to the null selection — use `locationToViewInfo` to tell them
 * apart.)
 */
export function pathToSelection(pathname: string): PathSelection {
	const segments = pathname.split("/").filter((segment) => segment.length > 0);

	if (segments[0] === "w" && segments[1]) {
		const workspaceId = decodeURIComponent(segments[1]);
		if (segments[2] === "s" && segments[3]) {
			return { workspaceId, sessionId: decodeURIComponent(segments[3]) };
		}
		return { workspaceId, sessionId: null };
	}

	return { workspaceId: null, sessionId: null };
}

export type LocationViewInfo = {
	isStart: boolean;
	isEditor: boolean;
};

/**
 * Read the view-mode bits out of a router location (pathname + search). This is
 * the inverse of the `viewMode` half of `selectionToLocation`, kept here as a
 * pure helper so Stage 3b can derive `isStart` / `editorMode` from the router
 * synchronously without re-implementing the encoding.
 *
 * - `isStart` is true iff the pathname is exactly `/start`.
 * - `isEditor` is true iff `search.view === "editor"`. Because the
 *   `stripSearchParams` middleware removes the conversation default, the
 *   stored search is `{}` for conversation, so an absent `view` reads as
 *   conversation (NOT editor) — which is the intended default.
 */
export function locationToViewInfo({
	pathname,
	search,
}: {
	pathname: string;
	search: { view?: string } | Record<string, unknown>;
}): LocationViewInfo {
	return {
		isStart: pathname === "/start",
		isEditor: (search as { view?: string }).view === "editor",
	};
}

// The full selection triple the panes/getSnapshot used to read off the store,
// now derived from a router location. Stage 3b makes the router authoritative
// for navigation intent: `selectionToLocation` writes it, this reads it back.
export type LocationSelection = {
	workspaceId: string | null;
	sessionId: string | null;
	viewMode: ShellViewMode;
};

/**
 * Read the full selection intent (`viewMode`, `workspaceId`, `sessionId`) out
 * of a router location. The exact inverse of `selectionToLocation` for the
 * fields the store used to hold:
 *
 * - `/start`                  → `{ null, null, "start" }`
 * - `/w/<ws>[/s/<sid>]`       → `{ ws, sid|null, "conversation" }`
 * - `/w/<ws>[/s/<sid>]?view=editor` → `{ ws, sid|null, "editor" }`
 * - `/` (boot index)          → `{ null, null, "conversation" }`
 *
 * `viewMode === "editor"` is only meaningful with a workspace; an `?view=editor`
 * on `/start` cannot occur (start has its own route, no search), and the boot
 * index `/` always reads as "conversation".
 */
export function locationToSelection({
	pathname,
	search,
}: {
	pathname: string;
	search: { view?: string } | Record<string, unknown>;
}): LocationSelection {
	const { isStart, isEditor } = locationToViewInfo({ pathname, search });
	const { workspaceId, sessionId } = pathToSelection(pathname);
	const viewMode: ShellViewMode = isStart
		? "start"
		: isEditor
			? "editor"
			: "conversation";
	return { workspaceId, sessionId, viewMode };
}

// The persisted-settings keys a location maps to. Mirrors the legacy writes
// EXACTLY: `selectWorkspace` wrote `{ lastSurface: "workspace", lastWorkspaceId
// }` and the `selectedSessionId` effect wrote `{ lastSessionId }` (only when
// truthy, never clearing it); `openStart` wrote `{ lastSurface:
// "workspace-start" }`. So:
//
//   - `/start`            → `{ lastSurface: "workspace-start" }`
//   - `/w/<ws>`           → `{ lastSurface: "workspace", lastWorkspaceId: ws }`
//   - `/w/<ws>/s/<sid>`   → `{ ..., lastSessionId: sid }`
//   - `/` (boot index)    → `{}` (nothing — the old code never persisted the
//                            null pre-auto-select index)
//
// Returns a `Partial<AppSettings>` patch ready for `updateSettings`. It NEVER
// clears `lastWorkspaceId`/`lastSessionId` (matching the old effects, which
// only ever wrote truthy values), so a later restore keeps the last real
// selection even when the live surface is `/start` or the boot index.
export function locationToSettingsPatch({
	pathname,
	search,
}: {
	pathname: string;
	search: { view?: string } | Record<string, unknown>;
}): Partial<AppSettings> {
	const { isStart } = locationToViewInfo({ pathname, search });
	if (isStart) {
		return { lastSurface: "workspace-start" };
	}
	const { workspaceId, sessionId } = pathToSelection(pathname);
	if (!workspaceId) {
		// Boot index `/` — never persisted historically.
		return {};
	}
	const patch: Partial<AppSettings> = {
		lastSurface: "workspace",
		lastWorkspaceId: workspaceId,
	};
	if (sessionId) {
		patch.lastSessionId = sessionId;
	}
	return patch;
}
