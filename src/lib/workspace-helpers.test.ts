import { describe, expect, it } from "vitest";
import type { AgentModelSection, WorkspaceSessionSummary } from "./api";
import {
	clampEffort,
	clampEffortToModel,
	findModelOption,
	getWorkspaceBranchTone,
	inferDefaultModelId,
	isNewSession,
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

	it("falls back to first Claude model when no settings", () => {
		expect(inferDefaultModelId(null, MODEL_SECTIONS)).toBe("default");
	});

	it("ignores invalid settings model ID", () => {
		expect(inferDefaultModelId(null, MODEL_SECTIONS, "nonexistent")).toBe(
			"default",
		);
	});

	it("returns 'default' when model sections are empty", () => {
		expect(inferDefaultModelId(null, [])).toBe("default");
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
		expect(workspaceGroupIdFromStatus("done", null)).toBe("done");
	});

	it("maps review → review", () => {
		expect(workspaceGroupIdFromStatus("review", null)).toBe("review");
	});

	it("maps in-review → review", () => {
		expect(workspaceGroupIdFromStatus("in-review", null)).toBe("review");
	});

	it("maps backlog → backlog", () => {
		expect(workspaceGroupIdFromStatus("backlog", null)).toBe("backlog");
	});

	it("maps cancelled → canceled", () => {
		expect(workspaceGroupIdFromStatus("cancelled", null)).toBe("canceled");
	});

	it("defaults to progress", () => {
		expect(workspaceGroupIdFromStatus(null, null)).toBe("progress");
	});

	it("manual status takes precedence over derived", () => {
		expect(workspaceGroupIdFromStatus("done", "backlog")).toBe("done");
	});

	it("falls back to derived when manual is null", () => {
		expect(workspaceGroupIdFromStatus(null, "review")).toBe("review");
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
				prInfo: { state: "MERGED", isMerged: true },
			}),
		).toBe("merged");
	});

	it("open PR → open", () => {
		expect(
			getWorkspaceBranchTone({
				prInfo: { state: "OPEN", isMerged: false },
			}),
		).toBe("open");
	});

	it("closed PR → closed", () => {
		expect(
			getWorkspaceBranchTone({
				prInfo: { state: "CLOSED", isMerged: false },
			}),
		).toBe("closed");
	});

	it("done status without PR → merged", () => {
		expect(getWorkspaceBranchTone({ manualStatus: "done" })).toBe("merged");
	});

	it("default → working", () => {
		expect(getWorkspaceBranchTone({})).toBe("working");
	});
});

describe("splitTextWithFiles", () => {
	it("returns plain text when no files", () => {
		expect(splitTextWithFiles("hello world", [])).toEqual([
			{ type: "text", text: "hello world" },
		]);
	});

	it("splits on @path mentions", () => {
		const result = splitTextWithFiles("look at @src/main.rs please", [
			"src/main.rs",
		]);
		expect(result).toEqual([
			{ type: "text", text: "look at " },
			{ type: "file-mention", path: "src/main.rs" },
			{ type: "text", text: " please" },
		]);
	});

	it("handles multiple file mentions", () => {
		const result = splitTextWithFiles("@a.ts and @b.ts", ["a.ts", "b.ts"]);
		expect(result).toEqual([
			{ type: "file-mention", path: "a.ts" },
			{ type: "text", text: " and " },
			{ type: "file-mention", path: "b.ts" },
		]);
	});

	it("longer paths win on overlap", () => {
		const result = splitTextWithFiles("@src/lib/api.ts", [
			"src/lib/api.ts",
			"api.ts",
		]);
		expect(result).toEqual([{ type: "file-mention", path: "src/lib/api.ts" }]);
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
