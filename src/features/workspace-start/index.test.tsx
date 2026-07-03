import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// WP7 Gate 2: with ZERO repositories the start page must swap its heading for
// an in-place guide with an Add-repository CTA. The start-surface controller
// locks `mode` to "chat" when no repos exist, so the guide keys off the repo
// count alone — and the composer stays fully usable (chat is a legal no-repo
// path that must never be blocked).

const mocks = vi.hoisted(() => ({
	publishShellEvent: vi.fn(),
}));

vi.mock("@/shell/event-bus", () => ({
	publishShellEvent: mocks.publishShellEvent,
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import type { RepositoryCreateOption } from "@/lib/api";
import { WorkspaceStartPage } from "./index";

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

function renderStartPage({
	mode,
	repositories = [],
}: {
	mode: "local" | "worktree" | "chat";
	repositories?: RepositoryCreateOption[];
}) {
	return render(
		<TooltipProvider>
			<WorkspaceStartPage
				repositories={repositories}
				selectedRepository={repositories[0] ?? null}
				onSelectRepository={vi.fn()}
				selectedBranch=""
				branches={[]}
				branchesLoading={false}
				onOpenBranchPicker={vi.fn()}
				onSelectBranch={vi.fn()}
				mode={mode}
				onModeChange={vi.fn()}
				branchIntent="use_branch"
				onBranchIntentChange={vi.fn()}
			>
				<div data-testid="composer-slot" />
			</WorkspaceStartPage>
		</TooltipProvider>,
	);
}

describe("WorkspaceStartPage — no-repo guide (WP7 Gate 2)", () => {
	it("zero repos shows the guide with the underlined connect-repo link (R4: no separate button)", () => {
		renderStartPage({ mode: "chat" });
		expect(screen.getByTestId("start-no-repo-guide")).toBeInTheDocument();
		// The sentence is split around the clickable fragment.
		expect(screen.getByTestId("start-connect-repo-link")).toHaveTextContent(
			"Connect a repository",
		);
		expect(
			screen.getByText(/to start building — or just chat\./),
		).toBeInTheDocument();
		// R4 ruling: the old standalone "Add repository" button is GONE.
		expect(
			screen.queryByRole("button", { name: "Add repository" }),
		).not.toBeInTheDocument();
	});

	it("clicking the connect-repo link opens the sidebar add-repo dropdown (shell event)", () => {
		renderStartPage({ mode: "chat" });
		fireEvent.click(screen.getByTestId("start-connect-repo-link"));
		expect(mocks.publishShellEvent).toHaveBeenCalledWith({
			type: "open-add-repository",
		});
	});

	it("the composer slot still renders alongside the guide (chat never blocked)", () => {
		renderStartPage({ mode: "chat" });
		expect(screen.getByTestId("composer-slot")).toBeInTheDocument();
	});

	it("chat mode WITH a repo keeps its normal heading (no guide)", () => {
		renderStartPage({
			mode: "chat",
			repositories: [
				{
					id: "r1",
					name: "helmor",
					fullPath: "/tmp/helmor",
					defaultBranch: "main",
				} as RepositoryCreateOption,
			],
		});
		expect(screen.queryByTestId("start-no-repo-guide")).toBeNull();
		expect(screen.getByText("What should we work on?")).toBeInTheDocument();
	});

	it("build mode WITH a repo does not render the guide", () => {
		renderStartPage({
			mode: "worktree",
			repositories: [
				{
					id: "r1",
					name: "helmor",
					fullPath: "/tmp/helmor",
					defaultBranch: "main",
				} as RepositoryCreateOption,
			],
		});
		expect(screen.queryByTestId("start-no-repo-guide")).toBeNull();
	});
});
