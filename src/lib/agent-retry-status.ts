/**
 * R2-A (R3 denoise): per-session transient provider-retry status.
 *
 * The backend folds Codex CLI ↔ backend SSE self-heal retries into a
 * `retryStatus` stream event (never persisted, never a thread message). This
 * store holds the latest one per HELMOR session so the streaming footer can
 * show "Reconnecting… (n/m)" while the retry is in flight; ANY other stream
 * event for the session clears it (traffic = the retry resolved).
 *
 * Module-level (not React state) because the writers are the `api.ts` stream
 * callbacks — same pattern as `agent-stream-open.ts`.
 */
import { useSyncExternalStore } from "react";

export type AgentRetryStatus = {
	attempt: number;
	maxRetries: number;
};

const retryBySession = new Map<string, AgentRetryStatus>();
const listeners = new Set<() => void>();

function emit(): void {
	for (const listener of listeners) listener();
}

export function setAgentRetryStatus(
	sessionId: string,
	status: AgentRetryStatus,
): void {
	const prev = retryBySession.get(sessionId);
	if (prev?.attempt === status.attempt && prev.maxRetries === status.maxRetries)
		return;
	retryBySession.set(sessionId, status);
	emit();
}

export function clearAgentRetryStatus(sessionId: string): void {
	if (retryBySession.delete(sessionId)) emit();
}

/** Funnel: track a stream event for a session — `retryStatus` sets, anything
 *  else clears. Wire this into every stream callback (driver + watcher). */
export function trackAgentRetryStatus(
	sessionId: string,
	event: { kind: string; attempt?: number; maxRetries?: number },
): void {
	if (event.kind === "retryStatus") {
		setAgentRetryStatus(sessionId, {
			attempt: event.attempt ?? 0,
			maxRetries: event.maxRetries ?? 0,
		});
	} else {
		clearAgentRetryStatus(sessionId);
	}
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Latest transient retry status for this session, or null. */
export function useAgentRetryStatus(
	sessionId: string,
): AgentRetryStatus | null {
	return useSyncExternalStore(
		subscribe,
		() => retryBySession.get(sessionId) ?? null,
		() => null,
	);
}

/** Non-hook read (tests). */
export function getAgentRetryStatus(
	sessionId: string,
): AgentRetryStatus | null {
	return retryBySession.get(sessionId) ?? null;
}
