import { act, cleanup, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
	backfillForgeRepoBindings: vi.fn(),
	listForgeLogins: vi.fn(),
	loadWorkspaceDetail: vi.fn(),
	resizeForgeCliAuthTerminal: vi.fn(),
	retryRepoForgeBinding: vi.fn(),
	spawnForgeCliAuthTerminal: vi.fn(),
	stopForgeCliAuthTerminal: vi.fn(),
	writeForgeCliAuthTerminalStdin: vi.fn(),
}));

vi.mock("@/components/terminal-output", () => ({
	TerminalOutput: () => <div data-testid="terminal-output" />,
}));

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();
	return {
		...actual,
		backfillForgeRepoBindings: apiMocks.backfillForgeRepoBindings,
		listForgeLogins: apiMocks.listForgeLogins,
		loadWorkspaceDetail: apiMocks.loadWorkspaceDetail,
		resizeForgeCliAuthTerminal: apiMocks.resizeForgeCliAuthTerminal,
		retryRepoForgeBinding: apiMocks.retryRepoForgeBinding,
		spawnForgeCliAuthTerminal: apiMocks.spawnForgeCliAuthTerminal,
		stopForgeCliAuthTerminal: apiMocks.stopForgeCliAuthTerminal,
		writeForgeCliAuthTerminalStdin: apiMocks.writeForgeCliAuthTerminalStdin,
	};
});

vi.mock("sonner", () => ({
	toast: Object.assign(vi.fn(), {
		error: vi.fn(),
		success: vi.fn(),
	}),
}));

import type { ScriptEvent } from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import { renderWithProviders } from "@/test/render-with-providers";
import { ForgeConnectDialog } from "./forge-connect-dialog";

