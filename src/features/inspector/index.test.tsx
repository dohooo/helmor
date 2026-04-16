import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	WorkspaceGitActionStatus,
	WorkspacePrActionStatus,
} from "@/lib/api";
import { ComposerInsertProvider } from "@/lib/composer-insert-context";
import { renderWithProviders } from "@/test/render-with-providers";
import { WorkspaceInspectorSidebar } from "./index";

const apiMocks = vi.hoisted(() => ({
	listWorkspaceChangesWithContent: vi.fn(),
	getWorkspacePrCheckInsertText: vi.fn(),
	loadWorkspaceGitActionStatus: vi.fn(),
	loadWorkspacePrActionStatus: vi.fn(),
	syncWorkspaceWithTargetBranch: vi.fn(),
}));

const openerMocks = vi.hoisted(() => ({
	openUrl: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
	openUrl: openerMocks.openUrl,
}));

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();

	return {
		...actual,
		getWorkspacePrCheckInsertText: apiMocks.getWorkspacePrCheckInsertText,
		listWorkspaceChangesWithContent: apiMocks.listWorkspaceChangesWithContent,
		loadWorkspaceGitActionStatus: apiMocks.loadWorkspaceGitActionStatus,
		loadWorkspacePrActionStatus: apiMocks.loadWorkspacePrActionStatus,
		syncWorkspaceWithTargetBranch: apiMocks.syncWorkspaceWithTargetBranch,
	};
});

function cleanGitStatus(): WorkspaceGitActionStatus {
	return {
		uncommittedCount: 0,
		conflictCount: 0,
		syncTargetBranch: "main",
		syncStatus: "upToDate",
		behindTargetCount: 0,
		remoteTrackingRef: "refs/remotes/origin/main",
		aheadOfRemoteCount: 0,
	};
}

function emptyPrStatus(
	patch: Partial<WorkspacePrActionStatus> = {},
): WorkspacePrActionStatus {
	return {
		pr: null,
		reviewDecision: null,
		mergeable: null,
		deployments: [],
		checks: [],
		remoteState: "unavailable",
		message: null,
		...patch,
	};
}

function renderInspector(
	props: Partial<ComponentProps<typeof WorkspaceInspectorSidebar>> = {},
) {
	return renderWithProviders(
		<WorkspaceInspectorSidebar
			workspaceId="workspace-1"
			workspaceRootPath="/tmp/workspace"
			workspaceBranch="feature/actions"
			workspaceTargetBranch="main"
			workspaceRemote="origin"
			editorMode={false}
			onOpenEditorFile={vi.fn()}
			{...props}
		/>,
	);
}

function expectTextBefore(
	container: HTMLElement,
	first: string,
	second: string,
) {
	const firstNode = within(container).getByText(first);
	const secondNode = within(container).getByText(second);
	expect(
		firstNode.compareDocumentPosition(secondNode) &
			Node.DOCUMENT_POSITION_FOLLOWING,
	).toBeTruthy();
}

