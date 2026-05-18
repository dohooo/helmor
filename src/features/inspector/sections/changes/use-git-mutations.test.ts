// Phase 20d: verify `useGitMutations` threads `workspaceId` to the
// underlying api wrappers so a remote-bound workspace mutates via the
// binding-aware Tauri commands instead of the desktop's local
// runtime. Without this, the stage/unstage/discard actions on a
// remote workspace would silently target the desktop's filesystem.

import { QueryClient } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
	stageWorkspaceFile: vi.fn(),
	unstageWorkspaceFile: vi.fn(),
	discardWorkspaceFile: vi.fn(),
	continueWorkspaceFromTargetBranch: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
	stageWorkspaceFile: apiMocks.stageWorkspaceFile,
	unstageWorkspaceFile: apiMocks.unstageWorkspaceFile,
	discardWorkspaceFile: apiMocks.discardWorkspaceFile,
	continueWorkspaceFromTargetBranch: apiMocks.continueWorkspaceFromTargetBranch,
}));

import { useGitMutations } from "./use-git-mutations";

function setup({ workspaceId }: { workspaceId: string | null }) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const pushToast = vi.fn();
	const { result } = renderHook(() =>
		useGitMutations({
			workspaceId,
			workspaceRootPath: "/ws",
			stagedChanges: [],
			unstagedChanges: [],
			queryClient,
			pushToast,
		}),
	);
	return { controller: result.current, pushToast };
}

beforeEach(() => {
	apiMocks.stageWorkspaceFile.mockReset().mockResolvedValue(undefined);
	apiMocks.unstageWorkspaceFile.mockReset().mockResolvedValue(undefined);
	apiMocks.discardWorkspaceFile.mockReset().mockResolvedValue(undefined);
	apiMocks.continueWorkspaceFromTargetBranch.mockReset();
});

describe("useGitMutations forwards workspaceId", () => {
	it("stageFile passes the workspaceId so a remote binding routes over the wire", async () => {
		const { controller } = setup({ workspaceId: "ws-bound" });
		await controller.stageFile("src/a.rs");
		expect(apiMocks.stageWorkspaceFile).toHaveBeenCalledWith(
			"/ws",
			"src/a.rs",
			"ws-bound",
		);
	});

	it("unstageFile passes the workspaceId", async () => {
		const { controller } = setup({ workspaceId: "ws-bound" });
		await controller.unstageFile("src/a.rs");
		expect(apiMocks.unstageWorkspaceFile).toHaveBeenCalledWith(
			"/ws",
			"src/a.rs",
			"ws-bound",
		);
	});

	it("discardFile passes the workspaceId", async () => {
		const { controller } = setup({ workspaceId: "ws-bound" });
		await controller.discardFile("src/a.rs");
		expect(apiMocks.discardWorkspaceFile).toHaveBeenCalledWith(
			"/ws",
			"src/a.rs",
			"ws-bound",
		);
	});

	it("passes undefined workspaceId when the workspace isn't selected (local fallback)", async () => {
		// A null `workspaceId` means we have no binding to resolve — the
		// wrapper still calls the new command, but the backend's resolver
		// short-circuits to the local runtime.
		const { controller } = setup({ workspaceId: null });
		await controller.stageFile("src/a.rs");
		expect(apiMocks.stageWorkspaceFile).toHaveBeenCalledWith(
			"/ws",
			"src/a.rs",
			undefined,
		);
	});
});
