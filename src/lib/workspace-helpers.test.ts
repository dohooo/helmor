import { describe, expect, it } from "vitest";
import type {
	AgentModelSection,
	WorkspaceGroup,
	WorkspaceRow,
	WorkspaceSessionSummary,
} from "./api";
import {
	applyRepoReorder,
	clampEffort,
	clampEffortToModel,
	createLiveThreadMessage,
	findModelOption,
	findReplacementWorkspaceIdAfterRemoval,
	getWorkspaceBranchTone,
	inferDefaultModelId,
	insertRowBySidebarOrder,
	isNewSession,
	moveWorkspaceToGroup,
	reorderWorkspaceInSidebar,
	resolveSessionDisplayProvider,
	resolveSessionSelectedModelId,
	splitTextWithFiles,
	workspaceGroupIdFromStatus,
} from "./workspace-helpers";

const MODEL_SECTIONS: AgentModelSection[] = [
	{
		id: "claude",
		label: "Claude",
		options: [
			{
				id: "default",
				provider: "claude",
				label: "Default",
				cliModel: "default",
				effortLevels: ["low", "medium", "high"],
			},
			{
				id: "opus",
				provider: "claude",
				label: "Opus",
				cliModel: "opus",
				effortLevels: ["low", "medium", "high"],
			},
		],
	},
	{
		id: "codex",
		label: "Codex",
		options: [
			{
				id: "gpt-4o",
				provider: "codex",
				label: "GPT-4o",
				cliModel: "gpt-4o",
				effortLevels: ["low", "medium", "high"],
			},
		],
	},
];

describe("inferDefaultModelId", () => {
	it("returns session model when session has history", () => {
		const session = {
			model: "opus",
			agentType: "claude",
			lastUserMessageAt: "2026-04-15T00:00:00Z",
		} as WorkspaceSessionSummary;
		expect(inferDefaultModelId(session, MODEL_SECTIONS)).toBe("opus");
	});

	it("returns settings default for new session", () => {
		const session = {
			model: null,
			agentType: null,
			lastUserMessageAt: null,
		} as unknown as WorkspaceSessionSummary;
		expect(inferDefaultModelId(session, MODEL_SECTIONS, "gpt-4o")).toBe(
			"gpt-4o",
		);
	});

	it("falls back to the first catalog model when no settings default is provided", () => {
		expect(inferDefaultModelId(null, MODEL_SECTIONS)).toBe("default");
	});

	it("falls back to the first catalog model when the settings model ID is invalid", () => {
		expect(inferDefaultModelId(null, MODEL_SECTIONS, "nonexistent")).toBe(
			"default",
		);
	});

	it("returns null when model sections are empty", () => {
		expect(inferDefaultModelId(null, [], "default")).toBeNull();
	});
});

describe("isNewSession", () => {
	it("returns true for null session", () => {
		expect(isNewSession(null)).toBe(true);
	});

	it("returns true when no agentType and no lastUserMessageAt", () => {
		expect(
			isNewSession({
				agentType: null,
				lastUserMessageAt: null,
			} as unknown as Parameters<typeof isNewSession>[0]),
		).toBe(true);
	});

	it("returns false when has agentType", () => {
		expect(
			isNewSession({
				agentType: "claude",
				lastUserMessageAt: null,
			} as unknown as Parameters<typeof isNewSession>[0]),
		).toBe(false);
	});

	it("returns false when has lastUserMessageAt", () => {
		expect(
			isNewSession({
				agentType: null,
				lastUserMessageAt: "2026-01-01",
			} as unknown as Parameters<typeof isNewSession>[0]),
		).toBe(false);
	});
});

describe("workspaceGroupIdFromStatus", () => {
	it("maps done → done", () => {
		expect(workspaceGroupIdFromStatus("done")).toBe("done");
	});

	it("maps review → review", () => {
		expect(workspaceGroupIdFromStatus("review")).toBe("review");
	});

	it("maps in-review → review", () => {
		expect(workspaceGroupIdFromStatus("in-review")).toBe("review");
	});

	it("maps backlog → backlog", () => {
		expect(workspaceGroupIdFromStatus("backlog")).toBe("backlog");
	});

	it("maps cancelled → canceled", () => {
		expect(workspaceGroupIdFromStatus("cancelled")).toBe("canceled");
	});

	it("defaults to progress", () => {
		expect(workspaceGroupIdFromStatus(null)).toBe("progress");
	});

	it("routes pinned rows to the pinned group regardless of status", () => {
		expect(workspaceGroupIdFromStatus("done", "2024-01-01T00:00:00Z")).toBe(
			"pinned",
		);
	});

	it("ignores a null/empty pinnedAt", () => {
		expect(workspaceGroupIdFromStatus("done", null)).toBe("done");
		expect(workspaceGroupIdFromStatus("done", undefined)).toBe("done");
	});
});

