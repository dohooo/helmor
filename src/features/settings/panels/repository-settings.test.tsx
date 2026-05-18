import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryCreateOption } from "@/lib/api";
import { DEFAULT_SETTINGS, SettingsContext } from "@/lib/settings";
import { renderWithProviders } from "@/test/render-with-providers";
import { RepositorySettingsPanel } from "./repository-settings";

const apiMocks = vi.hoisted(() => ({
	listRemoteBranches: vi.fn(),
	listRepoRemotes: vi.fn(),
	listForgeAccounts: vi.fn(),
	loadRepoPreferences: vi.fn(),
	loadRepoScripts: vi.fn(),
	prefetchRemoteRefs: vi.fn(),
	updateRepositoryBranchPrefix: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();
	return {
		...actual,
		listRemoteBranches: apiMocks.listRemoteBranches,
		listRepoRemotes: apiMocks.listRepoRemotes,
		listForgeAccounts: apiMocks.listForgeAccounts,
		loadRepoPreferences: apiMocks.loadRepoPreferences,
		loadRepoScripts: apiMocks.loadRepoScripts,
		prefetchRemoteRefs: apiMocks.prefetchRemoteRefs,
		updateRepositoryBranchPrefix: apiMocks.updateRepositoryBranchPrefix,
	};
});

function repo(
	overrides: Partial<RepositoryCreateOption>,
): RepositoryCreateOption {
	return {
		id: "repo-a",
		name: "Repo A",
		remote: "origin",
		remoteUrl: "git@github.com:acme/repo-a.git",
		defaultBranch: "main",
		forgeProvider: "github",
		forgeLogin: "octocat",
		branchPrefixType: "custom",
		repoInitials: "RA",
		...overrides,
	};
}

function renderPanel(repository: RepositoryCreateOption) {
	return renderWithProviders(
		<SettingsContext.Provider
			value={{
				settings: { ...DEFAULT_SETTINGS },
				isLoaded: true,
				updateSettings: vi.fn(),
			}}
		>
			<RepositorySettingsPanel
				repo={repository}
				workspaceId={null}
				onRepoSettingsChanged={vi.fn()}
				onRepoDeleted={vi.fn()}
			/>
		</SettingsContext.Provider>,
	);
}

describe("RepositorySettingsPanel branch prefix", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		apiMocks.listRemoteBranches.mockResolvedValue([]);
		apiMocks.listRepoRemotes.mockResolvedValue([]);
		apiMocks.listForgeAccounts.mockResolvedValue([]);
		apiMocks.loadRepoPreferences.mockResolvedValue({
			createPr: null,
			fixErrors: null,
			resolveConflicts: null,
			branchRename: null,
		});
		apiMocks.loadRepoScripts.mockResolvedValue({
			setupScript: null,
			runScript: null,
			archiveScript: null,
			setupFromProject: false,
			runFromProject: false,
			archiveFromProject: false,
			autoRunSetup: true,
		});
		apiMocks.prefetchRemoteRefs.mockResolvedValue({ fetched: false });
		apiMocks.updateRepositoryBranchPrefix.mockResolvedValue(undefined);
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it("cancels a pending custom-prefix save when switching repositories", () => {
		const { rerender } = renderPanel(
			repo({
				id: "repo-a",
				branchPrefixType: "custom",
				branchPrefixCustom: "a/",
			}),
		);

		fireEvent.change(screen.getByDisplayValue("a/"), {
			target: { value: "changed/" },
		});

		rerender(
			<SettingsContext.Provider
				value={{
					settings: { ...DEFAULT_SETTINGS },
					isLoaded: true,
					updateSettings: vi.fn(),
				}}
			>
				<RepositorySettingsPanel
					repo={repo({
						id: "repo-b",
						name: "Repo B",
						branchPrefixType: "custom",
						branchPrefixCustom: "b/",
					})}
					workspaceId={null}
					onRepoSettingsChanged={vi.fn()}
					onRepoDeleted={vi.fn()}
				/>
			</SettingsContext.Provider>,
		);

		vi.advanceTimersByTime(401);

		expect(apiMocks.updateRepositoryBranchPrefix).not.toHaveBeenCalled();
	});

	it("does not overwrite in-progress typing after a same-repo refresh", () => {
		const { rerender } = renderPanel(
			repo({
				id: "repo-a",
				branchPrefixType: "custom",
				branchPrefixCustom: "repo/",
			}),
		);

		fireEvent.change(screen.getByDisplayValue("repo/"), {
			target: { value: "repo/feature/" },
		});

		rerender(
			<SettingsContext.Provider
				value={{
					settings: { ...DEFAULT_SETTINGS },
					isLoaded: true,
					updateSettings: vi.fn(),
				}}
			>
				<RepositorySettingsPanel
					repo={repo({
						id: "repo-a",
						branchPrefixType: "custom",
						branchPrefixCustom: "repo/f",
					})}
					workspaceId={null}
					onRepoSettingsChanged={vi.fn()}
					onRepoDeleted={vi.fn()}
				/>
			</SettingsContext.Provider>,
		);

		expect(screen.getByDisplayValue("repo/feature/")).toBeInTheDocument();
	});

	it("renders the bound forge account login in the panel header", () => {
		renderPanel(
			repo({
				forgeLogin: "octocat",
			}),
		);

		expect(screen.getByText("@octocat")).toBeInTheDocument();
	});

	it("renders an unconnected header with a Connect CTA when forgeLogin is null", () => {
		renderPanel(
			repo({
				forgeLogin: null,
			}),
		);

		expect(screen.getByText("GitHub not connected")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /^Connect$/i }),
		).toBeInTheDocument();
	});
});
