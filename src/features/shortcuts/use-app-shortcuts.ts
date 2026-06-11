import { useEffect, useMemo, useRef } from "react";
import { isQuickSwitchActive } from "@/features/quick-switch/active-state";
import { getActiveScopes } from "./focus-scope";
import { normalizeShortcutEvent } from "./format";
import { isShortcutRecordingActive } from "./recording-state";
import {
	getShortcut,
	getShortcutConflicts,
	SHORTCUT_DEFINITION_BY_ID,
} from "./registry";
import type { ShortcutId, ShortcutMap, ShortcutScope } from "./types";

export type ShortcutHandler = {
	id: ShortcutId;
	callback: () => void;
	enabled?: boolean;
	// When true, holding the key auto-repeats the action one step per frame-tick
	// via a rAF loop instead of letting the OS key-repeat fire a backlog of
	// keydown callbacks. Releasing the key stops immediately. Single taps are
	// unaffected — the first (non-repeat) keydown still fires synchronously.
	// Used only for the held-key navigation shortcuts; every other handler omits
	// it and keeps the original fire-once-per-keydown behavior.
	repeatable?: boolean;
};

type Registration = {
	callback: () => void;
	enabled: boolean;
	hotkey: string | null;
	id: ShortcutId;
	scopes: readonly ShortcutScope[];
	repeatable: boolean;
};

// Steps per rAF tick for a held repeatable shortcut. Fire every other frame
// (~30ms at 60fps ≈ 33 steps/sec) so a held key scrubs at roughly native
// key-repeat cadence rather than a too-fast one-per-frame blur.
const HELD_REPEAT_FRAME_INTERVAL = 2;

type UseAppShortcutsArgs = {
	overrides: ShortcutMap;
	handlers: ShortcutHandler[];
};

export function useAppShortcuts({ overrides, handlers }: UseAppShortcutsArgs) {
	const registrations = useMemo<Registration[]>(() => {
		const { disabledIds } = getShortcutConflicts(overrides);
		return handlers
			.map(({ id, callback, enabled = true, repeatable = false }) => {
				const definition = SHORTCUT_DEFINITION_BY_ID.get(id);
				return {
					callback,
					enabled,
					hotkey: getShortcut(overrides, id),
					id,
					scopes: definition?.scopes ?? [],
					repeatable,
				};
			})
			.filter(
				(registration) =>
					registration.hotkey && !disabledIds.has(registration.id),
			);
	}, [handlers, overrides]);
	const registrationsRef = useRef(registrations);
	registrationsRef.current = registrations;

	useEffect(() => {
		// Held-key auto-repeat state for `repeatable` shortcuts. Kept in the
		// effect closure so it tears down cleanly on unmount (the rAF is cancelled
		// below). Only one nav key can be held at a time in practice; a new held
		// shortcut supersedes any prior loop.
		let heldRafId: number | null = null;
		let heldFrameCounter = 0;
		let heldShortcutId: ShortcutId | null = null;

		const stopHeldRepeat = () => {
			if (heldRafId !== null) {
				cancelAnimationFrame(heldRafId);
				heldRafId = null;
			}
			heldShortcutId = null;
			heldFrameCounter = 0;
		};

		const startHeldRepeat = (id: ShortcutId) => {
			// Defensive: clear any prior loop before arming so we never leak a
			// second rAF (callers already guard on `heldRafId === null`).
			stopHeldRepeat();
			heldShortcutId = id;
			heldFrameCounter = 0;
			const tick = () => {
				if (heldShortcutId === null) return;
				heldFrameCounter += 1;
				if (heldFrameCounter >= HELD_REPEAT_FRAME_INTERVAL) {
					heldFrameCounter = 0;
					// Re-read the LATEST callback for this shortcut each tick (not the
					// one captured when the key was first pressed): the nav callbacks
					// close over the workspace/session lists, so a mid-hold refetch
					// gives them a new identity. Stepping off the live registration —
					// what main did by re-reading registrationsRef on every OS
					// auto-repeat keydown — avoids scrubbing off a stale snapshot.
					const current = registrationsRef.current.find(
						(registration) => registration.id === heldShortcutId,
					);
					current?.callback();
				}
				heldRafId = requestAnimationFrame(tick);
			};
			heldRafId = requestAnimationFrame(tick);
		};

		const handleKeyDown = (event: KeyboardEvent) => {
			if (isShortcutRecordingActive()) return;

			const hotkey = normalizeShortcutEvent(event);
			if (!hotkey) return;
			const activeScopes = getActiveScopes();

			const match = registrationsRef.current.find(
				(registration) =>
					registration.enabled &&
					registration.hotkey === hotkey &&
					(registration.scopes.includes("app") ||
						registration.scopes.some((scope) => activeScopes.includes(scope))),
			);
			if (!match) return;
			// Once quick-switch is engaged (warming or open), the overlay's
			// own capture-phase listener owns every keystroke until it
			// commits or cancels. We must NOT also fire `quickSwitch.open()`
			// from here for repeat Ctrl+Tab presses — otherwise the same
			// keydown cycles twice (once via this callback, once via the
			// overlay listener), producing the "stuck between two tabs"
			// bug. Hard short-circuit instead of carving exceptions.
			if (isQuickSwitchActive()) return;
			event.preventDefault();
			event.stopPropagation();

			if (match.repeatable) {
				if (!event.repeat) {
					// First (non-repeat) keydown — a tap. Step exactly once,
					// synchronously, identical to today. Start NO loop yet: a real
					// single tap fires no OS auto-repeat, so it must behave exactly
					// like every other single-press shortcut (this is also what keeps
					// App.shortcuts.test.tsx green unchanged — those tests fire one
					// keydown with no `repeat` flag and assert a single step).
					match.callback();
					return;
				}
				// OS auto-repeat keydown — the key is being held. Hand the repeat
				// cadence to the rAF loop the moment repeats begin, then ignore every
				// subsequent auto-repeat keydown. The loop is the single driver, so
				// the OS key-repeat backlog can no longer accumulate and keep the
				// selection moving after release. Re-arming is idempotent (a no-op
				// after the first repeat), so we just keep it running.
				if (heldRafId === null) startHeldRepeat(match.id);
				return;
			}

			match.callback();
		};

		// Releasing any key while a held loop is running stops it immediately —
		// there are no queued events left to drain, so the selection halts on the
		// frame after release. Both the arrow keyup (normalizes to the full combo)
		// and a modifier keyup (normalizes to null) must end the hold, so we stop
		// unconditionally whenever a loop is active rather than re-matching.
		const handleKeyUp = () => {
			if (heldRafId !== null) stopHeldRepeat();
		};
		// A blur (window/app loses focus mid-hold) drops the keyup, which would
		// otherwise leave the loop spinning. Treat it as a release.
		const handleBlur = () => stopHeldRepeat();

		window.addEventListener("keydown", handleKeyDown, true);
		window.addEventListener("keyup", handleKeyUp, true);
		window.addEventListener("blur", handleBlur);
		return () => {
			window.removeEventListener("keydown", handleKeyDown, true);
			window.removeEventListener("keyup", handleKeyUp, true);
			window.removeEventListener("blur", handleBlur);
			stopHeldRepeat();
		};
	}, []);
}