describe("insertRowBySidebarOrder", () => {
	const row = (
		id: string,
		createdAt?: string,
		displayOrder?: number,
	): WorkspaceRow => ({
		id,
		title: id,
		...(createdAt ? { createdAt } : {}),
		...(displayOrder !== undefined ? { displayOrder } : {}),
	});

	it("falls back to createdAt DESC when displayOrder ties (all zero)", () => {
		const rows = [
			row("a", "2024-03-01T00:00:00Z"),
			row("b", "2024-02-01T00:00:00Z"),
			row("c", "2024-01-01T00:00:00Z"),
		];
		const inserted = insertRowBySidebarOrder(
			rows,
			row("new", "2024-02-15T00:00:00Z"),
		);
		expect(inserted.map((r) => r.id)).toEqual(["a", "new", "b", "c"]);
	});

	it("appends when new row is the oldest under createdAt fallback", () => {
		const rows = [
			row("a", "2024-03-01T00:00:00Z"),
			row("b", "2024-02-01T00:00:00Z"),
		];
		const inserted = insertRowBySidebarOrder(
			rows,
			row("new", "2023-01-01T00:00:00Z"),
		);
		expect(inserted.map((r) => r.id)).toEqual(["a", "b", "new"]);
	});

	it("prepends when new row is the newest under createdAt fallback", () => {
		const rows = [
			row("a", "2024-03-01T00:00:00Z"),
			row("b", "2024-02-01T00:00:00Z"),
		];
		const inserted = insertRowBySidebarOrder(
			rows,
			row("new", "2025-01-01T00:00:00Z"),
		);
		expect(inserted.map((r) => r.id)).toEqual(["new", "a", "b"]);
	});

	it("treats a missing createdAt as oldest under createdAt fallback (mirrors backend NULL DESC)", () => {
		const rows = [
			row("a", "2024-03-01T00:00:00Z"),
			row("b", "2024-02-01T00:00:00Z"),
		];
		const inserted = insertRowBySidebarOrder(rows, row("new"));
		expect(inserted.map((r) => r.id)).toEqual(["a", "b", "new"]);
	});

	it("respects displayOrder ASC over createdAt", () => {
		// Backend order: display_order ASC, created_at DESC.
		const rows = [
			row("a", "2024-01-01T00:00:00Z", 1024),
			row("b", "2024-02-01T00:00:00Z", 2048),
			row("c", "2024-03-01T00:00:00Z", 3072),
		];
		// Restored row has an old createdAt but mid displayOrder — it must
		// land between `a` and `b`, not at the top (createdAt would put it
		// last) and not at the bottom.
		const inserted = insertRowBySidebarOrder(
			rows,
			row("new", "2020-01-01T00:00:00Z", 1536),
		);
		expect(inserted.map((r) => r.id)).toEqual(["a", "new", "b", "c"]);
	});

	it("appends when displayOrder is higher than every existing row", () => {
		const rows = [
			row("a", "2024-01-01T00:00:00Z", 1024),
			row("b", "2024-02-01T00:00:00Z", 2048),
		];
		const inserted = insertRowBySidebarOrder(
			rows,
			row("new", "2030-01-01T00:00:00Z", 5000),
		);
		expect(inserted.map((r) => r.id)).toEqual(["a", "b", "new"]);
	});
});

describe("moveWorkspaceToGroup", () => {
	const row = (
		id: string,
		createdAt?: string,
		extras: Partial<WorkspaceRow> = {},
	): WorkspaceRow => ({
		id,
		title: id,
		...(createdAt ? { createdAt } : {}),
		...extras,
	});

	const buildGroups = (
		init: Record<string, WorkspaceRow[]>,
	): WorkspaceGroup[] =>
		(
			["pinned", "done", "review", "progress", "backlog", "canceled"] as const
		).map((id) => ({
			id,
			label: id,
			tone: "progress",
			rows: init[id] ?? [],
		}));

	it("moves a workspace from progress to review preserving createdAt order", () => {
		const groups = buildGroups({
			progress: [
				row("a", "2024-03-01T00:00:00Z"),
				row("target", "2024-02-01T00:00:00Z"),
			],
			review: [
				row("r1", "2024-03-15T00:00:00Z"),
				row("r2", "2024-01-10T00:00:00Z"),
			],
		});

		const next = moveWorkspaceToGroup(groups, "target", "review");

		const progress = next?.find((g) => g.id === "progress");
		const review = next?.find((g) => g.id === "review");
		expect(progress?.rows.map((r) => r.id)).toEqual(["a"]);
		// target has createdAt 2024-02-01, lands between r1 (2024-03-15) and r2 (2024-01-10)
		expect(review?.rows.map((r) => r.id)).toEqual(["r1", "target", "r2"]);
		expect(review?.rows.find((r) => r.id === "target")?.status).toBe("review");
	});

	it("moves merged workspace to done group", () => {
		const groups = buildGroups({
			review: [row("merged-target", "2024-02-01T00:00:00Z")],
		});

		const next = moveWorkspaceToGroup(groups, "merged-target", "done");

		expect(next?.find((g) => g.id === "review")?.rows).toHaveLength(0);
		expect(next?.find((g) => g.id === "done")?.rows.map((r) => r.id)).toEqual([
			"merged-target",
		]);
	});

	it("routes a pinned row to the pinned group regardless of nextStatus", () => {
		const groups = buildGroups({
			pinned: [
				row("pin-target", "2024-02-01T00:00:00Z", {
					pinnedAt: "2024-04-01T00:00:00Z",
				}),
			],
		});

		const next = moveWorkspaceToGroup(groups, "pin-target", "done");

		// Stays pinned because workspaceGroupIdFromStatus respects pinnedAt.
		expect(next?.find((g) => g.id === "pinned")?.rows.map((r) => r.id)).toEqual(
			["pin-target"],
		);
		expect(next?.find((g) => g.id === "done")?.rows).toHaveLength(0);
	});

	it("returns groups unchanged when the workspace isn't in any group", () => {
		const groups = buildGroups({
			progress: [row("a", "2024-03-01T00:00:00Z")],
		});

		const next = moveWorkspaceToGroup(groups, "missing", "done");

		expect(next).toBe(groups);
	});

	it("returns undefined when groups is undefined", () => {
		expect(moveWorkspaceToGroup(undefined, "x", "done")).toBeUndefined();
	});

	it("updates the row's status to the new value", () => {
		const groups = buildGroups({
			progress: [
				row("target", "2024-02-01T00:00:00Z", { status: "in-progress" }),
			],
		});

		const next = moveWorkspaceToGroup(groups, "target", "canceled");

		const moved = next
			?.find((g) => g.id === "canceled")
			?.rows.find((r) => r.id === "target");
		expect(moved?.status).toBe("canceled");
	});
});

