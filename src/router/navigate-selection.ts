// Stage 3b: the authoritative imperative navigate + the single persistence
// writer. The selection controller's actions call `navigateSelection(...)` as
// the intent setter (the router is now the source of truth for navigation
// intent); `installLocationPersistence(...)` subscribes to `onResolved` and is
// the ONE place that writes `lastSurface` / `lastWorkspaceId` / `lastSessionId`
// (replacing the scattered `updateSettings` effects).

import { router } from "./index";
import {
	locationToSettingsPatch,
	pathToSelection,
	type SelectionLocation,
	type SelectionLocationInput,
	selectionToLocation,
	selectionToPath,
} from "./location-mapping";

// Push/replace the selection into the router. Always `replace` — Helmor has no
// browser back/forward affordance and the memory history stack should not grow
// (matches the Stage 1 mirror). The discriminated `to` union forces per-arm
// dispatch so TanStack's `NavigateOptions` gets the matching `params`/`search`.
function dispatch(location: SelectionLocation): void {
	switch (location.to) {
		case "/":
			void router.navigate({ to: "/", replace: true });
			return;
		case "/start":
			void router.navigate({ to: "/start", replace: true });
			return;
		case "/w/$workspaceId":
			void router.navigate({
				to: "/w/$workspaceId",
				params: location.params,
				search: location.search,
				replace: true,
			});
			return;
		case "/w/$workspaceId/s/$sessionId":
			void router.navigate({
				to: "/w/$workspaceId/s/$sessionId",
				params: location.params,
				search: location.search,
				replace: true,
			});
			return;
	}
}

// Is the router ALREADY at the location this selection maps to? Gates the
// navigate so a redundant no-op (and its `onResolved` persist) never fires.
// Same robust comparison the Stage 1 mirror used: path identity (byte-equal for
// plain UUID ids, structural fallback via the search/start/editor bits) plus
// the start/editor view distinction.
function alreadyAtTarget(input: SelectionLocationInput): boolean {
	const current = router.state.location;
	const targetPath = selectionToPath(input);
	// Path identity: byte-equal for plain (UUID) ids; for ids with URL-reserved
	// chars TanStack normalises the stored pathname with `decodeURI`, so fall
	// back to a structural compare via `pathToSelection`.
	const samePath =
		targetPath === current.pathname ||
		(() => {
			const parsed = pathToSelection(current.pathname);
			return (
				parsed.workspaceId === input.workspaceId &&
				parsed.sessionId === input.sessionId
			);
		})();
	if (!samePath) return false;
	const targetIsStart = input.viewMode === "start";
	const targetIsEditor = input.viewMode === "editor";
	const currentIsStart = current.pathname === "/start";
	const currentIsEditor =
		(current.search as { view?: string }).view === "editor";
	return currentIsStart === targetIsStart && currentIsEditor === targetIsEditor;
}

/**
 * Set the navigation intent. Reads as the authoritative writer the controller
 * actions call after their chrome-reset pivots / race-guard bookkeeping. A
 * navigate to the already-current location is short-circuited so re-selecting
 * the same workspace is a true no-op at the router level (the controller bumps
 * `reselectTick` out of band — same-location navigate must not re-fire
 * `onResolved`). Returns whether a navigation was actually dispatched.
 */
export function navigateSelection(input: SelectionLocationInput): boolean {
	if (alreadyAtTarget(input)) return false;
	dispatch(selectionToLocation(input));
	return true;
}

// One-shot persist suppression for `openStart({ persist: false })`. The boot
// `lastSurface` restore re-opens `/start` WITHOUT re-persisting it (so a manual
// "open start page" overlay action and the restore path don't clobber settings
// — matching the legacy `persist === false` skip). Path-matched so a rapid
// follow-up navigation that coalesces past the `/start` resolve can't have its
// persist swallowed by a stale token.
let suppressPersistForPath: string | null = null;

export function suppressNextStartPersist(): void {
	suppressPersistForPath = "/start";
}

// Trailing window for the persistence write. A held-key workspace burst commits
// one `onResolved` per keypress; each would otherwise fire `saveSettings` → a
// top-level `setAppSettings` (re-rendering every settings consumer) + an async
// settings IPC. Coalescing to the SETTLED location is safe: the persisted keys
// are last-write-wins and only feed the next boot's restore. The one-shot
// `persist: false` suppression is still resolved SYNCHRONOUSLY per resolve, so
// its semantics are unchanged — only the actual write is deferred.
const PERSIST_DEBOUNCE_MS = 140;

/**
 * Install the single persistence writer. Subscribes to `onResolved` and writes
 * the SAME settings keys the legacy scattered effects did (via
 * `locationToSettingsPatch`). Returns the unsubscribe fn.
 */
export function installLocationPersistence(
	saveSettings: (patch: ReturnType<typeof locationToSettingsPatch>) => void,
): () => void {
	let pendingPatch: ReturnType<typeof locationToSettingsPatch> | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	// Write any pending patch synchronously and disarm the timer. Shared by the
	// teardown path and the page-hide / quit flush below.
	const flushPending = () => {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
		if (pendingPatch) {
			saveSettings(pendingPatch);
			pendingPatch = null;
		}
	};
	const unsubscribe = router.subscribe("onResolved", ({ toLocation }) => {
		const patch = locationToSettingsPatch({
			pathname: toLocation.pathname,
			search: toLocation.search as { view?: string },
		});
		// Honour the one-shot `persist: false` suppression for `/start`. Resolved
		// synchronously so the token can't leak past a coalesced burst.
		if (
			suppressPersistForPath !== null &&
			toLocation.pathname === suppressPersistForPath
		) {
			suppressPersistForPath = null;
			return;
		}
		// A resolve onto a non-matching path clears any stale suppression token
		// so it can never leak into a later, unrelated persist.
		suppressPersistForPath = null;
		if (Object.keys(patch).length === 0) return;
		// Coalesce to the trailing edge: keep only the latest location's patch and
		// write it once the burst settles. A single/slow navigation has no
		// follow-up resolve, so it persists after one short window.
		pendingPatch = patch;
		if (timer !== null) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = null;
			const next = pendingPatch;
			pendingPatch = null;
			if (next) saveSettings(next);
		}, PERSIST_DEBOUNCE_MS);
	});
	// A real app quit (Cmd+Q → `helmor://quit-requested` → process exit) never
	// runs the cleanup below, so a navigation in the last PERSIST_DEBOUNCE_MS would
	// never be written. `pagehide` / `visibilitychange → hidden` fire on webview
	// teardown / backgrounding — flush the pending location synchronously there,
	// restoring the pre-debounce "dispatched immediately" guarantee without
	// per-keypress writes during a held burst.
	const handlePageHide = () => flushPending();
	const handleVisibilityChange = () => {
		if (document.visibilityState === "hidden") flushPending();
	};
	window.addEventListener("pagehide", handlePageHide);
	document.addEventListener("visibilitychange", handleVisibilityChange);
	return () => {
		window.removeEventListener("pagehide", handlePageHide);
		document.removeEventListener("visibilitychange", handleVisibilityChange);
		// Flush any pending write so teardown mid-window doesn't drop the last
		// settled location (preserves the pre-debounce "always persisted" guarantee).
		flushPending();
		unsubscribe();
	};
}
