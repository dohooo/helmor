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
import type { ExtendedMessagePart, ThreadMessageLike } from "./api";
import { helmorQueryKeys } from "./query-client";
import { messagesStructurallyEqual } from "./structural-equality";

const PENDING_SELF_AUTHOR_ID = "pending-self";
const ROOM_CHAT_ECHO_WINDOW_MS = 30_000;

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
		const merged = candidate
			? mergeUserMessageAuthor(candidate, message)
			: message;
		if (candidate && messagesStructurallyEqual(candidate, merged)) {
			if (allReused && prev[index] !== candidate) {
				allReused = false;
			}
			return candidate;
		}
		allReused = false;
		return merged;
	});
	return allReused ? prev : shared;
}

function mergeUserMessageAuthor(
	existing: ThreadMessageLike,
	incoming: ThreadMessageLike,
): ThreadMessageLike {
	if (existing.role !== "user" || incoming.role !== "user") return incoming;
	const author = mergeRoomChatAuthor(existing, incoming);
	if (author === incoming.author) return incoming;
	return { ...incoming, author };
}

export function shareMessagesWithRoomChatReconciliation(
	prev: ThreadMessageLike[],
	next: ThreadMessageLike[],
): ThreadMessageLike[] {
	if (prev.length === 0 || next.length === 0) {
		return shareMessages(prev, next);
	}
	let changed = false;
	const reconciled = next.map((message) => {
		if (!isRoomChatUserMessage(message)) return message;
		if (
			message.id != null &&
			prev.some((candidate) => candidate.id === message.id)
		) {
			return message;
		}
		const echoIndex = findRoomChatEchoIndex(prev, message);
		if (echoIndex < 0) return message;
		const existing = prev[echoIndex];
		if (!existing) return message;
		changed = true;
		return mergeRoomChatReplacement(existing, message, {
			preserveExistingId: true,
		});
	});
	return shareMessages(prev, changed ? reconciled : next);
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
 * Replace the streaming "tail" of the cached thread — the just-sent user
 * message plus the agent turn currently streaming after it — with the latest
 * snapshot from the Tauri pipeline. Called on every `update` and
 * `streamingPartial` tick.
 *
 * The boundary is identified by `userMessageId`: anything before the matching
 * message in the cache is immutable history. Room-chat rows appended while the
 * agent is working are not part of the provider turn, so they are preserved
 * after the refreshed agent snapshot instead of being swallowed by the next
 * stream tick or jumping above the final assistant output.
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
		const preservedRoomChat =
			boundary >= 0 ? collectRoomChatAfterBoundary(prior, boundary, turn) : [];
		// `turn` already begins with the user message — the stream
		// pipeline rebuilds it from the optimistic seed plus assistant
		// snapshot every tick.
		const next = [...stable, ...turn, ...preservedRoomChat];
		return shareMessages(prior, next);
	});
}

function collectRoomChatAfterBoundary(
	prior: readonly ThreadMessageLike[],
	boundary: number,
	turn: readonly ThreadMessageLike[],
): ThreadMessageLike[] {
	const turnIds = new Set(
		turn
			.map((message) => message.id)
			.filter((id): id is string => typeof id === "string"),
	);
	return prior
		.slice(boundary + 1)
		.filter(
			(message) =>
				isRoomChatUserMessage(message) &&
				(message.id == null || !turnIds.has(message.id)),
		);
}

/**
 * Fold room-chat broadcast rows into the cached thread.
 *
 * Room chat normally has one message id across optimistic render, DB
 * persistence, and hub broadcast. Older team backends may ignore
 * `clientMessageId`, so we also match a close content/time echo. For that
 * fallback path, keep the optimistic row's id so React does not remount the
 * message/avatar row and flash the fallback initials; still merge in trusted
 * backend fields such as author id and timestamp.
 */
export function mergeRoomChatMessages(
	queryClient: QueryClient,
	sessionId: string,
	incoming: readonly ThreadMessageLike[],
): void {
	if (incoming.length === 0) return;
	const cacheKey = sessionThreadCacheKey(sessionId);
	queryClient.setQueryData<ThreadMessageLike[]>(cacheKey, (prev) => {
		const prior = prev ?? [];
		const next = [...prior];
		let changed = false;
		for (const message of incoming) {
			if (message.id == null) continue;
			const existingIndex = next.findIndex((m) => m.id === message.id);
			const replaceIndex =
				existingIndex >= 0
					? existingIndex
					: findRoomChatEchoIndex(next, message);
			if (replaceIndex >= 0) {
				const existing = next[replaceIndex];
				if (!existing) continue;
				next[replaceIndex] = mergeRoomChatReplacement(existing, message, {
					preserveExistingId: existingIndex < 0,
				});
			} else {
				next.push(message);
			}
			changed = true;
		}
		if (!changed) return prior;
		return shareMessages(prior, next);
	});
}

