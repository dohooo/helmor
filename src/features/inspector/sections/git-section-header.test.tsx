import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChangeRequestInfo, ForgeDetection } from "@/lib/api";
import { renderWithProviders } from "@/test/render-with-providers";
import { GitSectionHeader } from "./git-section-header";

// The dialog spawns a real PTY through Tauri IPC; replace it with a probe so
// these tests stay structural and don't pull in the auth flow (already
// covered by `forge-connect-dialog.test.tsx`).
vi.mock("./forge-cli-onboarding", () => ({
	ForgeCliTrigger: ({ detection }: { detection: ForgeDetection }) => (
		<button type="button" data-testid="forge-connect-trigger">
			{detection.labels.connectAction}
		</button>
	),
}));

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
	afterEach(() => {
		cleanup();
	});

	it("swaps the change-request pill for the Connect CTA when remote auth is broken (GitLab)", () => {
		renderWithProviders(
			<GitSectionHeader
				commitButtonMode="merge"
				commitButtonState="idle"
				changeRequest={changeRequest}
				changeRequestName="MR"
				forgeDetection={gitlabDetection()}
				forgeRemoteState="unauthenticated"
				workspaceId="workspace-1"
			/>,
		);

		const title = screen.getByText("Git");
		const connectTrigger = screen.getByTestId("forge-connect-trigger");

		expect(title).toBeInTheDocument();
		expect(connectTrigger).toHaveTextContent("Connect GitLab");
		expectElementBefore(title, connectTrigger);
		expect(screen.queryByText("!182")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Merge" }),
		).not.toBeInTheDocument();
	});

	it("swaps the change-request pill for the Connect CTA when remote auth is broken (GitHub)", () => {
		const githubChangeRequest = { ...changeRequest, number: 42 };
		renderWithProviders(
			<GitSectionHeader
				commitButtonMode="merge"
				commitButtonState="idle"
				changeRequest={githubChangeRequest}
				changeRequestName="PR"
				forgeDetection={githubDetection()}
				forgeRemoteState="unauthenticated"
				workspaceId="workspace-1"
			/>,
		);

		const connectTrigger = screen.getByTestId("forge-connect-trigger");
		expect(connectTrigger).toHaveTextContent("Connect GitHub");
		// PR pill is suppressed in favour of the single CTA.
		expect(screen.queryByText("#42")).not.toBeInTheDocument();
	});

	it("renders the change-request pill (no Connect CTA) when remote auth is healthy", () => {
		renderWithProviders(
			<GitSectionHeader
				commitButtonMode="merge"
				commitButtonState="idle"
				changeRequest={changeRequest}
				changeRequestName="MR"
				forgeDetection={gitlabDetection()}
				forgeRemoteState="ok"
				workspaceId="workspace-1"
			/>,
		);

		expect(
			screen.queryByTestId("forge-connect-trigger"),
		).not.toBeInTheDocument();
		// PR pill button has no accessible name we can match by — assert the
		// number text is rendered.
		expect(screen.getByText("!182")).toBeInTheDocument();
	});

	it("does not render the Connect CTA when forgeDetection is null even if remote is unauth", () => {
		// Edge case: detection failed (no provider classified), so we have
		// nothing to point the connect flow at. Stay quiet rather than
		// rendering a broken button.
		renderWithProviders(
			<GitSectionHeader
				commitButtonMode="merge"
				commitButtonState="idle"
				changeRequest={changeRequest}
				changeRequestName="MR"
				forgeDetection={null}
				forgeRemoteState="unauthenticated"
				workspaceId="workspace-1"
			/>,
		);

		expect(
			screen.queryByTestId("forge-connect-trigger"),
		).not.toBeInTheDocument();
	});

	it("shows the shimmer when the commit button is disabled (mergeability computing)", () => {
		renderWithProviders(
			<GitSectionHeader
				commitButtonMode="merge"
				commitButtonState="disabled"
				changeRequest={changeRequest}
				changeRequestName="MR"
				forgeDetection={gitlabDetection()}
				forgeRemoteState="ok"
				workspaceId="workspace-1"
			/>,
		);

		expect(screen.getByTestId("git-header-shimmer")).toBeInTheDocument();
	});

	it("shows running checks as a non-green merge state", () => {
		renderWithProviders(
			<GitSectionHeader
				commitButtonMode="checks-running"
				commitButtonState="idle"
				changeRequest={changeRequest}
				changeRequestName="MR"
				forgeDetection={gitlabDetection()}
				forgeRemoteState="ok"
				workspaceId="workspace-1"
			/>,
		);

		const button = screen.getByRole("button", { name: /checks running/i });
		expect(button).toHaveAttribute("data-variant", "outline");
		expect(button.className).toContain("rounded-md");
		expect(button.className).toContain(
			"border-[var(--workspace-pr-checks-running-accent)]",
		);
		expect(screen.getByText("!182").closest("button")?.className).toContain(
			"border-[var(--workspace-pr-checks-running-accent)]",
		);
		expect(screen.queryByTestId("git-header-shimmer")).not.toBeInTheDocument();
	});

	it("shows branch-protection blocks as a blocked merge state", () => {
		renderWithProviders(
			<GitSectionHeader
				commitButtonMode="merge-blocked"
				commitButtonState="idle"
				changeRequest={changeRequest}
				changeRequestName="MR"
				forgeDetection={gitlabDetection()}
				forgeRemoteState="ok"
				workspaceId="workspace-1"
			/>,
		);

		const button = screen.getByRole("button", { name: /merge blocked/i });
		expect(button).toHaveAttribute("data-variant", "outline");
		expect(button.className).toContain(
			"border-[var(--workspace-pr-closed-accent)]",
		);
		expect(screen.queryByTestId("git-header-shimmer")).not.toBeInTheDocument();
	});

	it("shows the shimmer on the first cold fetch (isRefreshing)", () => {
		renderWithProviders(
			<GitSectionHeader
				commitButtonMode="merge"
				commitButtonState="idle"
				changeRequest={changeRequest}
				changeRequestName="MR"
				isRefreshing
				forgeDetection={gitlabDetection()}
				forgeRemoteState="ok"
				workspaceId="workspace-1"
			/>,
		);

		expect(screen.getByTestId("git-header-shimmer")).toBeInTheDocument();
	});

	it("does not shimmer in idle / busy / error states", () => {
		const { rerender } = renderWithProviders(
			<GitSectionHeader
				commitButtonMode="merge"
				commitButtonState="idle"
				changeRequest={changeRequest}
				changeRequestName="MR"
				forgeDetection={gitlabDetection()}
				forgeRemoteState="ok"
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
					forgeDetection={gitlabDetection()}
					forgeRemoteState="ok"
					workspaceId="workspace-1"
				/>,
			);
			expect(
				screen.queryByTestId("git-header-shimmer"),
			).not.toBeInTheDocument();
		}
	});
});
