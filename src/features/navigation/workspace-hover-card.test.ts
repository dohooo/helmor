import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type {
	ThreadMessageLike,
	ToolCallPart,
	WorkspaceSessionSummary,
} from "@/lib/api";
import { sessionThreadCacheKey } from "@/lib/session-thread-cache";
import {
	chooseLiveSessionId,
	extractLiveActivity,
	formatElapsed,
	LIVE_BLOCK_CHAR_BUDGET,
	truncateLiveText,
} from "./workspace-hover-card";

function makeSession(
	overrides: Partial<WorkspaceSessionSummary> = {},
): WorkspaceSessionSummary {
	return {
		id: "s",
		workspaceId: "w",
		title: "Untitled",
		status: "idle",
		permissionMode: "default",
		unreadCount: 0,
		fastMode: false,
		createdAt: "2025-01-01T00:00:00Z",
		updatedAt: "2025-01-01T00:00:00Z",
		isHidden: false,
		actionKind: null,
		active: false,
		...overrides,
	};
}

function makeAssistant(
	parts: ThreadMessageLike["content"],
	id = "asst",
): ThreadMessageLike {
	return { role: "assistant", id, content: parts };
}

function tool(
	toolName: string,
	args: Record<string, unknown> = {},
): ToolCallPart {
	return {
		type: "tool-call",
		toolCallId: `tc-${toolName}`,
		toolName,
		args,
		argsText: JSON.stringify(args),
	};
}

// ---------- truncateLiveText ----------

describe("truncateLiveText", () => {
	it("returns short text unchanged", () => {
		expect(truncateLiveText("hello")).toBe("hello");
	});

	it("returns text exactly at budget unchanged", () => {
		const text = "x".repeat(LIVE_BLOCK_CHAR_BUDGET);
		expect(truncateLiveText(text)).toBe(text);
	});

	it("keeps the tail and prefixes with ellipsis when over budget", () => {
		const text = `abcdef${"z".repeat(LIVE_BLOCK_CHAR_BUDGET)}`;
		const out = truncateLiveText(text);
		expect(out.startsWith("…")).toBe(true);
		expect(out.length).toBe(LIVE_BLOCK_CHAR_BUDGET + 1);
		expect(out.endsWith("z".repeat(20))).toBe(true);
	});
});

// ---------- formatElapsed ----------

describe("formatElapsed", () => {
	it("formats sub-minute durations as `Ns`", () => {
		expect(formatElapsed(0)).toBe("0s");
		expect(formatElapsed(999)).toBe("0s");
		expect(formatElapsed(42_000)).toBe("42s");
		expect(formatElapsed(59_999)).toBe("59s");
	});

	it("formats minute-range durations as `Nm` or `Nm Ms`", () => {
		expect(formatElapsed(60_000)).toBe("1m");
		expect(formatElapsed(154_000)).toBe("2m 34s");
		expect(formatElapsed(60 * 60 * 1000 - 1)).toBe("59m 59s");
	});

	it("formats hour-range durations as `Nh` or `Nh Mm`", () => {
		expect(formatElapsed(60 * 60 * 1000)).toBe("1h");
		expect(formatElapsed(60 * 60 * 1000 + 5 * 60_000)).toBe("1h 5m");
		expect(formatElapsed(2.5 * 60 * 60 * 1000)).toBe("2h 30m");
	});

	it("clamps negative durations to 0s", () => {
		expect(formatElapsed(-500)).toBe("0s");
	});
});

// ---------- extractLiveActivity ----------

describe("extractLiveActivity", () => {
	it("returns no blocks for missing or empty thread", () => {
		expect(extractLiveActivity(undefined)).toEqual([]);
		expect(extractLiveActivity([])).toEqual([]);
	});

	it("returns no blocks when there is no assistant message", () => {
		expect(
			extractLiveActivity([
				{
					role: "user",
					id: "u1",
					content: [{ type: "text", id: "t", text: "hi" }],
				},
			]),
		).toEqual([]);
	});

	it("only walks the most recent assistant message", () => {
		const blocks = extractLiveActivity([
			makeAssistant([{ type: "text", id: "old", text: "stale" }], "a-old"),
			{
				role: "user",
				id: "u",
				content: [{ type: "text", id: "tu", text: "ok" }],
			},
			makeAssistant([{ type: "text", id: "new", text: "fresh" }], "a-new"),
		]);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toMatchObject({ kind: "markdown", text: "fresh" });
	});

	it("preserves part order and maps each kind", () => {
		const blocks = extractLiveActivity([
			makeAssistant([
				{ type: "reasoning", id: "r", text: "thinking" },
				tool("Read", { file_path: "/a/b.ts" }),
				{ type: "text", id: "t", text: "Done" },
				{
					type: "collapsed-group",
					id: "g",
					category: "read",
					tools: [],
					active: false,
					summary: "Reviewed 3 files",
				},
			]),
		]);
		expect(blocks).toEqual([
			{ kind: "markdown", key: "r", text: "thinking", reasoning: true },
			{ kind: "tool", key: "tc-Read", label: "Reading b.ts" },
			{ kind: "markdown", key: "t", text: "Done", reasoning: false },
			{ kind: "tool", key: "g", label: "Reviewed 3 files" },
		]);
	});

	it("skips empty text/reasoning parts", () => {
		const blocks = extractLiveActivity([
			makeAssistant([
				{ type: "text", id: "t", text: "" },
				{ type: "reasoning", id: "r", text: "" },
				tool("Bash", { command: "ls" }),
			]),
		]);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toMatchObject({ kind: "tool", label: "$ ls" });
	});

	it("truncates long markdown text in-place", () => {
		const long = "y".repeat(LIVE_BLOCK_CHAR_BUDGET + 50);
		const [block] = extractLiveActivity([
			makeAssistant([{ type: "text", id: "t", text: long }]),
		]);
		expect(block).toBeDefined();
		if (block && block.kind === "markdown") {
			expect(block.text.startsWith("…")).toBe(true);
			expect(block.text.length).toBe(LIVE_BLOCK_CHAR_BUDGET + 1);
		}
	});
});