describe("reorderWorkspaceInSidebar", () => {
	const row = (
		id: string,
		extras: Partial<WorkspaceRow> = {},
	): WorkspaceRow => ({
		id,
		title: id,
		status: "in-progress",
		state: "ready",
		repoId: "repo-1",
		repoName: "repo-1",
		...extras,
	});

	const buildGroups = (
		init: Record<string, WorkspaceRow[]>,
	): WorkspaceGroup[] =>
		(
			["pinned", "done", "review", "progress", "backlog", "canceled"] as const
		).map((id) => ({
			id,
			label: id,
			tone: "progress",
			rows: init[id] ?? [],
		}));

	it("moves a row into a new status lane and assigns a midpoint displayOrder", () => {
		const groups = buildGroups({
			progress: [row("a", { displayOrder: 1024 })],
			review: [
				row("r1", { displayOrder: 1024, status: "review" }),
				row("r2", { displayOrder: 2048, status: "review" }),
			],
		});

		const next = reorderWorkspaceInSidebar(groups, "a", "review", "r2");

		const review = next?.find((g) => g.id === "review");
		expect(review?.rows.map((r) => r.id)).toEqual(["r1", "a", "r2"]);
		const moved = review?.rows.find((r) => r.id === "a");
		expect(moved?.status).toBe("review");
		expect(moved?.pinnedAt).toBeNull();
		// midpoint of 1024 and 2048
		expect(moved?.displayOrder).toBe(1536);
	});

	it("appends after the last neighbour when beforeWorkspaceId is null", () => {
		const groups = buildGroups({
			progress: [row("a", { displayOrder: 1024 })],
			review: [
				row("r1", { displayOrder: 1024, status: "review" }),
				row("r2", { displayOrder: 2048, status: "review" }),
			],
		});

		const next = reorderWorkspaceInSidebar(groups, "a", "review", null);
		const review = next?.find((g) => g.id === "review");
		expect(review?.rows.map((r) => r.id)).toEqual(["r1", "r2", "a"]);
		expect(review?.rows.find((r) => r.id === "a")?.displayOrder).toBe(3072);
	});

	it("pins the row when targetGroupId is `pinned`, preserving status", () => {
		const groups = buildGroups({
			progress: [row("a", { displayOrder: 1024, status: "in-progress" })],
			pinned: [],
		});

		const next = reorderWorkspaceInSidebar(groups, "a", "pinned", null);
		const pinned = next?.find((g) => g.id === "pinned");
		expect(pinned?.rows.map((r) => r.id)).toEqual(["a"]);
		const moved = pinned?.rows[0];
		expect(moved?.pinnedAt).toBeTruthy();
		expect(moved?.status).toBe("in-progress");
		expect(next?.find((g) => g.id === "progress")?.rows).toHaveLength(0);
	});

	it("unpins when dragging a pinned row into a status lane", () => {
		const groups = buildGroups({
			pinned: [
				row("a", {
					displayOrder: 1024,
					pinnedAt: "2026-01-01T00:00:00Z",
					status: "in-progress",
				}),
			],
		});

		const next = reorderWorkspaceInSidebar(groups, "a", "done", null);
		const done = next?.find((g) => g.id === "done");
		expect(done?.rows.map((r) => r.id)).toEqual(["a"]);
		const moved = done?.rows[0];
		expect(moved?.pinnedAt).toBeNull();
		expect(moved?.status).toBe("done");
	});

	it("returns groups unchanged when the workspace isn't anywhere", () => {
		const groups = buildGroups({
			progress: [row("a", { displayOrder: 1024 })],
		});

		expect(reorderWorkspaceInSidebar(groups, "missing", "review", null)).toBe(
			groups,
		);
	});

	it("returns undefined when groups is undefined", () => {
		expect(
			reorderWorkspaceInSidebar(undefined, "a", "review", null),
		).toBeUndefined();
	});

	// Regression: in repo grouping mode the user can drag a workspace from
	// one status lane in front of a workspace in a different status lane
	// (both belong to the same repo bucket). The optimistic update has to
	// scope its neighbour search to "every row of the target repo" — not
	// just the row's home status lane — so the assigned `displayOrder`
	// actually places the row before `beforeWorkspaceId` once
	// `regroupByRepo` sorts the bucket by `displayOrder`.
	it("repo target uses the whole repo bucket as neighbour set across status lanes", () => {
		const groups = buildGroups({
			done: [
				row("w-done", {
					displayOrder: 1024,
					status: "done",
					repoId: "repo-A",
				}),
			],
			review: [
				row("w-review", {
					displayOrder: 1024,
					status: "review",
					repoId: "repo-A",
				}),
			],
		});

		const next = reorderWorkspaceInSidebar(
			groups,
			"w-done",
			"repo:repo-A",
			"w-review",
		);

		const done = next?.find((g) => g.id === "done");
		const moved = done?.rows.find((r) => r.id === "w-done");
		// Status stays "done" (repo target keeps status; only clears pinnedAt).
		expect(moved?.status).toBe("done");
		expect(moved?.pinnedAt).toBeNull();
		// Neighbour set = [w-review @ 1024]; before=w-review → newOrder
		// must end up STRICTLY LESS than 1024 so the repo bucket renders
		// w-done before w-review after sort-by-displayOrder.
		expect(moved?.displayOrder).toBeLessThan(1024);
	});
});

