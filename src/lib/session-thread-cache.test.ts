/**
 * Direct contract tests for `session-thread-cache.ts`. The cache is the
 * single source of truth for rendered session threads, so the helpers
 * that read and write it are load-bearing for both the streaming path
 * (`workspace-conversation-container.tsx`) and the panel render path
 * (`workspace-panel-container.tsx`). Drift in any of them produces
 * either stale-render bugs or a regression of the "switch session and
 * back, conversation is empty" bug those helpers were designed to
 * eliminate.
 */

import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { ThreadMessageLike } from "./api";
import { sessionThreadMessagesQueryOptions } from "./query-client";
import {
	appendUserMessage,
	mergeRoomChatMessages,
	readSessionThread,
	replaceStreamingTail,
	restoreSnapshot,
	sessionThreadCacheKey,
	shareMessages,
	shareMessagesWithRoomChatReconciliation,
} from "./session-thread-cache";

function makeMessage(
	id: string,
	role: "user" | "assistant",
	text: string,
): ThreadMessageLike {
	return {
		role,
		id,
		createdAt: "2026-04-08T00:00:00Z",
		content: [{ type: "text", id: `${id}:txt:0`, text }],
	};
}

function makeClient(): QueryClient {
	return new QueryClient({
		defaultOptions: { queries: { gcTime: Number.POSITIVE_INFINITY } },
	});
}

