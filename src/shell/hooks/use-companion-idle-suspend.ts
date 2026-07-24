import { focusManager } from "@tanstack/react-query";
import { useEffect } from "react";
import { useStreamingStore } from "@/features/conversation/state/streaming-store";
import { setCompanionIdleSuspended } from "@/lib/companion-suspend";
import { resumeEventStream, suspendEventStream } from "@/lib/ipc";
import { isTeamModeActive } from "@/lib/team-mode";

/** Drop the team `/v1/stream` after the window has been HIDDEN this long, so the
 *  remote sandbox can idle-sleep. Long enough to ride out a quick tab-switch. */
const HIDDEN_SUSPEND_DELAY_MS = 60_000;
/** Also drop it after the window has been VISIBLE but the user IDLE this long
 *  (no clicks/keys, no turn in flight) — the real lever against always-on cost:
 *  an open-but-unused Helmor would otherwise pin the sandbox awake all day.
 *  Generous so ordinary read/think time never triggers it. INTERIM: until the
 *  event stream moves to a hibernating Durable Object (Stage C), resuming after
 *  an idle suspend cold-starts the sandbox, so the threshold is tuned to make
 *  that rare. */
const VISIBLE_IDLE_SUSPEND_MS = 10 * 60_000;

/**
 * Team-mode only: drop the shared companion SSE when the app is unattended —
 * either the window is hidden, or it's visible but the user has been idle — so
 * an idle remote sandbox stops instead of burning cost on a live-but-idle
 * connection. Any activity (or re-focus) resumes the stream, which wakes the
 * sandbox via the normal cold-start. Never suspends mid-turn. The suspend/resume
 * calls are no-ops on the native (local) transport, so this is inert outside
 * team mode.
 */
export function useCompanionIdleSuspend(): void {
	useEffect(() => {
		let timer: ReturnType<typeof setTimeout> | null = null;
		let suspended = false;

		const clearTimer = () => {
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
		};

		const turnInFlight = () => {
			const s = useStreamingStore.getState();
			return (
				s.sendingContextKeys.size > 0 ||
				Object.keys(s.activeSessionByContext).length > 0
			);
		};

		const suspendNow = () => {
			if (!isTeamModeActive() || suspended) return;
			// Never drop the stream mid-turn — retry once the turn settles.
			if (turnInFlight()) {
				timer = setTimeout(suspendNow, 60_000);
				return;
			}
			suspended = true;
			// R2-A: watch subscriptions (api.ts subscribeSessionStream) ride
			// this signal — with rpc-stream keepalives a live watch stream
			// would otherwise pin the sandbox awake forever.
			setCompanionIdleSuspended(true);
			suspendEventStream();
			// Dropping the SSE alone isn't enough: the React Query polls (git-status
			// @10s, forge, change-request) keep hitting the container and re-arm its
			// idle timer, so it never sleeps. Pause them too — interval refetches are
			// foreground-only, so flipping focusManager off globally suspends them
			// (matching the SSE drop). Resumed on the next activity/re-focus.
			focusManager.setFocused(false);
		};

		/** (Re)arm the visible-idle countdown — called on activity + re-focus. */
		const reArm = () => {
			clearTimer();
			timer = setTimeout(suspendNow, VISIBLE_IDLE_SUSPEND_MS);
		};

		const onVisibilityChange = () => {
			clearTimer();
			if (document.visibilityState === "hidden") {
				timer = setTimeout(suspendNow, HIDDEN_SUSPEND_DELAY_MS);
			} else {
				// Returning to a visible window: re-ensure the stream (cheap no-op if
				// already live), clear any idle-suspend, and re-arm the idle timer.
				suspended = false;
				setCompanionIdleSuspended(false);
				resumeEventStream();
				focusManager.setFocused(true);
				reArm();
			}
		};

		const onActivity = () => {
			if (document.visibilityState !== "visible") return;
			if (suspended) {
				suspended = false;
				setCompanionIdleSuspended(false);
				resumeEventStream();
				focusManager.setFocused(true);
			}
			reArm();
		};

		document.addEventListener("visibilitychange", onVisibilityChange);
		window.addEventListener("pointerdown", onActivity, { passive: true });
		window.addEventListener("keydown", onActivity);
		if (document.visibilityState === "visible") reArm();

		return () => {
			clearTimer();
			setCompanionIdleSuspended(false);
			// Restore React Query's default focus tracking on unmount.
			focusManager.setFocused(undefined);
			document.removeEventListener("visibilitychange", onVisibilityChange);
			window.removeEventListener("pointerdown", onActivity);
			window.removeEventListener("keydown", onActivity);
		};
	}, []);
}