describe("ForgeConnectDialog", () => {
	beforeEach(() => {
		for (const mock of Object.values(apiMocks)) {
			mock.mockReset();
		}
		apiMocks.backfillForgeRepoBindings.mockResolvedValue(0);
		apiMocks.loadWorkspaceDetail.mockResolvedValue(null);
		apiMocks.retryRepoForgeBinding.mockResolvedValue("octocat");
		apiMocks.stopForgeCliAuthTerminal.mockResolvedValue(true);
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("probes and refreshes forge state when the auth terminal exits successfully", async () => {
		let onTerminalEvent: ((event: ScriptEvent) => void) | null = null;
		apiMocks.listForgeLogins
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce(["octocat"]);
		apiMocks.spawnForgeCliAuthTerminal.mockImplementation(
			async (_provider, _host, _instanceId, callback) => {
				onTerminalEvent = callback;
			},
		);
		const onOpenChange = vi.fn();
		const onConnected = vi.fn();
		const onCloseSettled = vi.fn();
		const { queryClient } = renderWithProviders(
			<ForgeConnectDialog
				open
				onOpenChange={onOpenChange}
				provider="github"
				host="github.com"
				repoId="repo-1"
				workspaceId="workspace-1"
				onConnected={onConnected}
				onCloseSettled={onCloseSettled}
			/>,
		);
		const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

		await waitFor(() => {
			expect(apiMocks.spawnForgeCliAuthTerminal).toHaveBeenCalled();
		});

		await act(async () => {
			onTerminalEvent?.({ type: "exited", code: 0 });
		});

		await waitFor(() => {
			expect(apiMocks.listForgeLogins).toHaveBeenCalledTimes(2);
			expect(onOpenChange).toHaveBeenCalledWith(false);
			expect(onConnected).toHaveBeenCalledWith({
				provider: "github",
				host: "github.com",
				login: "octocat",
			});
			expect(onCloseSettled).toHaveBeenCalledWith({
				provider: "github",
				host: "github.com",
				connected: true,
				login: "octocat",
			});
		});
		expect(apiMocks.stopForgeCliAuthTerminal).toHaveBeenCalledWith(
			"github",
			"github.com",
			expect.any(String),
		);
		expect(apiMocks.retryRepoForgeBinding).toHaveBeenCalledWith("repo-1");
		expect(invalidateSpy).toHaveBeenCalledWith({
			queryKey: helmorQueryKeys.forgeLogins("github", "github.com"),
		});
		expect(invalidateSpy).toHaveBeenCalledWith({
			queryKey: helmorQueryKeys.forgeAccountsAll,
		});
	});

	it("refreshes repo binding when auth reuses an existing login", async () => {
		let onTerminalEvent: ((event: ScriptEvent) => void) | null = null;
		apiMocks.listForgeLogins
			.mockResolvedValueOnce(["octocat"])
			.mockResolvedValueOnce(["octocat"]);
		apiMocks.spawnForgeCliAuthTerminal.mockImplementation(
			async (_provider, _host, _instanceId, callback) => {
				onTerminalEvent = callback;
			},
		);
		const onConnected = vi.fn();
		const onCloseSettled = vi.fn();

		renderWithProviders(
			<ForgeConnectDialog
				open
				onOpenChange={vi.fn()}
				provider="github"
				host="github.com"
				repoId="repo-1"
				workspaceId="workspace-1"
				onConnected={onConnected}
				onCloseSettled={onCloseSettled}
			/>,
		);

		await waitFor(() => {
			expect(apiMocks.spawnForgeCliAuthTerminal).toHaveBeenCalled();
		});

		await act(async () => {
			onTerminalEvent?.({ type: "exited", code: 0 });
		});

		await waitFor(() => {
			expect(apiMocks.retryRepoForgeBinding).toHaveBeenCalledWith("repo-1");
			expect(onConnected).toHaveBeenCalledWith({
				provider: "github",
				host: "github.com",
				login: "octocat",
			});
			expect(onCloseSettled).toHaveBeenCalledWith({
				provider: "github",
				host: "github.com",
				connected: true,
				login: "octocat",
			});
		});
	});

	it("does not report connected when repo binding finds no accessible account", async () => {
		let onTerminalEvent: ((event: ScriptEvent) => void) | null = null;
		apiMocks.listForgeLogins
			.mockResolvedValueOnce(["octocat"])
			.mockResolvedValueOnce(["octocat"]);
		apiMocks.retryRepoForgeBinding.mockResolvedValueOnce(null);
		apiMocks.spawnForgeCliAuthTerminal.mockImplementation(
			async (_provider, _host, _instanceId, callback) => {
				onTerminalEvent = callback;
			},
		);
		const onConnected = vi.fn();
		const onCloseSettled = vi.fn();

		renderWithProviders(
			<ForgeConnectDialog
				open
				onOpenChange={vi.fn()}
				provider="github"
				host="github.com"
				repoId="repo-1"
				workspaceId="workspace-1"
				onConnected={onConnected}
				onCloseSettled={onCloseSettled}
			/>,
		);

		await waitFor(() => {
			expect(apiMocks.spawnForgeCliAuthTerminal).toHaveBeenCalled();
		});

		await act(async () => {
			onTerminalEvent?.({ type: "exited", code: 0 });
		});

		await waitFor(() => {
			expect(apiMocks.retryRepoForgeBinding).toHaveBeenCalledWith("repo-1");
			expect(onConnected).not.toHaveBeenCalled();
			expect(onCloseSettled).toHaveBeenCalledWith({
				provider: "github",
				host: "github.com",
				connected: false,
				login: null,
			});
		});
	});

	it("does not report connected when workspace context cannot resolve a repo", async () => {
		let onTerminalEvent: ((event: ScriptEvent) => void) | null = null;
		apiMocks.listForgeLogins
			.mockResolvedValueOnce(["octocat"])
			.mockResolvedValueOnce(["octocat"]);
		apiMocks.spawnForgeCliAuthTerminal.mockImplementation(
			async (_provider, _host, _instanceId, callback) => {
				onTerminalEvent = callback;
			},
		);
		const onConnected = vi.fn();
		const onCloseSettled = vi.fn();

		renderWithProviders(
			<ForgeConnectDialog
				open
				onOpenChange={vi.fn()}
				provider="github"
				host="github.com"
				workspaceId="workspace-1"
				onConnected={onConnected}
				onCloseSettled={onCloseSettled}
			/>,
		);

		await waitFor(() => {
			expect(apiMocks.spawnForgeCliAuthTerminal).toHaveBeenCalled();
		});

		await act(async () => {
			onTerminalEvent?.({ type: "exited", code: 0 });
		});

		await waitFor(() => {
			expect(apiMocks.loadWorkspaceDetail).toHaveBeenCalledWith("workspace-1");
			expect(apiMocks.retryRepoForgeBinding).not.toHaveBeenCalled();
			expect(onConnected).not.toHaveBeenCalled();
			expect(onCloseSettled).toHaveBeenCalledWith({
				provider: "github",
				host: "github.com",
				connected: false,
				login: null,
			});
		});
	});
});
