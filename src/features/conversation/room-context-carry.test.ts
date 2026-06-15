import { describe, expect, it } from "vitest";
import type { ThreadMessageLike } from "@/lib/api";
import type { TeamMember } from "@/lib/team-api";
import { buildRoomCarryTranscript } from "./room-context-carry";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUser(
	id: string,
	text: string,
	authorId?: string,
	isRoomChat?: boolean,
): ThreadMessageLike {
	return {
		role: "user",
		id,
		content: [
			{ type: "text", text } as unknown as ThreadMessageLike["content"][0],
		],
		author: authorId ? { id: authorId } : undefined,
		isRoomChat: isRoomChat ?? true,
	};
}

function makeAssistant(id: string): ThreadMessageLike {
	return {
		role: "assistant",
		id,
		content: [],
	};
}

function makeMember(
	id: string,
	displayName: string | null,
	githubLogin?: string,
): TeamMember {
	return {
		id,
		display_name: displayName,
		github_login: githubLogin ?? id,
		avatar_url: null,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildRoomCarryTranscript", () => {
	it("returns null + count=0 for an empty thread", () => {
		const result = buildRoomCarryTranscript([], []);
		expect(result).toEqual({ block: null, count: 0 });
	});

	it("returns null + count=0 when there are no room-chat messages", () => {
		// A regular (non-room-chat) user message followed by assistant
		const messages: ThreadMessageLike[] = [
			{ ...makeUser("u1", "hello"), isRoomChat: false },
			makeAssistant("a1"),
		];
		const result = buildRoomCarryTranscript(messages, []);
		expect(result).toEqual({ block: null, count: 0 });
	});

	it("stops at the first assistant row (turn boundary)", () => {
		const messages: ThreadMessageLike[] = [
			makeUser("u1", "before the turn"),
			makeAssistant("a1"),
			makeUser("u2", "after the turn 1"),
			makeUser("u3", "after the turn 2"),
		];
		const result = buildRoomCarryTranscript(messages, []);
		// Only the two messages AFTER the assistant row should be collected
		expect(result.count).toBe(2);
	});

	it("collects only rows with isRoomChat === true", () => {
		const messages: ThreadMessageLike[] = [
			{ ...makeUser("u1", "regular prompt"), isRoomChat: false },
			makeUser("u2", "room message 1"),
			makeUser("u3", "room message 2"),
		];
		const result = buildRoomCarryTranscript(messages, []);
		// Only the two room-chat rows should be included
		expect(result.count).toBe(2);
	});

	it("resolves author display_name", () => {
		const messages: ThreadMessageLike[] = [makeUser("u1", "hi", "member-1")];
		const members = [makeMember("member-1", "Alice Smith")];
		const result = buildRoomCarryTranscript(messages, members);
		expect(result.block).toContain('author="Alice Smith"');
	});

	it("falls back to github_login when display_name is null", () => {
		const messages: ThreadMessageLike[] = [makeUser("u1", "hi", "member-2")];
		const members = [makeMember("member-2", null, "alice-dev")];
		const result = buildRoomCarryTranscript(messages, members);
		expect(result.block).toContain('author="alice-dev"');
	});

	it("falls back to Teammate when author is not in roster", () => {
		const messages: ThreadMessageLike[] = [makeUser("u1", "hi", "unknown-id")];
		const result = buildRoomCarryTranscript(messages, []);
		expect(result.block).toContain('author="Teammate"');
	});

	it("falls back to Teammate when there is no author", () => {
		const messages: ThreadMessageLike[] = [makeUser("u1", "hi")];
		const result = buildRoomCarryTranscript(messages, []);
		expect(result.block).toContain('author="Teammate"');
	});

	it("HTML-escapes author names", () => {
		const messages: ThreadMessageLike[] = [makeUser("u1", "msg", "m1")];
		const members = [makeMember("m1", '<script>alert("xss")</script>')];
		const result = buildRoomCarryTranscript(messages, members);
		expect(result.block).not.toContain("<script>");
		expect(result.block).toContain("&lt;script&gt;");
	});

	it("HTML-escapes message text", () => {
		const messages: ThreadMessageLike[] = [
			makeUser("u1", "<b>bold</b> & more"),
		];
		const result = buildRoomCarryTranscript(messages, []);
		expect(result.block).not.toContain("<b>");
		expect(result.block).toContain("&lt;b&gt;bold&lt;/b&gt;");
		expect(result.block).toContain("&amp;");
	});

	it("wraps block in <helmor-room-context>", () => {
		const messages: ThreadMessageLike[] = [makeUser("u1", "hello")];
		const result = buildRoomCarryTranscript(messages, []);
		expect(result.block).toMatch(/^<helmor-room-context>/);
		expect(result.block).toMatch(/<\/helmor-room-context>$/);
	});

	it("outputs messages in chronological order (oldest first)", () => {
		const messages: ThreadMessageLike[] = [
			makeUser("u1", "first"),
			makeUser("u2", "second"),
			makeUser("u3", "third"),
		];
		const result = buildRoomCarryTranscript(messages, []);
		expect(result.block).not.toBeNull();
		const idx1 = result.block!.indexOf("first");
		const idx2 = result.block!.indexOf("second");
		const idx3 = result.block!.indexOf("third");
		expect(idx1).toBeLessThan(idx2);
		expect(idx2).toBeLessThan(idx3);
	});

	it("only collects messages after the LAST assistant turn", () => {
		// Multiple turns: room messages between turns should NOT be included
		const messages: ThreadMessageLike[] = [
			makeUser("u1", "old room msg from first turn"),
			makeAssistant("a1"),
			makeUser("u2", "old room msg from second turn"),
			makeAssistant("a2"),
			makeUser("u3", "recent room msg"),
		];
		const result = buildRoomCarryTranscript(messages, []);
		expect(result.count).toBe(1);
		expect(result.block).toContain("recent room msg");
		expect(result.block).not.toContain("old room msg");
	});
});
