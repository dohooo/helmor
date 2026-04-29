import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ChangeRequestInfo,
	ForgeCliStatus,
	ForgeDetection,
} from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import { renderWithProviders } from "@/test/render-with-providers";
import { GitSectionHeader } from "./git-section-header";

const apiMocks = vi.hoisted(() => ({
	getWorkspaceForge: vi.fn(),
	getForgeCliStatus: vi.fn(),
	openForgeCliAuthTerminal: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();

	return {
		...actual,
		getWorkspaceForge: apiMocks.getWorkspaceForge,
		getForgeCliStatus: apiMocks.getForgeCliStatus,
		openForgeCliAuthTerminal: apiMocks.openForgeCliAuthTerminal,
	};
});

const changeRequest: ChangeRequestInfo = {
	url: "https://gitlab.com/helmor/helmor/-/merge_requests/182",
	number: 182,
	state: "OPEN",
	title: "Add GitLab forge support",
	isMerged: false,
};

function gitlabDetection(patch: Partial<ForgeDetection> = {}): ForgeDetection {
	return {
		provider: "gitlab",
		host: "gitlab.com",
		namespace: "helmor",
		repo: "helmor",
		remoteUrl: "git@gitlab.com:helmor/helmor.git",
		labels: {
			providerName: "GitLab",
			cliName: "glab",
			changeRequestName: "MR",
			changeRequestFullName: "merge request",
			connectAction: "Connect GitLab",
		},
		cli: {
			status: "unauthenticated",
			provider: "gitlab",
			host: "gitlab.com",
			cliName: "glab",
			version: "1.50.0",
			message: "Run `glab auth login --hostname gitlab.com`.",
			loginCommand: "glab auth login --hostname gitlab.com",
		},
		detectionSignals: [],
		...patch,
	};
}

function githubDetection(patch: Partial<ForgeDetection> = {}): ForgeDetection {
	return {
		provider: "github",
		host: "github.com",
		namespace: "helmor",
		repo: "helmor",
		remoteUrl: "git@github.com:helmor/helmor.git",
		labels: {
			providerName: "GitHub",
			cliName: "gh",
			changeRequestName: "PR",
			changeRequestFullName: "pull request",
			connectAction: "Connect GitHub",
		},
		cli: {
			status: "unauthenticated",
			provider: "github",
			host: "github.com",
			cliName: "gh",
			version: "2.65.0",
			message: "Run `gh auth login`.",
			loginCommand: "gh auth login",
		},
		detectionSignals: [],
		...patch,
	};
}

function expectElementBefore(first: Element, second: Element) {
	expect(
		first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING,
	).toBeTruthy();
}

describe("GitSectionHeader forge onboarding", () => {
	beforeEach(() => {
		apiMocks.getWorkspaceForge.mockReset();
		apiMocks.getForgeCliStatus.mockReset();
		apiMocks.openForgeCliAuthTerminal.mockReset();
		apiMocks.openForgeCliAuthTerminal.mockResolvedValue(undefined);
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
	});

	it("shows a single connect CTA without also showing the MR pill", () => {
		renderWithProviders(
			<GitSectionHeader
				commitButtonMode="merge"
				commitButtonState="idle"
				changeRequest={changeRequest}
				changeRequestName="MR"
				forgeDetection={gitlabDetection()}
				workspaceId="workspace-1"
			/>,
		);

		const title = screen.getByText("Git");
		const connectButton = screen.getByRole("button", {
			name: "Connect GitLab",
		});

		expect(title).toBeInTheDocument();
		expect(connectButton).toBeInTheDocument();
		expect(screen.queryByLabelText(/Why do we think/)).not.toBeInTheDocument();
		expectElementBefore(title, connectButton);
		expect(screen.queryByText("!182")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Merge" }),
		).not.toBeInTheDocument();
	});

	it("shows CLI connect without also showing the MR pill", () => {
		renderWithProviders(
			<GitSectionHeader
				commitButtonMode="merge"
				commitButtonState="idle"
				changeRequest={changeRequest}
				changeRequestName="MR"
				forgeDetection={gitlabDetection({
					cli: {
						status: "ready",
						provider: "gitlab",
						host: "gitlab.com",
						cliName: "glab",
						login: "liangeqiang",
						version: "1.55.0",
						message: "Connected.",
					},
				})}
				forgeRemoteState="unauthenticated"
				workspaceId="workspace-1"
			/>,
		);

		const title = screen.getByText("Git");
		const connectButton = screen.getByRole("button", {
			name: "Connect GitLab",
		});

		expect(title).toBeInTheDocument();
		expect(connectButton).toBeInTheDocument();
		expect(screen.queryByLabelText(/Why do we think/)).not.toBeInTheDocument();
		expectElementBefore(title, connectButton);
		expect(screen.queryByText("!182")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Merge" }),
		).not.toBeInTheDocument();
	});

	it("refreshes MR and forge status after Terminal auth becomes ready", async () => {
		vi.useFakeTimers();
		const unauthenticatedDetection = gitlabDetection({
			cli: {
				status: "unauthenticated",
				provider: "gitlab",
				host: "gitlab.com",
				cliName: "glab",
				version: "1.55.0",
				message: "Run `glab auth login --hostname gitlab.com`.",
				loginCommand: "glab auth login --hostname gitlab.com",
			},
		});
		const readyStatus: ForgeCliStatus = {
			status: "ready",
			provider: "gitlab",
			host: "gitlab.com",
			cliName: "glab",
			login: "liangeqiang",
			version: "1.55.0",
			message: "Connected.",
		};
		apiMocks.getForgeCliStatus.mockResolvedValueOnce(readyStatus);

		const { queryClient } = renderWithProviders(
			<GitSectionHeader
				commitButtonMode="merge"
				commitButtonState="idle"
				changeRequest={changeRequest}
				changeRequestName="MR"
				forgeDetection={unauthenticatedDetection}
				workspaceId="workspace-1"
			/>,
		);
		const invalidateQueries = vi
			.spyOn(queryClient, "invalidateQueries")
			.mockResolvedValue(undefined);

		fireEvent.click(screen.getByRole("button", { name: "Connect GitLab" }));

		await vi.advanceTimersByTimeAsync(0);
		expect(apiMocks.openForgeCliAuthTerminal).toHaveBeenCalledWith(
			"gitlab",
			"gitlab.com",
		);
		await vi.advanceTimersByTimeAsync(2000);

		expect(apiMocks.getForgeCliStatus).toHaveBeenCalledWith(
			"gitlab",
			"gitlab.com",
		);
		// Hook fans out: forgeCliStatusAll + every workspaceForge entry,
		// onReady adds the workspace-scoped change request + action status.
		expect(invalidateQueries).toHaveBeenCalledWith({
			queryKey: helmorQueryKeys.forgeCliStatusAll,
		});
		expect(invalidateQueries).toHaveBeenCalledWith(
			expect.objectContaining({ predicate: expect.any(Function) }),
		);
		expect(invalidateQueries).toHaveBeenCalledWith({
			queryKey: helmorQueryKeys.workspaceChangeRequest("workspace-1"),
		});
		expect(invalidateQueries).toHaveBeenCalledWith({
			queryKey: helmorQueryKeys.workspaceForgeActionStatus("workspace-1"),
		});
	});

	// Edge case: local CLI snapshot says ready but the remote action probe
	// returned unauthenticated. The trigger is mounted because remote disagrees;
	// short-circuiting on the stale prop would toast "connected" while the user
	// is still locked out. The hook must open the terminal anyway.
	it("forces the terminal even when prop says ready, if remote disagrees", async () => {
		const localReadyButRemoteUnauth = gitlabDetection({
			cli: {
				status: "ready",
				provider: "gitlab",
				host: "gitlab.com",
				cliName: "glab",
				login: "liangeqiang",
				version: "1.55.0",
				message: "Connected.",
			},
		});

		renderWithProviders(
			<GitSectionHeader
				commitButtonMode="merge"
				commitButtonState="idle"
				changeRequest={changeRequest}
				changeRequestName="MR"
				forgeDetection={localReadyButRemoteUnauth}
				forgeRemoteState="unauthenticated"
				workspaceId="workspace-1"
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Connect GitLab" }));

		await waitFor(() => {
			expect(apiMocks.openForgeCliAuthTerminal).toHaveBeenCalledWith(
				"gitlab",
				"gitlab.com",
			);
		});
	});

	it("does not open duplicate auth terminals on repeated connect clicks", async () => {
		const unauthenticatedDetection = gitlabDetection({
			cli: {
				status: "unauthenticated",
				provider: "gitlab",
				host: "gitlab.com",
				cliName: "glab",
				version: "1.55.0",
				message: "Run `glab auth login --hostname gitlab.com`.",
				loginCommand: "glab auth login --hostname gitlab.com",
			},
		});
		apiMocks.getWorkspaceForge.mockResolvedValue(unauthenticatedDetection);

		renderWithProviders(
			<GitSectionHeader
				commitButtonMode="merge"
				commitButtonState="idle"
				changeRequest={changeRequest}
				changeRequestName="MR"
				forgeDetection={unauthenticatedDetection}
				workspaceId="workspace-1"
			/>,
		);

		const connectButton = screen.getByRole("button", {
			name: "Connect GitLab",
		});
		fireEvent.click(connectButton);
		fireEvent.click(connectButton);

		await waitFor(() => {
			expect(apiMocks.openForgeCliAuthTerminal).toHaveBeenCalledTimes(1);
		});
	});

	it("opens the auth terminal directly when CLI is not yet authenticated", async () => {
		apiMocks.getWorkspaceForge.mockResolvedValue(gitlabDetection());

		renderWithProviders(
			<GitSectionHeader
				commitButtonMode="merge"
				commitButtonState="idle"
				changeRequest={changeRequest}
				changeRequestName="MR"
				forgeDetection={gitlabDetection()}
				workspaceId="workspace-1"
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Connect GitLab" }));

		await waitFor(() => {
			expect(apiMocks.openForgeCliAuthTerminal).toHaveBeenCalledWith(
				"gitlab",
				"gitlab.com",
			);
		});
	});

	it("shows shimmer when the commit button is disabled (mergeable computing)", () => {
		renderWithProviders(
			<GitSectionHeader
				commitButtonMode="merge"
				commitButtonState="disabled"
				changeRequest={changeRequest}
				changeRequestName="MR"
				forgeDetection={gitlabDetection({
					cli: {
						status: "ready",
						provider: "gitlab",
						host: "gitlab.com",
						cliName: "glab",
						login: "liangeqiang",
						version: "1.55.0",
						message: "Connected.",
					},
				})}
				workspaceId="workspace-1"
			/>,
		);

		expect(screen.getByTestId("git-header-shimmer")).toBeInTheDocument();
	});

	it("shows shimmer on the first cold fetch", () => {
		renderWithProviders(
			<GitSectionHeader
				commitButtonMode="merge"
				commitButtonState="idle"
				changeRequest={changeRequest}
				changeRequestName="MR"
				isRefreshing
				forgeDetection={gitlabDetection({
					cli: {
						status: "ready",
						provider: "gitlab",
						host: "gitlab.com",
						cliName: "glab",
						login: "liangeqiang",
						version: "1.55.0",
						message: "Connected.",
					},
				})}
				workspaceId="workspace-1"
			/>,
		);

		expect(screen.getByTestId("git-header-shimmer")).toBeInTheDocument();
	});

	it("does not shimmer in idle / busy / done states", () => {
		const { rerender } = renderWithProviders(
			<GitSectionHeader
				commitButtonMode="merge"
				commitButtonState="idle"
				changeRequest={changeRequest}
				changeRequestName="MR"
				forgeDetection={gitlabDetection({
					cli: {
						status: "ready",
						provider: "gitlab",
						host: "gitlab.com",
						cliName: "glab",
						login: "liangeqiang",
						version: "1.55.0",
						message: "Connected.",
					},
				})}
				workspaceId="workspace-1"
			/>,
		);
		expect(screen.queryByTestId("git-header-shimmer")).not.toBeInTheDocument();

		for (const state of ["busy", "done", "error"] as const) {
			rerender(
				<GitSectionHeader
					commitButtonMode="merge"
					commitButtonState={state}
					changeRequest={changeRequest}
					changeRequestName="MR"
					forgeDetection={gitlabDetection({
						cli: {
							status: "ready",
							provider: "gitlab",
							host: "gitlab.com",
							cliName: "glab",
							login: "liangeqiang",
							version: "1.55.0",
							message: "Connected.",
						},
					})}
					workspaceId="workspace-1"
				/>,
			);
			expect(
				screen.queryByTestId("git-header-shimmer"),
			).not.toBeInTheDocument();
		}
	});

	it("hides the Review PR button when there is no change request", () => {
		renderWithProviders(
			<GitSectionHeader
				commitButtonMode="create-pr"
				commitButtonState="idle"
				changeRequest={null}
				hasChanges
				changeRequestName="PR"
				forgeDetection={githubDetection({
					cli: {
						status: "ready",
						provider: "github",
						host: "github.com",
						cliName: "gh",
						login: "lucas",
						version: "2.65.0",
						message: "Connected.",
					},
				})}
				workspaceId="workspace-1"
				onReviewPr={vi.fn()}
			/>,
		);

		expect(
			screen.queryByRole("button", { name: /Review PR/i }),
		).not.toBeInTheDocument();
	});

	it("hides the Review PR button when the change request is not open", () => {
		renderWithProviders(
			<GitSectionHeader
				commitButtonMode="merged"
				commitButtonState="idle"
				changeRequest={{ ...changeRequest, state: "MERGED", isMerged: true }}
				changeRequestName="MR"
				forgeDetection={gitlabDetection({
					cli: {
						status: "ready",
						provider: "gitlab",
						host: "gitlab.com",
						cliName: "glab",
						login: "lucas",
						version: "1.55.0",
						message: "Connected.",
					},
				})}
				workspaceId="workspace-1"
				onReviewPr={vi.fn()}
			/>,
		);

		expect(
			screen.queryByRole("button", { name: /Review MR/i }),
		).not.toBeInTheDocument();
	});

	it("shows the Review PR button on an open PR and fires onReviewPr on click", () => {
		const onReviewPr = vi.fn();
		renderWithProviders(
			<GitSectionHeader
				commitButtonMode="merge"
				commitButtonState="idle"
				changeRequest={changeRequest}
				changeRequestName="MR"
				forgeDetection={gitlabDetection({
					cli: {
						status: "ready",
						provider: "gitlab",
						host: "gitlab.com",
						cliName: "glab",
						login: "lucas",
						version: "1.55.0",
						message: "Connected.",
					},
				})}
				workspaceId="workspace-1"
				onReviewPr={onReviewPr}
			/>,
		);

		const reviewButton = screen.getByRole("button", { name: /Review MR/i });
		expect(reviewButton).toBeInTheDocument();
		fireEvent.click(reviewButton);
		expect(onReviewPr).toHaveBeenCalledTimes(1);
	});

	it("uses the same connect CTA for GitHub onboarding", async () => {
		apiMocks.getWorkspaceForge.mockResolvedValue(githubDetection());

		renderWithProviders(
			<GitSectionHeader
				commitButtonMode="merge"
				commitButtonState="idle"
				changeRequest={changeRequest}
				changeRequestName="PR"
				forgeDetection={githubDetection()}
				workspaceId="workspace-1"
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Connect GitHub" }));

		await waitFor(() => {
			expect(apiMocks.openForgeCliAuthTerminal).toHaveBeenCalledWith(
				"github",
				"github.com",
			);
		});
	});
});
