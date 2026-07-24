/**
 * WP8 (team-cloud-stabilize): per-session "agent stream OPENED" signal.
 *
 * In team mode the stream POST's awaited open (WP2: `openCompanionStream`
 * resolving with a 2xx) means the container is up and the serve host accepted
 * the turn — everything after that is the agent working, not the sandbox
 * waking. The streaming footer uses this to split the pre-first-token wait
 * into "Waking the container…" (before open) and "Thinking…" (after open),
 * instead of labelling the whole 14s of a cold start as waking.
 *
 * Module-level (not React state) because the writer is `ipc.ts` — the same
 * pattern as team-readiness. Timeout/failure paths are untouched: a failed
 * open still rejects through WP2's error path, and the next send for the
 * session resets the bit via {@link beginAgentStreamOpen}.
 */
import { useSyncExternalStore } from "react";

const openedSessions = new Set<string>();
const listeners = new Set<() => void>();

function emit(): void {
	for (const listener of listeners) listener();
}

/** A new agent stream POST is starting for this session — clear any stale
 *  opened bit from the previous turn so the footer starts back at "waking". */
export function beginAgentStreamOpen(sessionId: string): void {
	if (openedSessions.delete(sessionId)) emit();
}

/** The stream POST opened (2xx): the container is connected. */
export function markAgentStreamOpened(sessionId: string): void {
	if (openedSessions.has(sessionId)) return;
	openedSessions.add(sessionId);
	emit();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** True once the current turn's stream POST has opened for this session. */
export function useAgentStreamOpened(sessionId: string): boolean {
	return useSyncExternalStore(
		subscribe,
		() => openedSessions.has(sessionId),
		() => false,
	);
}

/** Non-hook read (tests). */
export function isAgentStreamOpened(sessionId: string): boolean {
	return openedSessions.has(sessionId);
}
