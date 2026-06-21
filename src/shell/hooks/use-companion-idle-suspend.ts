import { useEffect } from "react";
import { useStreamingStore } from "@/features/conversation/state/streaming-store";
import { resumeEventStream, suspendEventStream } from "@/lib/ipc";
import { isTeamModeActive } from "@/lib/team-mode";

/** How long the window must stay hidden before we drop the team `/v1/stream`, so
 *  the remote sandbox can idle-sleep. Long enough to ride out a quick tab-switch,
 *  short enough to save idle cost. */
const HIDDEN_SUSPEND_DELAY_MS = 60_000;

/**
 * Team-mode only: drop the shared companion SSE after the window has been hidden
 * for a grace period, so an unattended remote sandbox idle-sleeps instead of
 * staying awake on a live-but-idle connection. Re-focusing resumes the stream,
 * which wakes the sandbox via the normal cold-start (+ reconnecting banner).
 *
 * Never suspends mid-turn — a hidden window can still be streaming an agent
 * reply we want to keep receiving. The suspend/resume calls are no-ops on the
 * native (local) transport, so this is inert outside team mode.
 */
export function useCompanionIdleSuspend(): void {
	useEffect(() => {
		let hiddenTimer: ReturnType<typeof setTimeout> | null = null;
		const clearTimer = () => {
			if (hiddenTimer) {
				clearTimeout(hiddenTimer);
				hiddenTimer = null;
			}
		};

		const onVisibilityChange = () => {
			clearTimer();
			if (document.visibilityState === "hidden") {
				hiddenTimer = setTimeout(() => {
					if (!isTeamModeActive()) return;
					const streaming = useStreamingStore.getState();
					const turnInFlight =
						streaming.sendingContextKeys.size > 0 ||
						Object.keys(streaming.activeSessionByContext).length > 0;
					if (turnInFlight) return;
					suspendEventStream();
				}, HIDDEN_SUSPEND_DELAY_MS);
			} else {
				resumeEventStream();
			}
		};

		document.addEventListener("visibilitychange", onVisibilityChange);
		return () => {
			clearTimer();
			document.removeEventListener("visibilitychange", onVisibilityChange);
		};
	}, []);
}