describe("getWorkspaceBranchTone", () => {
	it("archived workspace → inactive", () => {
		expect(getWorkspaceBranchTone({ workspaceState: "archived" })).toBe(
			"inactive",
		);
	});

	it("merged PR → merged", () => {
		expect(
			getWorkspaceBranchTone({
				changeRequest: { state: "MERGED", isMerged: true },
			}),
		).toBe("merged");
	});

	it("open PR → open", () => {
		expect(
			getWorkspaceBranchTone({
				changeRequest: { state: "OPEN", isMerged: false },
			}),
		).toBe("open");
	});

	it("closed PR → closed", () => {
		expect(
			getWorkspaceBranchTone({
				changeRequest: { state: "CLOSED", isMerged: false },
			}),
		).toBe("closed");
	});

	it("done status without PR → merged", () => {
		expect(getWorkspaceBranchTone({ status: "done" })).toBe("merged");
	});

	it("default → working", () => {
		expect(getWorkspaceBranchTone({})).toBe("working");
	});
});

describe("splitTextWithFiles", () => {
	it("returns plain text when no files", () => {
		expect(splitTextWithFiles("hello world", [], "m1")).toEqual([
			{ type: "text", id: "m1:txt:0", text: "hello world" },
		]);
	});

	it("splits on @path mentions", () => {
		const result = splitTextWithFiles(
			"look at @src/main.rs please",
			["src/main.rs"],
			"m1",
		);
		expect(result).toEqual([
			{ type: "text", id: "m1:txt:0", text: "look at " },
			{ type: "file-mention", id: "m1:mention:0", path: "src/main.rs" },
			{ type: "text", id: "m1:txt:1", text: " please" },
		]);
	});

	it("handles multiple file mentions", () => {
		const result = splitTextWithFiles(
			"@a.ts and @b.ts",
			["a.ts", "b.ts"],
			"m1",
		);
		expect(result).toEqual([
			{ type: "file-mention", id: "m1:mention:0", path: "a.ts" },
			{ type: "text", id: "m1:txt:0", text: " and " },
			{ type: "file-mention", id: "m1:mention:1", path: "b.ts" },
		]);
	});

	it("longer paths win on overlap", () => {
		const result = splitTextWithFiles(
			"@src/lib/api.ts",
			["src/lib/api.ts", "api.ts"],
			"m1",
		);
		expect(result).toEqual([
			{ type: "file-mention", id: "m1:mention:0", path: "src/lib/api.ts" },
		]);
	});

	it("matches a file path containing spaces", () => {
		const path = "/Users/me/Library/Application Support/notes.txt";
		const result = splitTextWithFiles(`see @${path} please`, [path], "m1");
		expect(result).toEqual([
			{ type: "text", id: "m1:txt:0", text: "see " },
			{ type: "file-mention", id: "m1:mention:0", path },
			{ type: "text", id: "m1:txt:1", text: " please" },
		]);
	});

	it("matches an image path containing spaces via the images param", () => {
		const path =
			"/Users/me/Library/Application Support/CleanShot/CleanShot 2026-04-29 at 08.24.35@2x.jpg";
		const result = splitTextWithFiles(`look at @${path} now`, [], "m1", [path]);
		expect(result).toEqual([
			{ type: "text", id: "m1:txt:0", text: "look at " },
			{ type: "file-mention", id: "m1:mention:0", path },
			{ type: "text", id: "m1:txt:1", text: " now" },
		]);
	});

	it("matches files and images mixed in a single prompt", () => {
		const file = "/abs path/notes.md";
		const image = "/abs path/shot.png";
		const text = `compare @${file} with @${image}`;
		const result = splitTextWithFiles(text, [file], "m1", [image]);
		expect(result).toEqual([
			{ type: "text", id: "m1:txt:0", text: "compare " },
			{ type: "file-mention", id: "m1:mention:0", path: file },
			{ type: "text", id: "m1:txt:1", text: " with " },
			{ type: "file-mention", id: "m1:mention:1", path: image },
		]);
	});

	it("carves pasted ranges into pasted-text parts", () => {
		const text = "帮我看看这个\nconst a = 1;\nconst b = 2;\n谢谢";
		const start = 7; // after the 6 CJK chars + newline
		const end = start + "const a = 1;\nconst b = 2;".length;
		const result = splitTextWithFiles(text, [], "m1", [], [{ start, end }]);
		expect(result).toEqual([
			{ type: "text", id: "m1:txt:0", text: "帮我看看这个\n" },
			{
				type: "pasted-text",
				id: "m1:pasted:0",
				text: "const a = 1;\nconst b = 2;",
			},
			{ type: "text", id: "m1:txt:1", text: "\n谢谢" },
		]);
	});

	it("drops invalid and overlapping pasted ranges", () => {
		const text = "before PASTED after";
		const result = splitTextWithFiles(
			text,
			[],
			"m1",
			[],
			[
				{ start: 7, end: 13 }, // valid: "PASTED"
				{ start: 10, end: 16 }, // overlaps the first — dropped
				{ start: 5, end: 5 }, // empty — dropped
				{ start: 40, end: 500 }, // out of bounds — dropped
			],
		);
		expect(result).toEqual([
			{ type: "text", id: "m1:txt:0", text: "before " },
			{ type: "pasted-text", id: "m1:pasted:0", text: "PASTED" },
			{ type: "text", id: "m1:txt:1", text: " after" },
		]);
	});

	it("ignores @path needles inside a pasted span", () => {
		const text = "see @a.ts then PASTE WITH @a.ts INSIDE";
		const result = splitTextWithFiles(
			text,
			["a.ts"],
			"m1",
			[],
			[{ start: 15, end: 38 }],
		);
		expect(result).toEqual([
			{ type: "text", id: "m1:txt:0", text: "see " },
			{ type: "file-mention", id: "m1:mention:0", path: "a.ts" },
			{ type: "text", id: "m1:txt:1", text: " then " },
			{
				type: "pasted-text",
				id: "m1:pasted:0",
				text: "PASTE WITH @a.ts INSIDE",
			},
		]);
	});

	// Parity with the Rust adapter's `user_prompt_with_pasted_range_mid_surrogate`
	// snapshot: ranges landing inside a surrogate pair drop (their span stays
	// plain text) instead of producing lone-surrogate chips.
	it("drops ranges that split a surrogate pair (parity with Rust)", () => {
		const text = "看 😀😀 ok"; // UTF-16: 看=0, sp=1, 😀=2..4, 😀=4..6, sp=6, o=7, k=8
		const result = splitTextWithFiles(
			text,
			[],
			"m1",
			[],
			[
				{ start: 2, end: 5 }, // end lands mid-surrogate — dropped
				{ start: 3, end: 6 }, // start lands mid-surrogate — dropped
				{ start: 7, end: 9 }, // valid: "ok", ends at end-of-string
			],
		);
		expect(result).toEqual([
			{ type: "text", id: "m1:txt:0", text: "看 😀😀 " },
			{ type: "pasted-text", id: "m1:pasted:0", text: "ok" },
		]);
	});

	// Parity with Rust's (start, end) tuple sort: equal-start overlap keeps
	// the smaller end regardless of input order.
	it("keeps the smaller end when overlapping ranges share a start (parity with Rust)", () => {
		const text = "before PASTED after";
		const result = splitTextWithFiles(
			text,
			[],
			"m1",
			[],
			[
				{ start: 7, end: 13 }, // listed first, but the longer span loses
				{ start: 7, end: 10 },
			],
		);
		expect(result).toEqual([
			{ type: "text", id: "m1:txt:0", text: "before " },
			{ type: "pasted-text", id: "m1:pasted:0", text: "PAS" },
			{ type: "text", id: "m1:txt:1", text: "TED after" },
		]);
	});

	// Parity with the Rust adapter's `user_prompt_with_adjacent_pasted_ranges`
	// snapshot: a shared boundary is not an overlap.
	it("keeps adjacent ranges as separate chips (parity with Rust)", () => {
		const text = "see AABBB";
		const result = splitTextWithFiles(
			text,
			[],
			"m1",
			[],
			[
				{ start: 4, end: 6 },
				{ start: 6, end: 9 },
			],
		);
		expect(result).toEqual([
			{ type: "text", id: "m1:txt:0", text: "see " },
			{ type: "pasted-text", id: "m1:pasted:0", text: "AA" },
			{ type: "pasted-text", id: "m1:pasted:1", text: "BBB" },
		]);
	});
});