function mergeRoomChatReplacement(
	existing: ThreadMessageLike,
	incoming: ThreadMessageLike,
	options?: { preserveExistingId?: boolean },
): ThreadMessageLike {
	const author = mergeRoomChatAuthor(existing, incoming);
	const id = options?.preserveExistingId ? existing.id : incoming.id;
	if (author === incoming.author && id === incoming.id) return incoming;
	return { ...incoming, id, author };
}

function mergeRoomChatAuthor(
	existing: ThreadMessageLike,
	incoming: ThreadMessageLike,
): ThreadMessageLike["author"] {
	const existingAuthor = existing.author;
	const incomingAuthor = incoming.author;
	if (!existingAuthor) return incomingAuthor;
	if (!incomingAuthor) return existingAuthor;
	if (!authorsCompatible(existing, incoming)) return incomingAuthor;

	const id =
		incomingAuthor.id === PENDING_SELF_AUTHOR_ID &&
		existingAuthor.id !== PENDING_SELF_AUTHOR_ID
			? existingAuthor.id
			: incomingAuthor.id;
	const displayName = incomingAuthor.displayName ?? existingAuthor.displayName;
	const avatarUrl = incomingAuthor.avatarUrl ?? existingAuthor.avatarUrl;
	if (
		id === incomingAuthor.id &&
		displayName === incomingAuthor.displayName &&
		avatarUrl === incomingAuthor.avatarUrl
	) {
		return incomingAuthor;
	}
	return {
		...incomingAuthor,
		id,
		...(displayName ? { displayName } : {}),
		...(avatarUrl ? { avatarUrl } : {}),
	};
}

function findRoomChatEchoIndex(
	candidates: readonly ThreadMessageLike[],
	incoming: ThreadMessageLike,
): number {
	if (!isRoomChatUserMessage(incoming)) return -1;
	const incomingSignature = roomChatContentSignature(incoming);
	if (!incomingSignature) return -1;
	const incomingTime = parseMessageTime(incoming);

	let bestIndex = -1;
	let bestDelta = Number.POSITIVE_INFINITY;
	for (let index = 0; index < candidates.length; index += 1) {
		const candidate = candidates[index];
		if (!isRoomChatUserMessage(candidate)) continue;
		if (!authorsCompatible(candidate, incoming)) continue;
		if (roomChatContentSignature(candidate) !== incomingSignature) continue;
		const candidateTime = parseMessageTime(candidate);
		if (candidateTime == null || incomingTime == null) continue;
		const delta = Math.abs(incomingTime - candidateTime);
		if (delta > ROOM_CHAT_ECHO_WINDOW_MS || delta >= bestDelta) continue;
		bestDelta = delta;
		bestIndex = index;
	}
	return bestIndex;
}

function isRoomChatUserMessage(message: ThreadMessageLike): boolean {
	return message.role === "user" && message.isRoomChat === true;
}

function authorsCompatible(
	candidate: ThreadMessageLike,
	incoming: ThreadMessageLike,
): boolean {
	const candidateId = candidate.author?.id;
	const incomingId = incoming.author?.id;
	return (
		candidateId == null ||
		candidateId === PENDING_SELF_AUTHOR_ID ||
		incomingId == null ||
		candidateId === incomingId
	);
}

function parseMessageTime(message: ThreadMessageLike): number | null {
	if (!message.createdAt) return null;
	const value = Date.parse(message.createdAt);
	return Number.isFinite(value) ? value : null;
}

function roomChatContentSignature(message: ThreadMessageLike): string {
	return message.content.map(partSignature).join("\u001f");
}

function partSignature(part: ExtendedMessagePart): string {
	switch (part.type) {
		case "text":
			return `text:${part.text}`;
		case "file-mention":
			return `file:${part.path}`;
		case "pasted-text":
			return `pasted:${part.text}`;
		case "image":
			return `image:${imageSourceSignature(part.source)}`;
		default:
			return `${part.type}:${JSON.stringify(part)}`;
	}
}

function imageSourceSignature(
	source: Extract<ExtendedMessagePart, { type: "image" }>["source"],
): string {
	switch (source.kind) {
		case "file":
			return `file:${source.path}`;
		case "url":
			return `url:${source.url}`;
		case "base64":
			return `base64:${source.data}`;
	}
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