describe("WorkspaceInspectorSidebar Actions section", () => {
	beforeEach(() => {
		apiMocks.listWorkspaceChangesWithContent.mockReset();
		apiMocks.getWorkspacePrCheckInsertText.mockReset();
		apiMocks.loadWorkspaceGitActionStatus.mockReset();
		apiMocks.loadWorkspacePrActionStatus.mockReset();
		apiMocks.syncWorkspaceWithTargetBranch.mockReset();
		openerMocks.openUrl.mockReset();

		apiMocks.listWorkspaceChangesWithContent.mockResolvedValue({
			items: [],
			prefetched: [],
		});
		apiMocks.getWorkspacePrCheckInsertText.mockResolvedValue(
			"Content Log:\ncheck output",
		);
		apiMocks.loadWorkspaceGitActionStatus.mockResolvedValue(cleanGitStatus());
		apiMocks.loadWorkspacePrActionStatus.mockResolvedValue(emptyPrStatus());
		apiMocks.syncWorkspaceWithTargetBranch.mockResolvedValue({
			outcome: "updated",
			targetBranch: "main",
		});
	});

	afterEach(() => {
		cleanup();
	});

	it("hides deployments and checks when remote arrays are empty", async () => {
		renderInspector();

		await screen.findByText("No uncommitted changes");

		const actions = screen.getByLabelText("Inspector section Actions");
		expect(within(actions).queryByText("Deployments")).not.toBeInTheDocument();
		expect(within(actions).queryByText("Checks")).not.toBeInTheDocument();
		expect(within(actions).queryByText("marketing")).not.toBeInTheDocument();
		expect(
			within(actions).queryByText("staging-locked"),
		).not.toBeInTheDocument();
	});

	it("shows clean git rows with passed status icons", async () => {
		renderInspector();

		await screen.findByText("Up to date with origin/main");

		const actions = screen.getByLabelText("Inspector section Actions");
		expect(
			within(actions).getByText("Up to date with origin/main"),
		).toBeInTheDocument();
		expect(
			within(actions).getByText("Waiting for PR review"),
		).toBeInTheDocument();
		expect(
			within(actions).getByText("Branch fully pushed"),
		).toBeInTheDocument();
		expect(within(actions).getAllByLabelText("Passed")).toHaveLength(3);
	});

	it("keeps the actions scroll area shrinkable when tabs are collapsed", async () => {
		renderInspector();

		await screen.findByText("Up to date with origin/main");

		const actionsBody = screen.getByLabelText("Actions panel body");
		expect(actionsBody).toHaveClass("min-h-0");
	});

	it("shows dirty and conflicting git rows and reuses commit action handlers", async () => {
		const user = userEvent.setup();
		const onCommitAction = vi.fn();
		apiMocks.loadWorkspaceGitActionStatus.mockResolvedValue({
			uncommittedCount: 2,
			conflictCount: 1,
			syncTargetBranch: "main",
			syncStatus: "behind",
			behindTargetCount: 2,
		});

		renderInspector({ onCommitAction });

		await screen.findByText("2 uncommitted changes");
		await user.click(screen.getByRole("button", { name: "Commit and push" }));
		await user.click(screen.getByRole("button", { name: "Resolve" }));

		expect(onCommitAction).toHaveBeenCalledWith("commit-and-push");
		expect(onCommitAction).toHaveBeenCalledWith("resolve-conflicts");
	});

	it("shows pull when target branch is behind and triggers sync action", async () => {
		const user = userEvent.setup();
		apiMocks.loadWorkspaceGitActionStatus.mockResolvedValue({
			uncommittedCount: 0,
			conflictCount: 0,
			syncTargetBranch: "main",
			syncStatus: "behind",
			behindTargetCount: 2,
		});

		renderInspector();

		await screen.findByText("2 commits behind origin/main");
		await user.click(screen.getByRole("button", { name: "Pull" }));

		await waitFor(() => {
			expect(apiMocks.syncWorkspaceWithTargetBranch).toHaveBeenCalledWith(
				"workspace-1",
			);
		});
	});

	it("shows push when local branch is ahead of its remote tracking ref", async () => {
		const user = userEvent.setup();
		const onCommitAction = vi.fn();
		apiMocks.loadWorkspaceGitActionStatus.mockResolvedValue({
			uncommittedCount: 0,
			conflictCount: 0,
			syncTargetBranch: "main",
			syncStatus: "upToDate",
			behindTargetCount: 0,
			remoteTrackingRef: "refs/remotes/origin/dohooo/short-reply-setting",
			aheadOfRemoteCount: 2,
		});

		renderInspector({ onCommitAction });

		await screen.findByText(
			"2 commits ahead of refs/remotes/origin/dohooo/short-reply-setting",
		);
		await user.click(screen.getByRole("button", { name: "Push" }));

		expect(onCommitAction).toHaveBeenCalledWith("push");
	});

	it("prioritizes actionable git rows ahead of passed checks", async () => {
		apiMocks.loadWorkspaceGitActionStatus.mockResolvedValue({
			uncommittedCount: 0,
			conflictCount: 0,
			syncTargetBranch: "main",
			syncStatus: "behind",
			behindTargetCount: 23,
			remoteTrackingRef: "origin/dohooo/leo",
			aheadOfRemoteCount: 6,
		});
		apiMocks.loadWorkspacePrActionStatus.mockResolvedValue(
			emptyPrStatus({
				remoteState: "ok",
				reviewDecision: "APPROVED",
			}),
		);

		renderInspector();

		await screen.findByText("6 commits ahead of origin/dohooo/leo");

		const actions = screen.getByLabelText("Inspector section Actions");
		expectTextBefore(
			actions,
			"6 commits ahead of origin/dohooo/leo",
			"No uncommitted changes",
		);
		expectTextBefore(
			actions,
			"23 commits behind origin/main",
			"No uncommitted changes",
		);
		expectTextBefore(actions, "No uncommitted changes", "Review approved");
	});

	it("keeps failing review rows ahead of passed review rows", async () => {
		apiMocks.loadWorkspacePrActionStatus.mockResolvedValue(
			emptyPrStatus({
				remoteState: "ok",
				reviewDecision: "APPROVED",
				mergeable: "CONFLICTING",
			}),
		);

		renderInspector();

		await screen.findByText("Review approved");

		const actions = screen.getByLabelText("Inspector section Actions");
		expectTextBefore(actions, "Merge conflicts detected", "Review approved");
	});

	it("hides pull when conflicts are present even if target is behind", async () => {
		apiMocks.loadWorkspaceGitActionStatus.mockResolvedValue({
			uncommittedCount: 0,
			conflictCount: 1,
			syncTargetBranch: "main",
			syncStatus: "behind",
			behindTargetCount: 3,
		});

		renderInspector();

		await screen.findByText("Merge conflicts detected");
		expect(
			screen.queryByRole("button", { name: "Pull" }),
		).not.toBeInTheDocument();
	});

	it("disables git row actions while the commit lifecycle is busy", async () => {
		apiMocks.loadWorkspaceGitActionStatus.mockResolvedValue({
			uncommittedCount: 1,
			conflictCount: 0,
			syncTargetBranch: "main",
			syncStatus: "upToDate",
			behindTargetCount: 0,
		});

		renderInspector({ commitButtonState: "busy" });

		expect(
			await screen.findByRole("button", { name: "Commit and push" }),
		).toBeDisabled();
	});

	it("renders running and failed remote status colors with accessible labels", async () => {
		apiMocks.loadWorkspacePrActionStatus.mockResolvedValue(
			emptyPrStatus({
				remoteState: "ok",
				deployments: [
					{
						id: "deploy-1",
						name: "Preview",
						provider: "vercel",
						status: "running",
						url: "https://preview.example.com",
					},
				],
				checks: [
					{
						id: "check-1",
						name: "changes",
						provider: "github",
						status: "failure",
						duration: "12s",
						url: null,
					},
				],
			}),
		);

		renderInspector();

		await screen.findByText("Preview");

		expect(screen.getByText("Deployments")).toBeInTheDocument();
		expect(screen.getByText("Checks")).toBeInTheDocument();
		expect(screen.getByLabelText("Running")).toHaveStyle({
			color: "rgb(245, 158, 11)",
		});
		expect(screen.getByLabelText("Failed")).toHaveStyle({
			color: "rgb(207, 34, 46)",
		});
	});

	it("sorts checks by urgency and keeps the full GitHub check names visible", async () => {
		apiMocks.loadWorkspacePrActionStatus.mockResolvedValue(
			emptyPrStatus({
				remoteState: "ok",
				checks: [
					{
						id: "check-success",
						name: "Build / App Build (push)",
						provider: "github",
						status: "success",
						url: null,
					},
					{
						id: "check-running",
						name: "Test / Frontend Test (push)",
						provider: "github",
						status: "running",
						url: null,
					},
					{
						id: "check-failure",
						name: "Quality / Detect Changes (pull_request)",
						provider: "github",
						status: "failure",
						url: null,
					},
				],
			}),
		);

		renderInspector();

		const failing = await screen.findByText(
			"Quality / Detect Changes (pull_request)",
		);
		const running = screen.getByText("Test / Frontend Test (push)");
		const success = screen.getByText("Build / App Build (push)");

		expect(failing).toBeInTheDocument();
		expect(running).toBeInTheDocument();
		expect(success).toBeInTheDocument();
		expect(
			failing.compareDocumentPosition(running) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(
			running.compareDocumentPosition(success) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("vertically centers check row content and actions", async () => {
		apiMocks.loadWorkspacePrActionStatus.mockResolvedValue(
			emptyPrStatus({
				remoteState: "ok",
				checks: [
					{
						id: "check-centered",
						name: "App Build",
						provider: "github",
						status: "success",
						duration: "1m",
						url: "https://github.com/acme/repo/actions/runs/1",
					},
				],
			}),
		);

		renderInspector();

		const checkName = await screen.findByText("App Build");
		const row = checkName.closest(".group\\/check-row");
		expect(row).toHaveClass("items-center");
		expect(row).not.toHaveClass("items-start");

		const content = checkName.parentElement;
		expect(content).toHaveClass("items-center");
		expect(content).not.toHaveClass("items-start");

		const actions = screen.getByRole("button", {
			name: "Open App Build",
		}).parentElement;
		expect(actions).toHaveClass("gap-0");
		expect(screen.getByRole("button", { name: "Open App Build" })).toHaveClass(
			"size-5",
		);

		expect(screen.getByText("1m")).not.toHaveClass("pt-px");
	});

	it("renders link buttons only for remote items with urls", async () => {
		const user = userEvent.setup();
		apiMocks.loadWorkspacePrActionStatus.mockResolvedValue(
			emptyPrStatus({
				remoteState: "ok",
				checks: [
					{
						id: "check-linked",
						name: "linked-check",
						provider: "github",
						status: "success",
						url: "https://github.com/acme/repo/actions/runs/1",
					},
					{
						id: "check-unlinked",
						name: "unlinked-check",
						provider: "github",
						status: "success",
						url: null,
					},
				],
			}),
		);

		renderInspector();

		await screen.findByText("linked-check");
		expect(screen.getByText("unlinked-check")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Open unlinked-check" }),
		).not.toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Open linked-check" }));

		await waitFor(() => {
			expect(openerMocks.openUrl).toHaveBeenCalledWith(
				"https://github.com/acme/repo/actions/runs/1",
			);
		});
	});

	it("uses compact icon button chrome for append and open actions", async () => {
		apiMocks.loadWorkspacePrActionStatus.mockResolvedValue(
			emptyPrStatus({
				remoteState: "ok",
				checks: [
					{
						id: "check-1",
						name: "changes",
						provider: "github",
						status: "failure",
						url: "https://github.com/acme/repo/actions/runs/1",
					},
				],
			}),
		);

		renderInspector();

		const appendButton = await screen.findByRole("button", {
			name: "Append changes to composer",
		});
		const openButton = screen.getByRole("button", { name: "Open changes" });

		expect(appendButton).toHaveClass("cursor-pointer");
		expect(appendButton).toHaveClass("size-4");
		expect(appendButton).toHaveClass("opacity-0");
		expect(appendButton).toHaveClass("pointer-events-none");
		expect(appendButton).toHaveClass("group-hover/check-row:opacity-55");
		expect(appendButton).toHaveClass(
			"group-focus-within/check-row:pointer-events-auto",
		);
		expect(appendButton).toHaveClass("hover:opacity-100");

		expect(openButton).toHaveClass("cursor-pointer");
		expect(openButton).toHaveClass("size-5");
		expect(openButton).toHaveClass("opacity-55");
		expect(openButton).toHaveClass("hover:opacity-100");
	});

	it("inserts check details into the composer and keeps deployments without insert buttons", async () => {
		const user = userEvent.setup();
		const insertIntoComposer = vi.fn();
		apiMocks.loadWorkspacePrActionStatus.mockResolvedValue(
			emptyPrStatus({
				remoteState: "ok",
				deployments: [
					{
						id: "deploy-1",
						name: "Preview",
						provider: "vercel",
						status: "running",
						url: "https://preview.example.com",
					},
				],
				checks: [
					{
						id: "check-1",
						name: "changes",
						provider: "github",
						status: "failure",
						duration: "12s",
						url: "https://github.com/acme/repo/actions/runs/1",
					},
				],
			}),
		);
		// 22 chars per line × 25 = 550 chars, above the composer preview threshold (500).
		const longCheckOutput = "const failure = true;\n".repeat(25);
		apiMocks.getWorkspacePrCheckInsertText.mockResolvedValue(longCheckOutput);

		renderWithProviders(
			<ComposerInsertProvider value={insertIntoComposer}>
				<WorkspaceInspectorSidebar
					workspaceId="workspace-1"
					workspaceRootPath="/tmp/workspace"
					workspaceBranch="feature/actions"
					workspaceTargetBranch="main"
					workspaceRemote="origin"
					editorMode={false}
					onOpenEditorFile={vi.fn()}
				/>
			</ComposerInsertProvider>,
		);

		await screen.findByText("Preview");
		expect(
			screen.queryByRole("button", { name: "Append Preview to composer" }),
		).not.toBeInTheDocument();

		await user.click(
			screen.getByRole("button", { name: "Append changes to composer" }),
		);

		await waitFor(() => {
			expect(apiMocks.getWorkspacePrCheckInsertText).toHaveBeenCalledWith(
				"workspace-1",
				"check-1",
			);
		});

		expect(insertIntoComposer).toHaveBeenCalledWith({
			target: { workspaceId: "workspace-1" },
			items: [
				{
					kind: "custom-tag",
					label: "changes",
					submitText: longCheckOutput,
					key: "pr-check:check-1",
					preview: {
						kind: "code",
						title: "changes",
						language: "ts",
						code: longCheckOutput,
					},
				},
			],
			behavior: "append",
		});
	});

	it("uses the workspace remote when formatting sync target labels", async () => {
		apiMocks.loadWorkspaceGitActionStatus.mockResolvedValue({
			uncommittedCount: 0,
			conflictCount: 0,
			syncTargetBranch: "main",
			syncStatus: "upToDate",
			behindTargetCount: 0,
		});

		renderInspector({ workspaceRemote: "upstream" });

		await screen.findByText("Up to date with upstream/main");
	});
});
