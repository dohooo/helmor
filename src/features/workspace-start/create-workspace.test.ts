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

	function resetMocks(
		preparedWorkingDirectory: string | null = null,
		finalizedWorkingDirectory:
			| string
			| undefined = "/Users/me/helmor/workspaces/foo/bar",
	) {
		apiMocks.prepareWorkspaceFromRepo.mockReset();
		apiMocks.finalizeWorkspaceFromRepo.mockReset();
		apiMocks.setWorkspaceStatus.mockReset();
		draftMocks.persistSessionDraft.mockReset();

		apiMocks.prepareWorkspaceFromRepo.mockResolvedValue({
			workspaceId: "workspace-1",
			initialSessionId: "session-1",
			workingDirectory: preparedWorkingDirectory,
		});
		apiMocks.finalizeWorkspaceFromRepo.mockResolvedValue({
			workspaceId: "workspace-1",
			finalState: "ready",
			workingDirectory: finalizedWorkingDirectory,
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
		// Worktree mode: prepare cwd is null, only finalize knows the path.
		expect(result.preparedWorkingDirectory).toBeNull();
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
			preparedWorkingDirectory: null,
		});
	});

	it("returns local mode cwd from prepare without waiting for finalize", async () => {
		// Local mode: backend hands cwd back from prepare immediately
		// (it's just `repo.root_path` — already on disk). The caller pins
		// this onto the pending submit payload before flipping
		// `finalized=true`, eliminating the workspaceDetail React Query
		// race that previously left the first turn with cwd=null.
		resetMocks("/Users/me/repos/local-only");

		const result = await createWorkspaceFromStartComposer({
			repoId: "repo-1",
			sourceBranch: "main",
			mode: "local",
			submitMode: "startNow",
			editorStateSnapshot,
		});

		expect(result.preparedWorkingDirectory).toBe("/Users/me/repos/local-only");
	});
});
