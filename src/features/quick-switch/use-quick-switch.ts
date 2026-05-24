import { useCallback, useEffect, useRef, useState } from "react";
import { beginQuickSwitch, endQuickSwitch } from "./active-state";

export type QuickSwitchDirection = "next" | "previous";

export type QuickSwitchSnapshot = {
	ids: string[];
	initialIndex: number;
};

/**
 * - `idle`: nothing happening.
 * - `warming`: user pressed the hotkey but hasn't held long enough for the
 *   overlay to appear. A quick tap-and-release in this phase commits without
 *   the overlay ever flashing — same UX as macOS Cmd+Tab / Arc Ctrl+Tab.
 * - `open`: overlay is visible. Reached by either holding past the threshold
 *   or actively cycling (Tab / ArrowLeft / ArrowRight).
 */
export type QuickSwitchState =
	| { phase: "idle" }
	| { phase: "warming"; ids: string[]; index: number }
	| { phase: "open"; ids: string[]; index: number };

export type QuickSwitchControls = {
	state: QuickSwitchState;
	open: (direction: QuickSwitchDirection) => void;
	cycle: (delta: 1 | -1) => void;
	selectIndex: (index: number) => void;
	commit: () => void;
	cancel: () => void;
};

type UseQuickSwitchArgs = {
	buildSnapshot: (
		direction: QuickSwitchDirection,
	) => QuickSwitchSnapshot | null;
	onCommit: (id: string) => void;
};

const IDLE: QuickSwitchState = { phase: "idle" };

/** How long the user has to hold the hotkey before the overlay appears. */
export const QUICK_SWITCH_WARMING_MS = 200;