describe("createLiveThreadMessage with image paths", () => {
	it("threads images through the splitter", () => {
		const image =
			"/Users/me/Library/Application Support/CleanShot/CleanShot @2x.jpg";
		const message = createLiveThreadMessage({
			id: "msg-1",
			role: "user",
			text: `screenshot: @${image}`,
			createdAt: "2026-04-29T00:00:00.000Z",
			files: [],
			images: [image],
		});
		expect(message.content).toEqual([
			{ type: "text", id: "msg-1:txt:0", text: "screenshot: " },
			{ type: "file-mention", id: "msg-1:mention:0", path: image },
		]);
	});
});

describe("findModelOption", () => {
	it("finds existing model", () => {
		const result = findModelOption(MODEL_SECTIONS, "opus");
		expect(result?.id).toBe("opus");
		expect(result?.provider).toBe("claude");
	});

	it("returns null for unknown model", () => {
		expect(findModelOption(MODEL_SECTIONS, "nonexistent")).toBeNull();
	});

	it("returns null for null modelId", () => {
		expect(findModelOption(MODEL_SECTIONS, null)).toBeNull();
	});
});

describe("resolveSessionSelectedModelId", () => {
	it("prefers the composer-selected model for the session", () => {
		expect(
			resolveSessionSelectedModelId({
				session: {
					id: "session-1",
					agentType: "claude",
					model: null,
					lastUserMessageAt: null,
				},
				modelSelections: {
					"session:session-1": "gpt-4o",
				},
				modelSections: MODEL_SECTIONS,
			}),
		).toBe("gpt-4o");
	});

	it("prefers the composer-selected model for a custom context key", () => {
		expect(
			resolveSessionSelectedModelId({
				session: null,
				modelSelections: {
					"start:repo:repo-1": "gpt-4o",
				},
				modelSections: MODEL_SECTIONS,
				settingsDefaultModelId: "default",
				contextKey: "start:repo:repo-1",
			}),
		).toBe("gpt-4o");
	});

	it("falls back to the persisted session model", () => {
		expect(
			resolveSessionSelectedModelId({
				session: {
					id: "session-2",
					agentType: "claude",
					model: "default",
					lastUserMessageAt: "2026-04-16T00:00:00Z",
				},
				modelSelections: {},
				modelSections: MODEL_SECTIONS,
			}),
		).toBe("default");
	});

	it("uses the settings default for a new session with no persisted model yet", () => {
		expect(
			resolveSessionSelectedModelId({
				session: {
					id: "session-3",
					agentType: null,
					model: null,
					lastUserMessageAt: null,
				},
				modelSelections: {},
				modelSections: MODEL_SECTIONS,
				settingsDefaultModelId: "gpt-4o",
			}),
		).toBe("gpt-4o");
	});

	it("drops a persisted pick that's no longer in the catalog", () => {
		// Cursor key removed → the persisted cursor model is gone; fall back
		// to a valid default instead of returning the dangling id.
		expect(
			resolveSessionSelectedModelId({
				session: {
					id: "session-5",
					agentType: "claude",
					model: null,
					lastUserMessageAt: null,
				},
				modelSelections: {
					"session:session-5": "cursor-removed-model",
				},
				modelSections: MODEL_SECTIONS,
				settingsDefaultModelId: "opus",
			}),
		).toBe("opus");
	});

	it("keeps a persisted pick while the catalog is still loading (empty)", () => {
		expect(
			resolveSessionSelectedModelId({
				session: {
					id: "session-6",
					agentType: "claude",
					model: null,
					lastUserMessageAt: null,
				},
				modelSelections: {
					"session:session-6": "cursor-removed-model",
				},
				modelSections: [],
			}),
		).toBe("cursor-removed-model");
	});

	it("falls back to the first available model when no session or settings model is available", () => {
		expect(
			resolveSessionSelectedModelId({
				session: {
					id: "session-4",
					agentType: null,
					model: null,
					lastUserMessageAt: null,
				},
				modelSelections: {},
				modelSections: MODEL_SECTIONS,
				settingsDefaultModelId: null,
			}),
		).toBe("default");
	});
});

