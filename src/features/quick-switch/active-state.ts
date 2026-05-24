// Module-level flag mirroring `recording-state.ts`. While the quick-switch
// overlay is open we want the global shortcut dispatcher to short-circuit so
// raw Tab / Shift+Tab / Esc / typing keys belong to the overlay alone.
let activeCount = 0;

export function beginQuickSwitch() {
	activeCount += 1;
}

export function endQuickSwitch() {
	activeCount = Math.max(0, activeCount - 1);
}

export function isQuickSwitchActive() {
	return activeCount > 0;
}

/** Test-only: reset between tests. */
export function _resetQuickSwitchActiveForTesting() {
	activeCount = 0;
}
