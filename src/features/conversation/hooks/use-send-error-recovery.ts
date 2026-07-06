import { useEffect, useRef } from "react";
import { isRetryableSendError } from "@/features/composer/cloud-error-cta";
import { useTeamReadiness } from "@/lib/team-readiness";
import { useStreamingStore } from "../state/streaming-store";

/**
 * DF-5 (R3-C): when team readiness TRANSITIONS into `ready` (backend
 * recovered / woke), auto-clear the active context's send error IF it is a
 * transport-level (retryable) failure — the outage the error reported is
 * over, so leaving the red box + a wedged composer forces the user to
 * discover the "type a character" workaround.
 *
 * Provider-level errors (backend healthy, the turn itself failed) are NOT
 * cleared — a reconnect says nothing about those (see
 * {@link isRetryableSendError}). Same F-2 edge-transition pattern as the
 * model-catalog revalidation.
 */
export function useSendErrorRecovery(composerContextKey: string): void {
	const readiness = useTeamReadiness();
	const prevReadyRef = useRef(readiness.state === "ready");
	useEffect(() => {
		const isReady = readiness.state === "ready";
		if (isReady && !prevReadyRef.current) {
			const state = useStreamingStore.getState();
			const error = state.sendErrorsByContext[composerContextKey] ?? null;
			if (error && isRetryableSendError(error)) {
				state.setSendError(composerContextKey, null);
			}
		}
		prevReadyRef.current = isReady;
	}, [readiness.state, composerContextKey]);
}