describe("resolveSessionDisplayProvider", () => {
	it("uses the session's provider, ignoring the composer model selection", () => {
		expect(
			resolveSessionDisplayProvider({
				session: {
					id: "session-1",
					agentType: "claude",
					model: null,
					lastUserMessageAt: null,
				},
				modelSelections: {
					"session:session-1": "gpt-4o",
				},
				modelSections: MODEL_SECTIONS,
			}),
		).toBe("claude");
	});

	it("keeps the opencode icon regardless of the selected sub-provider model", () => {
		expect(
			resolveSessionDisplayProvider({
				session: {
					id: "session-2",
					agentType: "opencode",
					model: null,
					lastUserMessageAt: null,
				},
				modelSelections: {
					"session:session-2": "gpt-4o",
				},
				modelSections: MODEL_SECTIONS,
			}),
		).toBe("opencode");
	});

	it("falls back to the selected model's provider when the session has no agent", () => {
		expect(
			resolveSessionDisplayProvider({
				session: {
					id: "session-3",
					agentType: null,
					model: null,
					lastUserMessageAt: null,
				},
				modelSelections: {
					"session:session-3": "gpt-4o",
				},
				modelSections: MODEL_SECTIONS,
			}),
		).toBe("codex");
	});
});

describe("clampEffort", () => {
	it("returns the level if available", () => {
		expect(clampEffort("medium", ["low", "medium", "high"])).toBe("medium");
	});

	it("clamps up to nearest available", () => {
		expect(clampEffort("minimal", ["medium", "high"])).toBe("medium");
	});

	it("clamps down to nearest available", () => {
		expect(clampEffort("max", ["low", "medium"])).toBe("medium");
	});
});