describe("session-thread-cache", () => {
	it("mergeRoomChatMessages appends a teammate row by id, preserving prior", () => {
		const client = makeClient();
		appendUserMessage(client, "s1", makeMessage("u1", "user", "hi"));
		mergeRoomChatMessages(client, "s1", [makeMessage("rc1", "user", "room")]);
		expect(readSessionThread(client, "s1")?.map((m) => m.id)).toEqual([
			"u1",
			"rc1",
		]);
	});

	it("mergeRoomChatMessages is idempotent — skips ids already present", () => {
		const client = makeClient();
		appendUserMessage(client, "s1", makeMessage("rc1", "user", "room"));
		mergeRoomChatMessages(client, "s1", [makeMessage("rc1", "user", "room")]);
		expect(readSessionThread(client, "s1")?.map((m) => m.id)).toEqual(["rc1"]);
	});

	it("mergeRoomChatMessages reconciles a broadcast echo into the optimistic row", () => {
		const client = makeClient();
		appendUserMessage(client, "s1", {
			...makeMessage("rc1", "user", "room"),
			isRoomChat: true,
			author: {
				id: "32405058",
				displayName: "Caspian",
				avatarUrl: "https://avatars.githubusercontent.com/u/32405058?v=4",
			},
		});
		mergeRoomChatMessages(client, "s1", [
			{
				...makeMessage("rc1", "user", "room"),
				createdAt: "2026-04-08T00:00:01Z",
				isRoomChat: true,
				author: { id: "32405058" },
			},
		]);

		const thread = readSessionThread(client, "s1");
		expect(thread).toHaveLength(1);
		expect(thread?.[0]?.author?.id).toBe("32405058");
		expect(thread?.[0]?.author?.displayName).toBe("Caspian");
		expect(thread?.[0]?.author?.avatarUrl).toBe(
			"https://avatars.githubusercontent.com/u/32405058?v=4",
		);
		expect(thread?.[0]?.createdAt).toBe("2026-04-08T00:00:01Z");
	});

	it("mergeRoomChatMessages reconciles an old-server echo whose id differs", () => {
		const client = makeClient();
		appendUserMessage(client, "s1", {
			...makeMessage("client-id", "user", "room"),
			createdAt: "2026-04-08T00:00:00Z",
			isRoomChat: true,
			author: {
				id: "pending-self",
				displayName: "Caspian",
				avatarUrl: "https://avatars.githubusercontent.com/u/32405058?v=4",
			},
		});
		mergeRoomChatMessages(client, "s1", [
			{
				...makeMessage("server-id", "user", "room"),
				createdAt: "2026-04-08T00:00:01Z",
				isRoomChat: true,
				author: { id: "32405058" },
			},
		]);

		const thread = readSessionThread(client, "s1");
		expect(thread).toHaveLength(1);
		expect(thread?.[0]?.id).toBe("client-id");
		expect(thread?.[0]?.author?.id).toBe("32405058");
		expect(thread?.[0]?.author?.displayName).toBe("Caspian");
		expect(thread?.[0]?.author?.avatarUrl).toBe(
			"https://avatars.githubusercontent.com/u/32405058?v=4",
		);
	});

	it("mergeRoomChatMessages does not merge same-text rows from different authors", () => {
		const client = makeClient();
		appendUserMessage(client, "s1", {
			...makeMessage("alice-id", "user", "same"),
			createdAt: "2026-04-08T00:00:00Z",
			isRoomChat: true,
			author: { id: "alice" },
		});
		mergeRoomChatMessages(client, "s1", [
			{
				...makeMessage("bob-id", "user", "same"),
				createdAt: "2026-04-08T00:00:01Z",
				isRoomChat: true,
				author: { id: "bob" },
			},
		]);

		expect(readSessionThread(client, "s1")?.map((m) => m.id)).toEqual([
			"alice-id",
			"bob-id",
		]);
	});

	it("mergeRoomChatMessages does not merge stale same-text rows", () => {
		const client = makeClient();
		appendUserMessage(client, "s1", {
			...makeMessage("old-id", "user", "same"),
			createdAt: "2026-04-08T00:00:00Z",
			isRoomChat: true,
			author: { id: "pending-self", displayName: "You" },
		});
		mergeRoomChatMessages(client, "s1", [
			{
				...makeMessage("new-id", "user", "same"),
				createdAt: "2026-04-08T00:01:00Z",
				isRoomChat: true,
				author: { id: "32405058" },
			},
		]);

		expect(readSessionThread(client, "s1")?.map((m) => m.id)).toEqual([
			"old-id",
			"new-id",
		]);
	});

	it("shareMessagesWithRoomChatReconciliation preserves optimistic room-chat rows across historical refetch", () => {
		const optimistic: ThreadMessageLike = {
			...makeMessage("client-id", "user", "first"),
			createdAt: "2026-04-08T00:00:00Z",
			isRoomChat: true,
			author: {
				id: "pending-self",
				displayName: "Caspian",
				avatarUrl: "https://avatars.githubusercontent.com/u/32405058?v=4",
			},
		};
		const historical: ThreadMessageLike = {
			...makeMessage("server-id", "user", "first"),
			createdAt: "2026-04-08T00:00:01Z",
			isRoomChat: true,
			author: { id: "32405058" },
		};

		const shared = shareMessagesWithRoomChatReconciliation(
			[optimistic],
			[historical],
		);

		expect(shared).toHaveLength(1);
		expect(shared[0]?.id).toBe("client-id");
		expect(shared[0]?.createdAt).toBe("2026-04-08T00:00:01Z");
		expect(shared[0]?.author).toEqual({
			id: "32405058",
			displayName: "Caspian",
			avatarUrl: "https://avatars.githubusercontent.com/u/32405058?v=4",
		});
	});

	it("shareMessagesWithRoomChatReconciliation keeps an optimistic room-chat row when the mirror is still EMPTY (S4)", () => {
		const optimistic: ThreadMessageLike = {
			...makeMessage("client-1", "user", "你好"),
			isRoomChat: true,
			author: { id: "pending-self" },
		};
		// D1 mirror hasn't caught up (Stage B still in flight) → next is empty.
		const shared = shareMessagesWithRoomChatReconciliation([optimistic], []);
		expect(shared).toHaveLength(1);
		expect(shared[0]?.id).toBe("client-1");
	});

	it("shareMessagesWithRoomChatReconciliation replaces the optimistic row with the canonical mirror row once acked (same id)", () => {
		const optimistic: ThreadMessageLike = {
			...makeMessage("client-1", "user", "你好"),
			isRoomChat: true,
			author: { id: "pending-self" },
		};
		const canonical: ThreadMessageLike = {
			...makeMessage("client-1", "user", "你好"),
			createdAt: "2026-04-08T00:00:05Z",
			isRoomChat: true,
			author: { id: "4040" },
		};
		const shared = shareMessagesWithRoomChatReconciliation(
			[optimistic],
			[canonical],
		);
		expect(shared).toHaveLength(1);
		expect(shared[0]?.id).toBe("client-1");
		expect(shared[0]?.author?.id).toBe("4040");
		expect(shared[0]?.createdAt).toBe("2026-04-08T00:00:05Z");
	});

	it("shareMessagesWithRoomChatReconciliation acks an earlier row while preserving a later still-pending one", () => {
		const m1opt: ThreadMessageLike = {
			...makeMessage("m1", "user", "one"),
			isRoomChat: true,
			author: { id: "pending-self" },
		};
		const m2opt: ThreadMessageLike = {
			...makeMessage("m2", "user", "two"),
			isRoomChat: true,
			author: { id: "pending-self" },
		};
		const m1canonical: ThreadMessageLike = {
			...makeMessage("m1", "user", "one"),
			// Canonical row carries the server timestamp (distinct from the
			// client's optimistic one), so the ack actually swaps in the trusted
			// author instead of keeping the prev reference as structurally equal.
			createdAt: "2026-04-08T00:00:03Z",
			isRoomChat: true,
			author: { id: "4040" },
		};
		const shared = shareMessagesWithRoomChatReconciliation(
			[m1opt, m2opt],
			[m1canonical],
		);
		expect(shared.map((m) => m.id)).toEqual(["m1", "m2"]);
		expect(shared[0]?.author?.id).toBe("4040"); // acked
		expect(shared[1]?.author?.id).toBe("pending-self"); // still pending
	});

	it("shareMessagesWithRoomChatReconciliation drops a prev row the mirror lacks when it is BEFORE the anchor (authoritative prune)", () => {
		const a = makeMessage("a", "user", "a");
		const b = makeMessage("b", "user", "b");
		const c = makeMessage("c", "user", "c");
		// Mirror has a and c but not b (a real deletion, not a lagging tail).
		const shared = shareMessagesWithRoomChatReconciliation([a, b, c], [a, c]);
		expect(shared.map((m) => m.id)).toEqual(["a", "c"]);
	});

	it("shareMessagesWithRoomChatReconciliation keeps a teammate's live room-chat row when the mirror is behind", () => {
		const teammate: ThreadMessageLike = {
			...makeMessage("peer-1", "user", "hi"),
			isRoomChat: true,
			author: { id: "9999" },
		};
		const shared = shareMessagesWithRoomChatReconciliation([teammate], []);
		expect(shared).toHaveLength(1);
		expect(shared[0]?.id).toBe("peer-1");
	});

	it("shareMessagesWithRoomChatReconciliation does not resurrect an older user row that fell out of a shrunk tail window", () => {
		const old = makeMessage("old", "user", "ancient");
		const u1 = makeMessage("u1", "user", "recent-1");
		const u2 = makeMessage("u2", "user", "recent-2");
		// Local windowed refetch dropped the oldest row from the front.
		const shared = shareMessagesWithRoomChatReconciliation(
			[old, u1, u2],
			[u1, u2],
		);
		expect(shared.map((m) => m.id)).toEqual(["u1", "u2"]);
	});

	it("shareMessagesWithRoomChatReconciliation does NOT preserve a pending assistant tail (owned by the streaming path)", () => {
		const u1: ThreadMessageLike = {
			...makeMessage("u1", "user", "hi"),
			author: { id: "pending-self" },
		};
		const a1 = makeMessage("a1", "assistant", "streaming…");
		// Preservation is scoped to user rows; assistant tails rely on
		// replaceStreamingTail + the watcher's refetch-timing guards, matching
		// today's behavior (non-regression).
		const shared = shareMessagesWithRoomChatReconciliation([u1, a1], [u1]);
		expect(shared.map((m) => m.id)).toEqual(["u1"]);
	});

	it("appendUserMessage seeds an empty cache and returns the prior snapshot", () => {
		const client = makeClient();
		const userMsg = makeMessage("u1", "user", "hello");

		const snapshot = appendUserMessage(client, "session-1", userMsg);

		// `undefined` because nothing was cached before — distinct from `[]`
		// which would mean "fetched and known to be empty".
		expect(snapshot).toBeUndefined();
		expect(readSessionThread(client, "session-1")).toEqual([userMsg]);
	});

	it("appendUserMessage appends to an existing cached thread", () => {
		const client = makeClient();
		const prior = [
			makeMessage("m1", "user", "old"),
			makeMessage("m2", "assistant", "reply"),
		];
		client.setQueryData(sessionThreadCacheKey("session-1"), prior);
		const userMsg = makeMessage("u1", "user", "follow-up");

		const snapshot = appendUserMessage(client, "session-1", userMsg);

		expect(snapshot).toBe(prior);
		expect(readSessionThread(client, "session-1")).toEqual([...prior, userMsg]);
	});

	it("replaceStreamingTail replaces from the user message onwards", () => {
		const client = makeClient();
		const prior = [
			makeMessage("history-1", "user", "old"),
			makeMessage("history-2", "assistant", "old reply"),
		];
		client.setQueryData(sessionThreadCacheKey("session-1"), prior);
		const userMsg = makeMessage("u1", "user", "new turn");
		appendUserMessage(client, "session-1", userMsg);

		const turn = [userMsg, makeMessage("a1", "assistant", "in-progress")];
		replaceStreamingTail(client, "session-1", "u1", turn);

		const cached = readSessionThread(client, "session-1");
		expect(cached).toEqual([...prior, ...turn]);
		// Prior history must keep its identity so downstream memos bail out.
		expect(cached?.[0]).toBe(prior[0]);
		expect(cached?.[1]).toBe(prior[1]);
	});

	it("replaceStreamingTail overwrites the previous tail on subsequent ticks", () => {
		const client = makeClient();
		const userMsg = makeMessage("u1", "user", "hi");
		appendUserMessage(client, "session-1", userMsg);

		// Tick 1: assistant has 1 message
		replaceStreamingTail(client, "session-1", "u1", [
			userMsg,
			makeMessage("a1", "assistant", "first chunk"),
		]);
		// Tick 2: assistant has 2 messages
		replaceStreamingTail(client, "session-1", "u1", [
			userMsg,
			makeMessage("a1", "assistant", "complete reply"),
			makeMessage("a2", "assistant", "tool result"),
		]);

		const cached = readSessionThread(client, "session-1");
		expect(cached).toHaveLength(3);
		expect(cached?.[0].id).toBe("u1");
		expect(cached?.[1].id).toBe("a1");
		expect(cached?.[2].id).toBe("a2");
		// The latest tick is the source of truth — earlier "first chunk"
		// is gone, replaced by "complete reply".
		const latestA1 = cached?.[1].content[0];
		expect(latestA1?.type).toBe("text");
		if (latestA1?.type === "text") {
			expect(latestA1.text).toBe("complete reply");
		}
	});

	it("replaceStreamingTail keeps room chat after an in-progress agent turn", () => {
		const client = makeClient();
		const userMsg = makeMessage("u1", "user", "ask agent");
		const firstAssistant = makeMessage("a1", "assistant", "thinking");
		const roomChat: ThreadMessageLike = {
			...makeMessage("room-1", "user", "team aside"),
			isRoomChat: true,
			author: {
				id: "32405058",
				displayName: "Caspian",
				avatarUrl: "https://avatars.githubusercontent.com/u/32405058?v=4",
			},
		};
		appendUserMessage(client, "session-1", userMsg);
		replaceStreamingTail(client, "session-1", "u1", [userMsg, firstAssistant]);
		appendUserMessage(client, "session-1", roomChat);

		replaceStreamingTail(client, "session-1", "u1", [
			userMsg,
			makeMessage("a1", "assistant", "thinking more"),
		]);

		const cached = readSessionThread(client, "session-1");
		expect(cached?.map((message) => message.id)).toEqual([
			"u1",
			"a1",
			"room-1",
		]);
		expect(cached?.[2]).toBe(roomChat);
		expect(cached?.[2]?.author?.avatarUrl).toBe(
			"https://avatars.githubusercontent.com/u/32405058?v=4",
		);
	});

	it("replaceStreamingTail leaves room chat below the final agent snapshot", () => {
		const client = makeClient();
		const userMsg = makeMessage("u1", "user", "ask agent");
		const roomChat: ThreadMessageLike = {
			...makeMessage("room-1", "user", "team aside"),
			isRoomChat: true,
			author: { id: "32405058", displayName: "Caspian" },
		};
		appendUserMessage(client, "session-1", userMsg);
		replaceStreamingTail(client, "session-1", "u1", [
			userMsg,
			makeMessage("a1", "assistant", "partial"),
		]);
		appendUserMessage(client, "session-1", roomChat);

		replaceStreamingTail(client, "session-1", "u1", [
			userMsg,
			makeMessage("a1", "assistant", "final"),
			makeMessage("a2", "assistant", "summary"),
		]);

		expect(
			readSessionThread(client, "session-1")?.map((message) => message.id),
		).toEqual(["u1", "a1", "a2", "room-1"]);
	});

	it("restoreSnapshot reverts to the captured state and removes the entry on undefined", () => {
		const client = makeClient();
		const userMsg = makeMessage("u1", "user", "draft");
		const priorSnapshot = appendUserMessage(client, "session-1", userMsg);
		expect(priorSnapshot).toBeUndefined();

		// User retried later — restore wipes the optimistic write.
		restoreSnapshot(client, "session-1", priorSnapshot);
		expect(readSessionThread(client, "session-1")).toBeUndefined();

		// And restoring an actual prior array brings back exactly that data.
		// React Query may produce a structurally-shared copy on write, so
		// we assert equality rather than reference identity.
		const real = [makeMessage("hist", "user", "before")];
		client.setQueryData(sessionThreadCacheKey("session-1"), real);
		const snap = appendUserMessage(client, "session-1", userMsg);
		expect(snap).toEqual(real);
		restoreSnapshot(client, "session-1", snap);
		expect(readSessionThread(client, "session-1")).toEqual(real);
	});

	it("survives the switch-away-and-back round-trip without losing the streamed turn", () => {
		// Regression test for the original bug — the streamed turn must
		// stay in the cache after navigation. There is no separate `live`
		// state to drop, so a simple read after a write is sufficient.
		const client = makeClient();
		const userMsg = makeMessage("u1", "user", "hi");
		appendUserMessage(client, "session-1", userMsg);
		replaceStreamingTail(client, "session-1", "u1", [
			userMsg,
			makeMessage("a1", "assistant", "reply"),
		]);

		// Pretend the user navigates to another session — the cache for
		// session-1 is untouched.
		appendUserMessage(
			client,
			"session-2",
			makeMessage("u2", "user", "elsewhere"),
		);

		// And back.
		const back = readSessionThread(client, "session-1");
		expect(back).toHaveLength(2);
		expect(back?.[1].id).toBe("a1");
	});
});

