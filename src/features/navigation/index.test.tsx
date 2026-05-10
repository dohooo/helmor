import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { WorkspaceGroup, WorkspaceRow } from "@/lib/api";

import { WorkspacesSidebar } from "./index";

// One client shared across renders so each `cleanup()` releases all
// observers; a fresh client per render leaves focus listeners attached
// and the worker grows unboundedly over a multi-test file.
const testQueryClient = new QueryClient({
	defaultOptions: {
		queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false },
	},
});

function TestProviders({ children }: { children: ReactNode }) {
	return (
		<QueryClientProvider client={testQueryClient}>
			<TooltipProvider delayDuration={0}>{children}</TooltipProvider>
		</QueryClientProvider>
	);
}

const workspaceRow: WorkspaceRow = {
	id: "workspace-1",
	title: "Workspace 1",
	state: "ready",
	hasUnread: false,
};

const workspaceGroups: WorkspaceGroup[] = [
	{
		id: "progress",
		label: "In Progress",
		tone: "progress",
		rows: [workspaceRow],
	},
];

afterEach(() => {
	cleanup();
	window.localStorage.clear();
});

describe("WorkspacesSidebar", () => {
	it("shows the Helmor thinking indicator when a workspace enters sending state", () => {
		const { rerender } = render(
			<TestProviders>
				<WorkspacesSidebar
					groups={workspaceGroups}
					archivedRows={[]}
					selectedWorkspaceId="workspace-1"
					busyWorkspaceIds={new Set()}
				/>
			</TestProviders>,
		);

		const initialRow = screen.getByRole("button", { name: "Workspace 1" });
		expect(
			initialRow.querySelector('[data-slot="helmor-thinking-indicator"]'),
		).toBeNull();

		rerender(
			<TestProviders>
				<WorkspacesSidebar
					groups={workspaceGroups}
					archivedRows={[]}
					selectedWorkspaceId="workspace-1"
					busyWorkspaceIds={new Set(["workspace-1"])}
				/>
			</TestProviders>,
		);

		const updatedRow = screen.getByRole("button", { name: "Workspace 1" });
		expect(
			updatedRow.querySelector('[data-slot="helmor-thinking-indicator"]'),
		).not.toBeNull();
	});

	it("keeps the unread dot visible for the selected workspace", () => {
		render(
			<TestProviders>
				<WorkspacesSidebar
					groups={[
						{
							id: "progress",
							label: "In Progress",
							tone: "progress",
							rows: [{ ...workspaceRow, hasUnread: true }],
						},
					]}
					archivedRows={[]}
					selectedWorkspaceId="workspace-1"
				/>
			</TestProviders>,
		);

		expect(screen.getByLabelText("Unread")).toBeInTheDocument();
	});

	it("opens the workspace start page from the new workspace button", async () => {
		const user = userEvent.setup();
		const onOpenNewWorkspace = vi.fn();

		const { container } = render(
			<TestProviders>
				<WorkspacesSidebar
					groups={workspaceGroups}
					archivedRows={[]}
					onOpenNewWorkspace={onOpenNewWorkspace}
				/>
			</TestProviders>,
		);

		const [newWorkspaceButton] = within(container).getAllByRole("button", {
			name: "New workspace",
		});
		await user.click(newWorkspaceButton);

		expect(screen.queryByPlaceholderText("Search repositories")).toBeNull();
		expect(screen.queryByText("Repositories")).toBeNull();
		expect(screen.queryByRole("option", { name: /helmor/i })).toBeNull();
		expect(onOpenNewWorkspace).toHaveBeenCalledTimes(1);
	});

	it("shows an Open in Finder action for active workspaces", async () => {
		const user = userEvent.setup();
		const onOpenInFinder = vi.fn();

		render(
			<TestProviders>
				<WorkspacesSidebar
					groups={workspaceGroups}
					archivedRows={[]}
					onOpenInFinder={onOpenInFinder}
				/>
			</TestProviders>,
		);

		fireEvent.contextMenu(screen.getByRole("button", { name: "Workspace 1" }));
		await user.click(screen.getByRole("menuitem", { name: "Open in Finder" }));

		expect(onOpenInFinder).toHaveBeenCalledWith("workspace-1");
	});

	it("keeps non-archived sections open by default while archived stays collapsed", () => {
		const archivedRow: WorkspaceRow = {
			...workspaceRow,
			id: "archived-1",
			title: "Archived Workspace",
			state: "archived",
		};

		render(
			<TestProviders>
				<WorkspacesSidebar
					groups={workspaceGroups}
					archivedRows={[archivedRow]}
					selectedWorkspaceId={null}
				/>
			</TestProviders>,
		);

		expect(
			screen.getByRole("button", { name: "Workspace 1" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Archived Workspace" }),
		).not.toBeInTheDocument();
	});

	it("keeps empty groups visible with condensed spacing", () => {
		const emptyGroups: WorkspaceGroup[] = [
			{ id: "done", label: "Done", tone: "done", rows: [] },
			{ id: "review", label: "In review", tone: "review", rows: [] },
			{ id: "progress", label: "In progress", tone: "progress", rows: [] },
			{ id: "backlog", label: "Backlog", tone: "backlog", rows: [] },
			{ id: "canceled", label: "Canceled", tone: "canceled", rows: [] },
		];

		const { container } = render(
			<TestProviders>
				<WorkspacesSidebar groups={emptyGroups} archivedRows={[]} />
			</TestProviders>,
		);

		expect(screen.getByRole("button", { name: "Done" })).toHaveAttribute(
			"data-empty-group",
			"true",
		);
		expect(screen.getByRole("button", { name: "Archived" })).toHaveAttribute(
			"data-empty-group",
			"true",
		);

		const virtualList = container.querySelector(
			'[data-slot="workspace-groups-scroll"] > div',
		);
		expect(virtualList).toHaveStyle({ height: "252px" });
	});

	it("only disables the row whose workspace id is in archivingWorkspaceIds", async () => {
		const user = userEvent.setup();
		const onArchiveWorkspace = vi.fn();
		const groups: WorkspaceGroup[] = [
			{
				id: "progress",
				label: "In Progress",
				tone: "progress",
				rows: [
					workspaceRow,
					{
						...workspaceRow,
						id: "workspace-2",
						title: "Workspace 2",
					},
				],
			},
		];

		render(
			<TestProviders>
				<WorkspacesSidebar
					groups={groups}
					archivedRows={[]}
					onArchiveWorkspace={onArchiveWorkspace}
					archivingWorkspaceIds={new Set(["workspace-1"])}
				/>
			</TestProviders>,
		);

		const archiveButtons = screen.getAllByRole("button", {
			name: "Archive workspace",
		});

		expect(archiveButtons).toHaveLength(2);
		expect(archiveButtons[0]).toBeDisabled();
		expect(archiveButtons[1]).toBeEnabled();

		await user.click(archiveButtons[1]);
		expect(onArchiveWorkspace).toHaveBeenCalledWith("workspace-2");
	});

	it("keeps workspace actions enabled while a new workspace is being created", async () => {
		const user = userEvent.setup();
		const onArchiveWorkspace = vi.fn();

		render(
			<TestProviders>
				<WorkspacesSidebar
					groups={workspaceGroups}
					archivedRows={[]}
					onArchiveWorkspace={onArchiveWorkspace}
					creatingWorkspaceRepoId="repo-1"
				/>
			</TestProviders>,
		);

		const [archiveButton] = screen.getAllByRole("button", {
			name: "Archive workspace",
		});
		expect(archiveButton).toBeEnabled();

		await user.click(archiveButton);
		expect(onArchiveWorkspace).toHaveBeenCalledWith("workspace-1");
	});

	it("persists section collapse state in localStorage", async () => {
		const user = userEvent.setup();
		const collapsedGroups: WorkspaceGroup[] = [
			{
				id: "done",
				label: "Done",
				tone: "done",
				rows: [{ ...workspaceRow, id: "workspace-2", title: "Workspace 2" }],
			},
		];

		const { unmount } = render(
			<TestProviders>
				<WorkspacesSidebar
					groups={collapsedGroups}
					archivedRows={[]}
					selectedWorkspaceId={null}
				/>
			</TestProviders>,
		);

		expect(
			screen.getByRole("button", { name: "Workspace 2" }),
		).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: /^Done/ }));
		expect(
			screen.queryByRole("button", { name: "Workspace 2" }),
		).not.toBeInTheDocument();

		unmount();

		render(
			<TestProviders>
				<WorkspacesSidebar
					groups={collapsedGroups}
					archivedRows={[]}
					selectedWorkspaceId={null}
				/>
			</TestProviders>,
		);

		expect(
			screen.queryByRole("button", { name: "Workspace 2" }),
		).not.toBeInTheDocument();
	});

	it("keeps the yellow dot visible for any workspace waiting on user interaction", () => {
		const groups: WorkspaceGroup[] = [
			{
				id: "progress",
				label: "In Progress",
				tone: "progress",
				rows: [
					workspaceRow,
					{
						...workspaceRow,
						id: "workspace-2",
						title: "Workspace 2",
					},
				],
			},
		];

		render(
			<TestProviders>
				<WorkspacesSidebar
					groups={groups}
					archivedRows={[]}
					selectedWorkspaceId="workspace-1"
					interactionRequiredWorkspaceIds={
						new Set(["workspace-1", "workspace-2"])
					}
				/>
			</TestProviders>,
		);

		const selectedRow = screen.getByRole("button", { name: "Workspace 1" });
		const otherRow = screen.getByRole("button", { name: "Workspace 2" });

		expect(
			within(selectedRow).getByLabelText("Interaction required"),
		).toBeInTheDocument();
		expect(
			within(otherRow).getByLabelText("Interaction required"),
		).toBeInTheDocument();
	});

	it("does not auto-expand a collapsed group when groups data refreshes", async () => {
		const user = userEvent.setup();
		const groups: WorkspaceGroup[] = [
			{
				id: "progress",
				label: "In Progress",
				tone: "progress",
				rows: [workspaceRow],
			},
		];

		const { rerender } = render(
			<TestProviders>
				<WorkspacesSidebar
					groups={groups}
					archivedRows={[]}
					selectedWorkspaceId="workspace-1"
				/>
			</TestProviders>,
		);

		expect(
			screen.getByRole("button", { name: "Workspace 1" }),
		).toBeInTheDocument();

		// Collapse the group
		await user.click(screen.getByRole("button", { name: /^In Progress/ }));
		expect(
			screen.queryByRole("button", { name: "Workspace 1" }),
		).not.toBeInTheDocument();

		// Simulate a groups refetch (new array reference, same data)
		rerender(
			<TestProviders>
				<WorkspacesSidebar
					groups={[...groups.map((g) => ({ ...g, rows: [...g.rows] }))]}
					archivedRows={[]}
					selectedWorkspaceId="workspace-1"
				/>
			</TestProviders>,
		);

		// Group should stay collapsed
		expect(
			screen.queryByRole("button", { name: "Workspace 1" }),
		).not.toBeInTheDocument();
	});

	it("does not auto-expand destination group when workspace moves between groups", async () => {
		const user = userEvent.setup();
		const ws = { ...workspaceRow, id: "ws-move", title: "Moving WS" };
		const initialGroups: WorkspaceGroup[] = [
			{
				id: "done",
				label: "Done",
				tone: "done",
				rows: [{ ...workspaceRow, id: "ws-completed", title: "Completed WS" }],
			},
			{
				id: "progress",
				label: "In Progress",
				tone: "progress",
				rows: [ws],
			},
		];

		const { rerender } = render(
			<TestProviders>
				<WorkspacesSidebar
					groups={initialGroups}
					archivedRows={[]}
					selectedWorkspaceId="ws-move"
				/>
			</TestProviders>,
		);

		// Collapse the "Done" group
		await user.click(screen.getByRole("button", { name: /^Done/ }));
		expect(
			screen.queryByRole("button", { name: "Completed WS" }),
		).not.toBeInTheDocument();

		// Move workspace from progress to done (simulating status change)
		const afterMoveGroups: WorkspaceGroup[] = [
			{
				id: "done",
				label: "Done",
				tone: "done",
				rows: [
					ws,
					{ ...workspaceRow, id: "ws-completed", title: "Completed WS" },
				],
			},
			{
				id: "progress",
				label: "In Progress",
				tone: "progress",
				rows: [],
			},
		];

		rerender(
			<TestProviders>
				<WorkspacesSidebar
					groups={afterMoveGroups}
					archivedRows={[]}
					selectedWorkspaceId="ws-move"
				/>
			</TestProviders>,
		);

		// "Done" should stay collapsed — the workspace moved there but
		// selectedWorkspaceId didn't change
		expect(
			screen.queryByRole("button", { name: "Moving WS" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Completed WS" }),
		).not.toBeInTheDocument();
	});

	it("auto-expands a collapsed group when a new workspace is selected in it", async () => {
		const user = userEvent.setup();
		const groups: WorkspaceGroup[] = [
			{
				id: "done",
				label: "Done",
				tone: "done",
				rows: [{ ...workspaceRow, id: "ws-completed", title: "Completed WS" }],
			},
			{
				id: "progress",
				label: "In Progress",
				tone: "progress",
				rows: [workspaceRow],
			},
		];

		const { rerender } = render(
			<TestProviders>
				<WorkspacesSidebar
					groups={groups}
					archivedRows={[]}
					selectedWorkspaceId="workspace-1"
				/>
			</TestProviders>,
		);

		// Collapse "Done"
		await user.click(screen.getByRole("button", { name: /^Done/ }));
		expect(
			screen.queryByRole("button", { name: "Completed WS" }),
		).not.toBeInTheDocument();

		// Select a workspace inside the collapsed "Done" group
		rerender(
			<TestProviders>
				<WorkspacesSidebar
					groups={groups}
					archivedRows={[]}
					selectedWorkspaceId="ws-completed"
				/>
			</TestProviders>,
		);

		// Group should expand because selectedWorkspaceId changed
		expect(
			screen.getByRole("button", { name: "Completed WS" }),
		).toBeInTheDocument();
	});

	it("shows workspace hover actions without an opacity transition", () => {
		render(
			<TestProviders>
				<WorkspacesSidebar
					groups={workspaceGroups}
					archivedRows={[]}
					onArchiveWorkspace={vi.fn()}
				/>
			</TestProviders>,
		);

		const actionButton = screen.getByRole("button", {
			name: "Archive workspace",
		});
		const actionOverlay = actionButton.parentElement?.parentElement;

		expect(actionOverlay).not.toBeNull();
		expect(actionOverlay).not.toHaveClass("transition-opacity");
	});

	describe("view mode", () => {
		const openViewModeMenu = async (
			user: ReturnType<typeof userEvent.setup>,
		) => {
			await user.click(
				screen.getByRole("button", { name: "Change sidebar grouping" }),
			);
		};

		it("defaults to status mode and switches to repository mode on toggle", async () => {
			const user = userEvent.setup();
			render(
				<TestProviders>
					<WorkspacesSidebar
						groups={workspaceGroups}
						repositoryGroups={[
							{
								id: "repo-a",
								name: "alpha",
								repoIconSrc: null,
								repoInitials: "AL",
								rows: [
									{
										id: "workspace-1",
										title: "Workspace 1",
										state: "ready",
										repoId: "repo-a",
									},
								],
							},
							{
								id: "repo-b",
								name: "bravo",
								repoIconSrc: null,
								repoInitials: "BR",
								rows: [],
							},
						]}
						archivedRows={[]}
					/>
				</TestProviders>,
			);

			expect(
				screen.getByRole("button", { name: "Change sidebar grouping" }),
			).toHaveTextContent("Status");
			expect(screen.getByText("In Progress")).toBeInTheDocument();
			expect(screen.queryByText("alpha")).toBeNull();

			await openViewModeMenu(user);
			await user.click(
				screen.getByRole("menuitemradio", { name: /Workspaces/ }),
			);

			expect(screen.getByText("alpha")).toBeInTheDocument();
			expect(screen.getByText("bravo")).toBeInTheDocument();
			expect(screen.getByText("Empty")).toBeInTheDocument();
			expect(
				screen.getByRole("button", { name: "Change sidebar grouping" }),
			).toHaveTextContent("Workspaces");
		});

		it("collapses a repository when its header is clicked", async () => {
			const user = userEvent.setup();
			render(
				<TestProviders>
					<WorkspacesSidebar
						groups={[]}
						repositoryGroups={[
							{
								id: "repo-a",
								name: "alpha",
								repoIconSrc: null,
								repoInitials: "AL",
								rows: [
									{
										id: "workspace-1",
										title: "Workspace 1",
										state: "ready",
										repoId: "repo-a",
									},
								],
							},
						]}
						archivedRows={[]}
					/>
				</TestProviders>,
			);

			await openViewModeMenu(user);
			await user.click(
				screen.getByRole("menuitemradio", { name: /Workspaces/ }),
			);

			expect(
				screen.getByRole("button", { name: "Workspace 1" }),
			).toBeInTheDocument();

			const repoHeader = screen
				.getAllByRole("button")
				.find((btn) => btn.getAttribute("data-repo-id") === "repo-a");
			expect(repoHeader).toBeDefined();
			await user.click(repoHeader!);

			expect(screen.queryByRole("button", { name: "Workspace 1" })).toBeNull();
		});
	});
});