describe("clampEffortToModel", () => {
	it("uses model effort levels for clamping", () => {
		expect(clampEffortToModel("high", "default", MODEL_SECTIONS)).toBe("high");
	});

	it("uses default levels when model not found", () => {
		expect(clampEffortToModel("high", "unknown", MODEL_SECTIONS)).toBe("high");
	});
});

describe("findReplacementWorkspaceIdAfterRemoval", () => {
	function row(id: string): WorkspaceRow {
		return { id, title: id, state: "ready", status: "in-progress" };
	}

	function group(id: string, rows: string[]): WorkspaceGroup {
		return {
			id,
			label: id,
			tone: "progress",
			rows: rows.map(row),
		};
	}

	it("returns the row at the same flat index in the post-removal layout", () => {
		const currentGroups = [group("progress", ["a", "b", "c"])];
		const nextGroups = [group("progress", ["a", "c"])]; // removed: b
		const next = findReplacementWorkspaceIdAfterRemoval({
			currentGroups,
			currentArchivedRows: [],
			nextGroups,
			nextArchivedRows: [],
			removedWorkspaceId: "b",
		});
		// b was at index 1 → next layout's index 1 → c
		expect(next).toBe("c");
	});

	it("falls back to the previous neighbor when removal was the last row", () => {
		const currentGroups = [group("progress", ["a", "b"])];
		const nextGroups = [group("progress", ["a"])];
		const next = findReplacementWorkspaceIdAfterRemoval({
			currentGroups,
			currentArchivedRows: [],
			nextGroups,
			nextArchivedRows: [],
			removedWorkspaceId: "b",
		});
		expect(next).toBe("a");
	});

	it("returns null when nothing is left to navigate to", () => {
		const next = findReplacementWorkspaceIdAfterRemoval({
			currentGroups: [group("progress", ["only"])],
			currentArchivedRows: [],
			nextGroups: [],
			nextArchivedRows: [],
			removedWorkspaceId: "only",
		});
		expect(next).toBeNull();
	});

	it("includes archived rows in the flat layout", () => {
		const currentGroups = [group("progress", ["a"])];
		const currentArchivedRows = [row("z")];
		const nextGroups = [group("progress", [])];
		const nextArchivedRows = [row("z")];
		// Flat current: ["a", "z"], removed "a" at index 0
		// Flat next:    ["z"]       → index 0 → "z"
		const next = findReplacementWorkspaceIdAfterRemoval({
			currentGroups,
			currentArchivedRows,
			nextGroups,
			nextArchivedRows,
			removedWorkspaceId: "a",
		});
		expect(next).toBe("z");
	});

	it("falls back to the first row when the removed id is unknown in current", () => {
		const next = findReplacementWorkspaceIdAfterRemoval({
			currentGroups: [group("progress", ["a", "b"])],
			currentArchivedRows: [],
			nextGroups: [group("progress", ["a", "b"])],
			nextArchivedRows: [],
			removedWorkspaceId: "ghost",
		});
		expect(next).toBe("a");
	});

	// Last row in a group falls back to the previous sibling, not the next group.
	it("falls back inside the same group before jumping to the next group", () => {
		const currentGroups = [
			group("ai-tasks", ["t1", "t2", "t3"]),
			group("progress", ["p1", "p2"]),
		];
		const nextGroups = [
			group("ai-tasks", ["t1", "t2"]),
			group("progress", ["p1", "p2"]),
		];
		// t3 was the last in ai-tasks → fall back to t2 (NOT p1, which
		// the old flat-index algorithm would have picked).
		expect(
			findReplacementWorkspaceIdAfterRemoval({
				currentGroups,
				currentArchivedRows: [],
				nextGroups,
				nextArchivedRows: [],
				removedWorkspaceId: "t3",
			}),
		).toBe("t2");
	});

	// Group-aware: when the removed workspace's group becomes empty,
	// fall back to the first row of the first non-empty group.
	it("jumps to the next non-empty group when the removed group is exhausted", () => {
		const currentGroups = [
			group("ai-tasks", ["t1"]),
			group("progress", ["p1", "p2"]),
		];
		const nextGroups = [group("ai-tasks", []), group("progress", ["p1", "p2"])];
		expect(
			findReplacementWorkspaceIdAfterRemoval({
				currentGroups,
				currentArchivedRows: [],
				nextGroups,
				nextArchivedRows: [],
				removedWorkspaceId: "t1",
			}),
		).toBe("p1");
	});

	// Group-aware: archived rows are their own bucket — removing one
	// stays inside the archived lane while it has siblings.
	it("treats archived rows as their own bucket for same-bucket fallback", () => {
		const currentGroups = [group("progress", ["p1"])];
		const currentArchived = [row("z1"), row("z2"), row("z3")];
		const nextGroups = [group("progress", ["p1"])];
		const nextArchived = [row("z1"), row("z2")];
		// z3 was last archived → fall back to z2 (NOT p1).
		expect(
			findReplacementWorkspaceIdAfterRemoval({
				currentGroups,
				currentArchivedRows: currentArchived,
				nextGroups,
				nextArchivedRows: nextArchived,
				removedWorkspaceId: "z3",
			}),
		).toBe("z2");
	});

	// Regression: caller MUST pass currentGroups and nextGroups in the same
	// visual layout (both status-grouped or both repo-grouped). Mixing them
	// causes the index lookup to land on a totally unrelated workspace.
	// `projectVisualSidebar` is the convergence point that guarantees this.
	it("respects flat-list ordering — caller is responsible for matching layouts", () => {
		// Same data, two layouts:
		// status layout flat: [done, progress, review] = ["x", "a", "b", "c"]
		// repo   layout flat: [repoA(a, x), repoB(b, c)]
		// If we removed "a" while viewing repo layout (flat index 1) but
		// passed status layout as `nextGroups`, we'd jump to "b" — wrong.
		// This test pins the function's contract: it just looks up by flat
		// index, no layout normalization.
		const repoLayoutCurrent = [
			group("repo:A", ["a", "x"]),
			group("repo:B", ["b", "c"]),
		];
		const repoLayoutNext = [
			group("repo:A", ["x"]),
			group("repo:B", ["b", "c"]),
		];
		// Removed "a" at flat index 0 → next flat index 0 → "x"
		expect(
			findReplacementWorkspaceIdAfterRemoval({
				currentGroups: repoLayoutCurrent,
				currentArchivedRows: [],
				nextGroups: repoLayoutNext,
				nextArchivedRows: [],
				removedWorkspaceId: "a",
			}),
		).toBe("x");
	});
});

