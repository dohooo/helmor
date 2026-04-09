/**
 * Session thread cache: thin write helpers around React Query's
 * `[...sessionMessages(sessionId), "thread"]` entry.
 *
 * This cache is the **single source of truth** for the rendered
 * conversation thread of a session. The historical (DB) load path,
 * the live streaming path, and the panel render path all read and
 * write through here.
 *
 * Each helper preserves structural sharing via `shareMessages` so
 * downstream per-message memos can bail out cleanly across cache
 * updates — a Tauri stream tick that doesn't change message content
 * still produces the previous outer array reference, which is what
 * keeps the conversation list from cascading re-renders.
 */

import type { QueryClient } from "@tanstack/react-query";
import type { ThreadMessageLike } from "./api";
import { helmorQueryKeys } from "./query-client";
import { messagesStructurallyEqual } from "./structural-equality";

/** Cache key for a session's rendered thread messages. */
export function sessionThreadCacheKey(sessionId: string): readonly unknown[] {
	return [...helmorQueryKeys.sessionMessages(sessionId), "thread"];
}

/**
 * Reuse `prev` message references whenever the new array contains an
 * id-matched message that's structurally equivalent. The outer array
 * reference is also reused if every individual message could be reused
 * AND no count change happened — that's the condition the upstream
 * `MemoConversationMessage` `prev === next` bail-out depends on.
 *
 * Pure function. Pinned by the truth-table tests in
 * `session-thread-cache.share.test.ts`.
 */
export function shareMessages(
	prev: ThreadMessageLike[],
	next: ThreadMessageLike[],
): ThreadMessageLike[] {
	if (prev === next) return next;
	const prevById = new Map<string, ThreadMessageLike>();
	for (const message of prev) {
		if (message.id != null) prevById.set(message.id, message);
	}
	let allReused = next.length === prev.length;
	const shared = next.map((message, index) => {
		const candidate = message.id != null ? prevById.get(message.id) : undefined;
		if (candidate && messagesStructurallyEqual(candidate, message)) {
			if (allReused && prev[index] !== candidate) {
				allReused = false;
			}
			return candidate;
		}
		allReused = false;
		return message;
	});
	return allReused ? prev : shared;
}

/** Snapshot of the cached thread for a session, used for rollback. */
export type SessionThreadSnapshot = ThreadMessageLike[] | undefined;

/**
 * Read the current cached thread for a session. Returns `undefined` if
 * the cache has never been populated for this id (which is distinct
 * from "populated as empty array" — a fetched empty session).
 */
export function readSessionThread(
	queryClient: QueryClient,
	sessionId: string,
): SessionThreadSnapshot {
	return queryClient.getQueryData<ThreadMessageLike[]>(
		sessionThreadCacheKey(sessionId),
	);
}

/**
 * Write a thread snapshot back to the cache, applying structural
 * sharing against the existing entry. The previous `gcTime` /
 * `staleTime` settings on the query options are preserved.
 */
function writeSessionThread(
	queryClient: QueryClient,
	sessionId: string,
	next: ThreadMessageLike[],
): void {
	const cacheKey = sessionThreadCacheKey(sessionId);
	queryClient.setQueryData<ThreadMessageLike[]>(cacheKey, (prev) =>
		shareMessages(prev ?? [], next),
	);
}

/**
 * Optimistically append a freshly-typed user message to the cached
 * thread. Used by the composer submit path so the user's bubble
 * appears immediately, before the streaming response begins.
 *
 * Returns the snapshot the caller should hold onto for rollback if
 * the stream errors out before any messages are persisted.
 */
export function appendUserMessage(
	queryClient: QueryClient,
	sessionId: string,
	userMessage: ThreadMessageLike,
): SessionThreadSnapshot {
	const snapshot = readSessionThread(queryClient, sessionId);
	const next = [...(snapshot ?? []), userMessage];
	writeSessionThread(queryClient, sessionId, next);
	return snapshot;
}

/**
 * Replace the streaming "tail" of the cached thread — everything from
 * the just-sent user message onwards — with the latest snapshot from
 * the Tauri pipeline. Called on every `update` and `streamingPartial`
 * tick.
 *
 * The boundary is identified by `userMessageId`: anything before the
 * matching message in the cache is treated as immutable history,
 * anything from it onwards (including itself) is replaced with the
 * provided turn. This makes the helper resilient to multi-turn
 * resumes — prior turns stay structurally identical and the new turn
 * grows in place.
 */
export function replaceStreamingTail(
	queryClient: QueryClient,
	sessionId: string,
	userMessageId: string,
	turn: ThreadMessageLike[],
): void {
	const cacheKey = sessionThreadCacheKey(sessionId);
	queryClient.setQueryData<ThreadMessageLike[]>(cacheKey, (prev) => {
		const prior = prev ?? [];
		const boundary = prior.findIndex((m) => m.id === userMessageId);
		const stable = boundary >= 0 ? prior.slice(0, boundary) : prior;
		// `turn` already begins with the user message — the stream
		// pipeline rebuilds it from the optimistic seed plus assistant
		// snapshot every tick.
		const next = [...stable, ...turn];
		return shareMessages(prior, next);
	});
}

/**
 * Restore a previously captured snapshot. Used for full rollback when
 * a stream errors out before any messages are persisted server-side.
 */
export function restoreSnapshot(
	queryClient: QueryClient,
	sessionId: string,
	snapshot: SessionThreadSnapshot,
): void {
	const cacheKey = sessionThreadCacheKey(sessionId);
	if (snapshot === undefined) {
		queryClient.removeQueries({ queryKey: cacheKey, exact: true });
		return;
	}
	queryClient.setQueryData<ThreadMessageLike[]>(cacheKey, snapshot);
}
