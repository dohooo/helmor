import type { SerializedEditorState } from "lexical";
import { describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
	prepareWorkspaceFromRepo: vi.fn(),
	finalizeWorkspaceFromRepo: vi.fn(),
	setWorkspaceStatus: vi.fn(),
}));

const draftMocks = vi.hoisted(() => ({
	persistSessionDraft: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
	prepareWorkspaceFromRepo: apiMocks.prepareWorkspaceFromRepo,
	finalizeWorkspaceFromRepo: apiMocks.finalizeWorkspaceFromRepo,
	setWorkspaceStatus: apiMocks.setWorkspaceStatus,
}));

vi.mock("@/features/composer/draft-storage", () => ({
	persistSessionDraft: draftMocks.persistSessionDraft,
}));

import { createWorkspaceFromStartComposer } from "./create-workspace";

describe("createWorkspaceFromStartComposer", () => {
	const editorStateSnapshot = {
		root: {
			type: "root",
			version: 1,
			children: [],
			direction: null,
			format: "",
			indent: 0,
		},
	} as unknown as SerializedEditorState;

	function resetMocks() {
		apiMocks.prepareWorkspaceFromRepo.mockReset();
		apiMocks.finalizeWorkspaceFromRepo.mockReset();
		apiMocks.setWorkspaceStatus.mockReset();
		draftMocks.persistSessionDraft.mockReset();

		apiMocks.prepareWorkspaceFromRepo.mockResolvedValue({
			workspaceId: "workspace-1",
			initialSessionId: "session-1",
		});
		apiMocks.finalizeWorkspaceFromRepo.mockResolvedValue({
			workspaceId: "workspace-1",
			finalState: "ready",
		});
		apiMocks.setWorkspaceStatus.mockResolvedValue(undefined);
		draftMocks.persistSessionDraft.mockResolvedValue(undefined);
	}

	it("creates an in-progress workspace and returns a streaming target", async () => {
		resetMocks();

		const result = await createWorkspaceFromStartComposer({
			repoId: "repo-1",
			sourceBranch: "origin/main",
			mode: "worktree",
			submitMode: "startNow",
			editorStateSnapshot,
		});

		expect(apiMocks.prepareWorkspaceFromRepo).toHaveBeenCalledWith(
			"repo-1",
			"origin/main",
			"worktree",
		);
		expect(apiMocks.finalizeWorkspaceFromRepo).toHaveBeenCalledWith(
			"workspace-1",
		);
		expect(apiMocks.setWorkspaceStatus).not.toHaveBeenCalled();
		expect(draftMocks.persistSessionDraft).not.toHaveBeenCalled();
		expect(result.outcome).toEqual({
			shouldStream: true,
			workspaceId: "workspace-1",
			sessionId: "session-1",
			contextKey: "session:session-1",
		});
		expect(result.workspaceId).toBe("workspace-1");
		expect(result.sessionId).toBe("session-1");
		expect(result.finalizePromise).toBeInstanceOf(Promise);
	});

	it("saves the new workspace to backlog with the composer draft", async () => {
		resetMocks();

		const result = await createWorkspaceFromStartComposer({
			repoId: "repo-1",
			sourceBranch: "origin/dev",
			mode: "worktree",
			submitMode: "saveForLater",
			editorStateSnapshot,
		});

		expect(apiMocks.prepareWorkspaceFromRepo).toHaveBeenCalledWith(
			"repo-1",
			"origin/dev",
			"worktree",
		);
		expect(apiMocks.finalizeWorkspaceFromRepo).toHaveBeenCalledWith(
			"workspace-1",
		);
		expect(draftMocks.persistSessionDraft).toHaveBeenCalledWith(
			"session-1",
			editorStateSnapshot,
		);
		expect(apiMocks.setWorkspaceStatus).toHaveBeenCalledWith(
			"workspace-1",
			"backlog",
		);
		expect(result).toEqual({
			outcome: { shouldStream: false },
			workspaceId: "workspace-1",
			sessionId: "session-1",
		});
	});
});