describe("shareMessages — structural reference reuse", () => {
	function userMsg(id: string, text: string): ThreadMessageLike {
		return {
			role: "user",
			id,
			createdAt: "2026-04-08T00:00:00Z",
			content: [{ type: "text", id: `${id}:txt:0`, text }],
		};
	}

	it("returns the next array unchanged when references are identical", () => {
		const arr = [userMsg("m1", "hello")];
		expect(shareMessages(arr, arr)).toBe(arr);
	});

	it("returns the previous array reference when every message is structurally identical", () => {
		const prev = [userMsg("m1", "hello"), userMsg("m2", "world")];
		const next = [userMsg("m1", "hello"), userMsg("m2", "world")];
		expect(shareMessages(prev, next)).toBe(prev);
	});

	it("preserves richer user author metadata across id-matched refetches", () => {
		const prev = [
			{
				...userMsg("m1", "hello"),
				author: {
					id: "32405058",
					displayName: "Caspian 東澔",
					avatarUrl: "https://avatars.githubusercontent.com/u/32405058?v=4",
				},
			},
		];
		const next = [
			{
				...userMsg("m1", "hello"),
				author: { id: "32405058" },
			},
		];

		const result = shareMessages(prev, next);

		expect(result[0]?.author).toEqual(prev[0]?.author);
	});

	it("reuses individual message references when content matches by id", () => {
		const prev = [userMsg("m1", "hello"), userMsg("m2", "world")];
		const next = [userMsg("m1", "hello"), userMsg("m2", "changed")];
		const result = shareMessages(prev, next);
		expect(result).not.toBe(prev);
		expect(result[0]).toBe(prev[0]);
		expect(result[1]).toBe(next[1]);
	});

	it("returns a new outer reference when length grows", () => {
		const prev = [userMsg("m1", "hello")];
		const next = [userMsg("m1", "hello"), userMsg("m2", "world")];
		const result = shareMessages(prev, next);
		expect(result).not.toBe(prev);
		expect(result).toHaveLength(2);
		expect(result[0]).toBe(prev[0]);
	});

	it("returns a new outer reference when length shrinks", () => {
		const prev = [userMsg("m1", "hello"), userMsg("m2", "world")];
		const next = [userMsg("m1", "hello")];
		const result = shareMessages(prev, next);
		expect(result).not.toBe(prev);
		expect(result).toHaveLength(1);
		expect(result[0]).toBe(prev[0]);
	});
});

