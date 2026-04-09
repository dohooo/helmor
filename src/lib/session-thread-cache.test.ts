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
import {
	appendUserMessage,
	readSessionThread,
	replaceStreamingTail,
	restoreSnapshot,
	sessionThreadCacheKey,
	shareMessages,
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
		content: [{ type: "text", text }],
	};
}

function makeClient(): QueryClient {
	return new QueryClient({
		defaultOptions: { queries: { gcTime: Number.POSITIVE_INFINITY } },
	});
}

describe("session-thread-cache", () => {
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
			content: [{ type: "text", text }],
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