export function useQuickSwitch({
	buildSnapshot,
	onCommit,
}: UseQuickSwitchArgs): QuickSwitchControls {
	const [state, setState] = useState<QuickSwitchState>(IDLE);
	// stateRef mirrors `state` synchronously. Every write goes through
	// `applyState`, which updates the ref before scheduling the React render —
	// so even within React 18 batched updates, side-effect code reading the
	// "current" state inside open/commit/cancel sees consistent values.
	const stateRef = useRef<QuickSwitchState>(IDLE);
	const buildSnapshotRef = useRef(buildSnapshot);
	buildSnapshotRef.current = buildSnapshot;
	const onCommitRef = useRef(onCommit);
	onCommitRef.current = onCommit;
	const warmingTimerRef = useRef<number | null>(null);

	const applyState = useCallback((next: QuickSwitchState) => {
		stateRef.current = next;
		setState(next);
	}, []);

	const clearWarmingTimer = useCallback(() => {
		if (warmingTimerRef.current !== null) {
			window.clearTimeout(warmingTimerRef.current);
			warmingTimerRef.current = null;
		}
	}, []);

	const cycle = useCallback(
		(delta: 1 | -1) => {
			const cur = stateRef.current;
			if (cur.phase !== "warming" && cur.phase !== "open") return;
			const n = cur.ids.length;
			if (n === 0) return;
			const nextIndex = (((cur.index + delta) % n) + n) % n;
			// Cycling is an explicit "I want to see the list" signal, so
			// promote to `open` immediately even if we were still warming.
			clearWarmingTimer();
			applyState({ phase: "open", ids: cur.ids, index: nextIndex });
		},
		[applyState, clearWarmingTimer],
	);

	const selectIndex = useCallback(
		(index: number) => {
			const cur = stateRef.current;
			// Hover/click target lives in the overlay, which only renders when
			// phase === "open". Guard anyway to keep the function pure.
			if (cur.phase !== "open") return;
			if (index < 0 || index >= cur.ids.length) return;
			applyState({ ...cur, index });
		},
		[applyState],
	);

	const cancel = useCallback(() => {
		const cur = stateRef.current;
		if (cur.phase === "idle") return;
		clearWarmingTimer();
		applyState(IDLE);
		endQuickSwitch();
	}, [applyState, clearWarmingTimer]);

	const commit = useCallback(() => {
		const cur = stateRef.current;
		if (cur.phase === "idle") return;
		const id = cur.ids[cur.index] ?? null;
		clearWarmingTimer();
		applyState(IDLE);
		endQuickSwitch();
		if (id) onCommitRef.current(id);
	}, [applyState, clearWarmingTimer]);

	const open = useCallback(
		(direction: QuickSwitchDirection) => {
			const cur = stateRef.current;
			// Re-press while already engaged = cycle (and promote to open).
			if (cur.phase !== "idle") {
				cycle(direction === "next" ? 1 : -1);
				return;
			}
			const snapshot = buildSnapshotRef.current(direction);
			if (!snapshot || snapshot.ids.length < 2) return;
			const safeIndex = Math.min(
				Math.max(0, snapshot.initialIndex),
				snapshot.ids.length - 1,
			);
			beginQuickSwitch();
			applyState({ phase: "warming", ids: snapshot.ids, index: safeIndex });
			// Promote to "open" (= overlay appears) only if the user is still
			// holding the hotkey after the threshold. A fast tap-then-release
			// commits inside this window with no overlay flash.
			warmingTimerRef.current = window.setTimeout(() => {
				warmingTimerRef.current = null;
				const latest = stateRef.current;
				if (latest.phase === "warming") {
					applyState({
						phase: "open",
						ids: latest.ids,
						index: latest.index,
					});
				}
			}, QUICK_SWITCH_WARMING_MS);
		},
		[applyState, cycle],
	);

	useEffect(() => {
		// Listeners attach for both warming and open: warming needs to see
		// keyup-Control to commit a fast tap, and Tab/Esc during warming
		// promote/cancel just like during open.
		if (state.phase === "idle") return;

		const onKeyDown = (event: KeyboardEvent) => {
			// `event.isComposing` covers IME composition; never preempt input.
			if (event.isComposing) return;
			const key = event.key;
			if (key === "Tab") {
				event.preventDefault();
				event.stopImmediatePropagation();
				cycle(event.shiftKey ? -1 : 1);
				return;
			}
			if (key === "ArrowRight") {
				event.preventDefault();
				event.stopImmediatePropagation();
				cycle(1);
				return;
			}
			if (key === "ArrowLeft") {
				event.preventDefault();
				event.stopImmediatePropagation();
				cycle(-1);
				return;
			}
			if (key === "Escape") {
				event.preventDefault();
				event.stopImmediatePropagation();
				cancel();
				return;
			}
			if (key === "Enter") {
				event.preventDefault();
				event.stopImmediatePropagation();
				commit();
				return;
			}
		};

		const onKeyUp = (event: KeyboardEvent) => {
			if (event.key === "Control") commit();
		};

		// Window blur: user Cmd+Tab'd away. Cancel rather than commit so
		// returning to Helmor doesn't surprise-switch the workspace.
		const onBlur = () => cancel();

		window.addEventListener("keydown", onKeyDown, true);
		window.addEventListener("keyup", onKeyUp, true);
		window.addEventListener("blur", onBlur);
		return () => {
			window.removeEventListener("keydown", onKeyDown, true);
			window.removeEventListener("keyup", onKeyUp, true);
			window.removeEventListener("blur", onBlur);
		};
	}, [state.phase, cycle, cancel, commit]);

	// Safety net: if the component using us unmounts while engaged, release
	// the global active flag and any pending timer so the rest of the app
	// isn't stuck short-circuiting.
	useEffect(() => {
		return () => {
			if (warmingTimerRef.current !== null) {
				window.clearTimeout(warmingTimerRef.current);
				warmingTimerRef.current = null;
			}
			if (stateRef.current.phase !== "idle") endQuickSwitch();
		};
	}, []);

	return { state, open, cycle, selectIndex, commit, cancel };
}