describe("sessionThreadMessagesQueryOptions structuralSharing", () => {
	function userMsg(id: string, text: string): ThreadMessageLike {
		return {
			role: "user",
			id,
			createdAt: "2026-04-08T00:00:00Z",
			content: [{ type: "text", id: `${id}:txt:0`, text }],
		};
	}

	function optionsSharing(): (
		oldData: unknown | undefined,
		newData: unknown,
	) => unknown {
		const sharing =
			sessionThreadMessagesQueryOptions("session-1").structuralSharing;
		expect(typeof sharing).toBe("function");
		return sharing as (
			oldData: unknown | undefined,
			newData: unknown,
		) => unknown;
	}

	it("passes the first fetch straight through without throwing (oldData is undefined)", () => {
		const share = optionsSharing();
		const data = [userMsg("m1", "hello")];
		// shareMessages iterates prev unconditionally — the options-level
		// wrapper MUST short-circuit undefined oldData or the very first
		// fetch of every session would crash.
		expect(share(undefined, data)).toBe(data);
	});

	it("keeps the old array reference when the refetched data is equivalent", () => {
		const share = optionsSharing();
		const prev = [userMsg("m1", "hello"), userMsg("m2", "world")];
		const next = [userMsg("m1", "hello"), userMsg("m2", "world")];
		expect(share(prev, next)).toBe(prev);
	});

	it("returns a new reference when the refetched data changed", () => {
		const share = optionsSharing();
		const prev = [userMsg("m1", "hello")];
		const next = [userMsg("m1", "hello"), userMsg("m2", "world")];
		const result = share(prev, next) as ThreadMessageLike[];
		expect(result).not.toBe(prev);
		expect(result).toHaveLength(2);
		// Per-message sharing still applies inside the new array.
		expect(result[0]).toBe(prev[0]);
	});
});