describe("applyRepoReorder", () => {
	function row(
		id: string,
		repoId: string,
		repoSidebarOrder: number,
	): WorkspaceRow {
		return {
			id,
			title: id,
			repoId,
			repoName: repoId,
			repoSidebarOrder,
			status: "in-progress",
			state: "ready",
		};
	}

	// Regression: previously the optimistic walk used `groups[].rows[]`
	// iteration order to infer the repo sequence — but that order is the
	// workspace-level `display_order` inside each status lane, which has
	// no relationship to repo bucket order. The result was that the
	// optimistic splice agreed with the user's mental model only when the
	// two happened to coincide; otherwise the row would render at one
	// position immediately after release and snap to a different
	// position once React Query refetched. Now both the optimistic and
	// backend paths agree on "repos sorted by min(repoSidebarOrder)".
	it("derives current repo order from repoSidebarOrder, not row iteration order", () => {
		// Display: B (1024), A (2048), C (3072) by repoSidebarOrder.
		// But the status-bucketed `groups` argument lists workspaces in
		// workspace-display_order, which here happens to be repoA first:
		const groups: WorkspaceGroup[] = [
			{
				id: "progress",
				label: "In progress",
				tone: "progress",
				rows: [
					row("w-a1", "repo-A", 2048),
					row("w-c1", "repo-C", 3072),
					row("w-b1", "repo-B", 1024),
				],
			},
		];

		// User drags C to before A — visually expects [B, C, A].
		const next = applyRepoReorder(groups, "repo-C", "repo-A");
		const orderByRepo = new Map<string, number>();
		for (const group of next ?? []) {
			for (const r of group.rows) {
				if (r.repoId) orderByRepo.set(r.repoId, r.repoSidebarOrder ?? 0);
			}
		}
		// repoB stays at the smallest order; repoC becomes the next; repoA last.
		const b = orderByRepo.get("repo-B") ?? 0;
		const c = orderByRepo.get("repo-C") ?? 0;
		const a = orderByRepo.get("repo-A") ?? 0;
		expect(b).toBeLessThan(c);
		expect(c).toBeLessThan(a);
	});

	it("returns groups unchanged when moving repo isn't present", () => {
		const groups: WorkspaceGroup[] = [
			{
				id: "progress",
				label: "In progress",
				tone: "progress",
				rows: [row("w-a", "repo-A", 1024)],
			},
		];
		expect(applyRepoReorder(groups, "repo-missing", null)).toBe(groups);
	});

	it("returns undefined when groups is undefined", () => {
		expect(applyRepoReorder(undefined, "repo-A", null)).toBeUndefined();
	});
});
