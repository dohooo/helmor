import { cleanup, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render-with-providers";
import { _resetForTesting } from "../script-store";
import { useSetupAutoRun } from "./use-setup-auto-run";

const apiMocks = vi.hoisted(() => ({
	executeRepoScript: vi.fn(),
	completeWorkspaceSetup: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();
	return {
		...actual,
		executeRepoScript: apiMocks.executeRepoScript,
		completeWorkspaceSetup: apiMocks.completeWorkspaceSetup,
	};
});

type Args = Parameters<typeof useSetupAutoRun>[0];

function Harness(props: Args) {
	useSetupAutoRun(props);
	return null;
}

function renderHook(args: Partial<Args> = {}) {
	const full: Args = {
		repoId: "repo-1",
		workspaceId: "ws-1",
		workspaceState: "setup_pending",
		setupScript: "echo hi",
		scriptsLoaded: true,
		...args,
	};
	return renderWithProviders(<Harness {...full} />);
}

describe("useSetupAutoRun", () => {
	beforeEach(() => {
		apiMocks.executeRepoScript.mockReset().mockResolvedValue(undefined);
		apiMocks.completeWorkspaceSetup.mockReset().mockResolvedValue(undefined);
	});

	afterEach(() => {
		_resetForTesting();
		vi.restoreAllMocks();
		cleanup();
	});

	it("auto-runs setup when pending and script is configured", () => {
		renderHook();

		expect(apiMocks.executeRepoScript).toHaveBeenCalledWith(
			"repo-1",
			"setup",
			expect.any(Function),
			"ws-1",
			null,
		);
	});

	it("does NOT auto-run when workspace is ready", () => {
		renderHook({ workspaceState: "ready" });

		expect(apiMocks.executeRepoScript).not.toHaveBeenCalled();
	});

	it("does NOT auto-run when no script is configured", () => {
		renderHook({ setupScript: null });

		expect(apiMocks.executeRepoScript).not.toHaveBeenCalled();
	});

	it("auto-completes when pending and no script is configured", async () => {
		renderHook({ setupScript: null });

		await waitFor(() => {
			expect(apiMocks.completeWorkspaceSetup).toHaveBeenCalledWith("ws-1");
		});
	});

	it("does NOT auto-complete while scripts are still loading", () => {
		renderHook({ setupScript: null, scriptsLoaded: false });

		expect(apiMocks.completeWorkspaceSetup).not.toHaveBeenCalled();
	});

	it("does NOT auto-complete when workspaceId is null", () => {
		renderHook({ workspaceId: null, setupScript: null });

		expect(apiMocks.completeWorkspaceSetup).not.toHaveBeenCalled();
	});
});
