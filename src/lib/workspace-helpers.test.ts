import { describe, expect, it } from "vitest";
import type {
	AgentModelSection,
	WorkspaceGroup,
	WorkspaceRow,
	WorkspaceSessionSummary,
} from "./api";
import {
	clampEffort,
	clampEffortToModel,
	createLiveThreadMessage,
	findModelOption,
	getWorkspaceBranchTone,
	inferDefaultModelId,
	insertRowByCreatedAtDesc,
	isNewSession,
	moveWorkspaceToGroup,
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

describe("insertRowByCreatedAtDesc", () => {
	const row = (id: string, createdAt?: string): WorkspaceRow => ({
		id,
		title: id,
		...(createdAt ? { createdAt } : {}),
	});

	it("inserts at the correct position to preserve DESC order", () => {
		const rows = [
			row("a", "2024-03-01T00:00:00Z"),
			row("b", "2024-02-01T00:00:00Z"),
			row("c", "2024-01-01T00:00:00Z"),
		];
		const inserted = insertRowByCreatedAtDesc(
			rows,
			row("new", "2024-02-15T00:00:00Z"),
		);
		expect(inserted.map((r) => r.id)).toEqual(["a", "new", "b", "c"]);
	});

	it("appends when new row is the oldest", () => {
		const rows = [
			row("a", "2024-03-01T00:00:00Z"),
			row("b", "2024-02-01T00:00:00Z"),
		];
		const inserted = insertRowByCreatedAtDesc(
			rows,
			row("new", "2023-01-01T00:00:00Z"),
		);
		expect(inserted.map((r) => r.id)).toEqual(["a", "b", "new"]);
	});

	it("prepends when new row is the newest", () => {
		const rows = [
			row("a", "2024-03-01T00:00:00Z"),
			row("b", "2024-02-01T00:00:00Z"),
		];
		const inserted = insertRowByCreatedAtDesc(
			rows,
			row("new", "2025-01-01T00:00:00Z"),
		);
		expect(inserted.map((r) => r.id)).toEqual(["new", "a", "b"]);
	});

	it("treats a missing createdAt as newest", () => {
		const rows = [
			row("a", "2024-03-01T00:00:00Z"),
			row("b", "2024-02-01T00:00:00Z"),
		];
		const inserted = insertRowByCreatedAtDesc(rows, row("new"));
		expect(inserted.map((r) => r.id)).toEqual(["new", "a", "b"]);
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
	it("maps the resolved model to the provider", () => {
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
		).toBe("codex");
	});

	it("falls back to persisted agent type when model resolution is unavailable", () => {
		expect(
			resolveSessionDisplayProvider({
				session: {
					id: "session-2",
					agentType: "claude",
					model: null,
					lastUserMessageAt: null,
				},
				modelSelections: {},
				modelSections: [],
			}),
		).toBe("claude");
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