// ---------- chooseLiveSessionId ----------

function seedThread(qc: QueryClient, sessionId: string, length: number) {
	const messages: ThreadMessageLike[] = Array.from({ length }, (_, i) => ({
		role: "assistant",
		id: `${sessionId}-${i}`,
		content: [{ type: "text", id: `${sessionId}-${i}-t`, text: "x" }],
	}));
	qc.setQueryData(sessionThreadCacheKey(sessionId), messages);
}

describe("chooseLiveSessionId", () => {
	it("falls back to primarySessionId when no session is streaming", () => {
		const qc = new QueryClient();
		const result = chooseLiveSessionId({
			workspaceSessions: [makeSession({ id: "s1" })],
			busySessionIds: new Set(),
			primarySessionId: "primary",
			queryClient: qc,
		});
		expect(result).toBe("primary");
	});

	it("returns the only streaming candidate", () => {
		const qc = new QueryClient();
		const result = chooseLiveSessionId({
			workspaceSessions: [makeSession({ id: "s1" }), makeSession({ id: "s2" })],
			busySessionIds: new Set(["s2"]),
			primarySessionId: "primary",
			queryClient: qc,
		});
		expect(result).toBe("s2");
	});

	it("excludes hidden sessions even if they are streaming", () => {
		const qc = new QueryClient();
		const result = chooseLiveSessionId({
			workspaceSessions: [
				makeSession({ id: "s1", isHidden: true }),
				makeSession({ id: "s2" }),
			],
			busySessionIds: new Set(["s1", "s2"]),
			primarySessionId: "primary",
			queryClient: qc,
		});
		expect(result).toBe("s2");
	});

	it("excludes action-kind sessions even if they are streaming", () => {
		const qc = new QueryClient();
		const result = chooseLiveSessionId({
			workspaceSessions: [
				makeSession({ id: "action", actionKind: "create-pr" }),
				makeSession({ id: "convo" }),
			],
			busySessionIds: new Set(["action", "convo"]),
			primarySessionId: "primary",
			queryClient: qc,
		});
		expect(result).toBe("convo");
	});

	it("falls back to primary when only hidden/action streamers exist", () => {
		const qc = new QueryClient();
		const result = chooseLiveSessionId({
			workspaceSessions: [
				makeSession({ id: "h", isHidden: true }),
				makeSession({ id: "a", actionKind: "commit-and-push" }),
			],
			busySessionIds: new Set(["h", "a"]),
			primarySessionId: "primary",
			queryClient: qc,
		});
		expect(result).toBe("primary");
	});

	it("breaks ties on most cached messages when multiple are streaming", () => {
		const qc = new QueryClient();
		seedThread(qc, "small", 2);
		seedThread(qc, "big", 17);
		seedThread(qc, "medium", 9);
		const result = chooseLiveSessionId({
			workspaceSessions: [
				makeSession({ id: "small" }),
				makeSession({ id: "big" }),
				makeSession({ id: "medium" }),
			],
			busySessionIds: new Set(["small", "big", "medium"]),
			primarySessionId: "primary",
			queryClient: qc,
		});
		expect(result).toBe("big");
	});

	it("picks the largest streamer regardless of input order", () => {
		// Same setup as the previous test but with the candidate array
		// reversed — pins down that selection depends on message counts,
		// not on the order workspaceSessions arrives in.
		const qc = new QueryClient();
		seedThread(qc, "small", 2);
		seedThread(qc, "big", 17);
		seedThread(qc, "medium", 9);
		const result = chooseLiveSessionId({
			workspaceSessions: [
				makeSession({ id: "medium" }),
				makeSession({ id: "big" }),
				makeSession({ id: "small" }),
			],
			busySessionIds: new Set(["small", "big", "medium"]),
			primarySessionId: "primary",
			queryClient: qc,
		});
		expect(result).toBe("big");
	});

	it("keeps the first streaming candidate when message counts are tied", () => {
		const qc = new QueryClient();
		seedThread(qc, "a", 5);
		seedThread(qc, "b", 5);
		const result = chooseLiveSessionId({
			workspaceSessions: [makeSession({ id: "a" }), makeSession({ id: "b" })],
			busySessionIds: new Set(["a", "b"]),
			primarySessionId: null,
			queryClient: qc,
		});
		expect(result).toBe("a");
	});

	it("returns null when nothing is streaming and no primary is provided", () => {
		const qc = new QueryClient();
		const result = chooseLiveSessionId({
			workspaceSessions: [],
			busySessionIds: new Set(),
			primarySessionId: null,
			queryClient: qc,
		});
		expect(result).toBe(null);
	});
});
