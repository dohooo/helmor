import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { WorkspaceGroup, WorkspaceRow } from "@/lib/api";

import {
	repoOrderFromGroups,
	resolveWorkspaceDropBeforeId,
	WorkspacesSidebar,
} from "./index";

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

const repositoryOptions = [
	{ id: "repo-alpha", name: "Alpha" },
	{ id: "repo-beta", name: "Beta" },
	{ id: "repo-gamma", name: "Gamma" },
];

const repoWorkspaceGroups: WorkspaceGroup[] = [
	{
		id: "progress",
		label: "In Progress",
		tone: "progress",
		rows: [
			{
				...workspaceRow,
				id: "ws-beta",
				title: "Beta workspace",
				repoId: "repo-beta",
				repoName: "Beta",
				createdAt: "2024-01-01T00:00:00Z",
				updatedAt: "2024-01-03T00:00:00Z",
			},
			{
				...workspaceRow,
				id: "ws-alpha",
				title: "Alpha workspace",
				repoId: "repo-alpha",
				repoName: "Alpha",
				createdAt: "2024-01-02T00:00:00Z",
				updatedAt: "2024-01-02T00:00:00Z",
			},
			{
				...workspaceRow,
				id: "ws-gamma",
				title: "Gamma workspace",
				repoId: "repo-gamma",
				repoName: "Gamma",
				createdAt: "2024-01-03T00:00:00Z",
				updatedAt: "2024-01-01T00:00:00Z",
			},
		],
	},
];

afterEach(() => {
	cleanup();
	window.localStorage.clear();
});

describe("WorkspacesSidebar", () => {
	it("shows the Helmor thinking indicator when a workspace enters sending state", () => {
		const { rerender } = render(
			<TooltipProvider delayDuration={0}>
				<WorkspacesSidebar
					groups={workspaceGroups}
					archivedRows={[]}
					selectedWorkspaceId="workspace-1"
					busyWorkspaceIds={new Set()}
				/>
			</TooltipProvider>,
		);

		const initialRow = screen.getByRole("button", { name: "Workspace 1" });
		expect(
			initialRow.querySelector('[data-slot="helmor-thinking-indicator"]'),
		).toBeNull();

		rerender(
			<TooltipProvider delayDuration={0}>
				<WorkspacesSidebar
					groups={workspaceGroups}
					archivedRows={[]}
					selectedWorkspaceId="workspace-1"
					busyWorkspaceIds={new Set(["workspace-1"])}
				/>
			</TooltipProvider>,
		);

		const updatedRow = screen.getByRole("button", { name: "Workspace 1" });
		expect(
			updatedRow.querySelector('[data-slot="helmor-thinking-indicator"]'),
		).not.toBeNull();
	});

	it("keeps the unread dot visible for the selected workspace", () => {
		render(
			<TooltipProvider delayDuration={0}>
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
			</TooltipProvider>,
		);

		expect(screen.getByLabelText("Unread")).toBeInTheDocument();
	});

	it("opens the workspace start page from the new workspace button", async () => {
		const user = userEvent.setup();
		const onOpenNewWorkspace = vi.fn();

		const { container } = render(
			<TooltipProvider delayDuration={0}>
				<WorkspacesSidebar
					groups={workspaceGroups}
					archivedRows={[]}
					onOpenNewWorkspace={onOpenNewWorkspace}
				/>
			</TooltipProvider>,
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

	it("opens sidebar filter controls and selects multiple repositories", async () => {
		const user = userEvent.setup();
		function ControlledSidebar() {
			const [repoFilterIds, setRepoFilterIds] = useState<string[]>([]);
			const groups =
				repoFilterIds.length === 0
					? repoWorkspaceGroups
					: [
							{
								...repoWorkspaceGroups[0]!,
								rows: repoWorkspaceGroups[0]!.rows.filter((row) =>
									repoFilterIds.includes(row.repoId ?? ""),
								),
							},
						];
			return (
				<WorkspacesSidebar
					groups={groups}
					archivedRows={[]}
					availableRepositories={repositoryOptions}
					sidebarRepoFilterIds={repoFilterIds}
					onSidebarRepoFilterChange={setRepoFilterIds}
				/>
			);
		}

		render(
			<TooltipProvider delayDuration={0}>
				<ControlledSidebar />
			</TooltipProvider>,
		);

		await user.click(
			screen.getByRole("button", { name: "Filter and sort sidebar" }),
		);
		await user.click(screen.getByRole("button", { name: "All repositories" }));
		await user.click(screen.getByText("Alpha"));
		await user.click(screen.getByText("Gamma"));

		expect(
			screen.getByRole("button", { name: "Alpha workspace" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Gamma workspace" }),
		).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Beta workspace" })).toBeNull();
	});

	it("opens sidebar filter controls from the app shortcut event", () => {
		render(
			<TooltipProvider delayDuration={0}>
				<WorkspacesSidebar
					groups={repoWorkspaceGroups}
					archivedRows={[]}
					availableRepositories={repositoryOptions}
					sidebarFilterShortcut="Mod+Shift+F"
				/>
			</TooltipProvider>,
		);

		fireEvent(window, new CustomEvent("helmor:open-sidebar-filter"));

		expect(screen.getByText("Group by")).toBeInTheDocument();
		expect(screen.getByText("Sort by")).toBeInTheDocument();
	});

	it("changes sidebar grouping from the filter popover", async () => {
		const user = userEvent.setup();
		const onSidebarGroupingChange = vi.fn();

		render(
			<TooltipProvider delayDuration={0}>
				<WorkspacesSidebar
					groups={repoWorkspaceGroups}
					archivedRows={[]}
					availableRepositories={repositoryOptions}
					sidebarGrouping="status"
					onSidebarGroupingChange={onSidebarGroupingChange}
				/>
			</TooltipProvider>,
		);

		await user.click(
			screen.getByRole("button", { name: "Filter and sort sidebar" }),
		);
		await user.click(screen.getByRole("radio", { name: "Repository" }));

		expect(onSidebarGroupingChange).toHaveBeenCalledWith("repo");
	});

	it("renders an active sidebar filter and clears it", async () => {
		const user = userEvent.setup();
		const onSidebarRepoFilterChange = vi.fn();

		render(
			<TooltipProvider delayDuration={0}>
				<WorkspacesSidebar
					groups={[
						{
							...repoWorkspaceGroups[0],
							rows: repoWorkspaceGroups[0]!.rows.filter(
								(row) => row.repoId === "repo-alpha",
							),
						},
					]}
					archivedRows={[]}
					availableRepositories={repositoryOptions}
					sidebarRepoFilterIds={["repo-alpha"]}
					onSidebarRepoFilterChange={onSidebarRepoFilterChange}
				/>
			</TooltipProvider>,
		);

		expect(
			screen.getByRole("button", { name: "Alpha workspace" }),
		).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Beta workspace" })).toBeNull();

		await user.click(
			screen.getByRole("button", { name: "Filter and sort sidebar" }),
		);
		await user.click(screen.getByRole("button", { name: "Alpha" }));
		await user.click(screen.getByText("All repositories"));

		expect(onSidebarRepoFilterChange).toHaveBeenCalledWith([]);
	});

	it("changes sidebar sort and switches to custom when repo reorder finishes", async () => {
		const user = userEvent.setup();
		const onSidebarSortChange = vi.fn();
		const onMoveRepositoryInSidebar = vi.fn();

		const { container } = render(
			<TooltipProvider delayDuration={0}>
				<WorkspacesSidebar
					groups={[
						{
							id: "repo:repo-beta",
							label: "Beta",
							tone: "pinned",
							rows: [repoWorkspaceGroups[0]!.rows[0]!],
						},
						{
							id: "repo:repo-alpha",
							label: "Alpha",
							tone: "pinned",
							rows: [repoWorkspaceGroups[0]!.rows[1]!],
						},
					]}
					archivedRows={[]}
					availableRepositories={repositoryOptions}
					sidebarGrouping="repo"
					sidebarSort="updatedAt"
					onSidebarSortChange={onSidebarSortChange}
					onMoveRepositoryInSidebar={onMoveRepositoryInSidebar}
				/>
			</TooltipProvider>,
		);

		await user.click(
			screen.getByRole("button", { name: "Filter and sort sidebar" }),
		);
		await user.click(screen.getByRole("radio", { name: "Repository name" }));

		expect(onSidebarSortChange).toHaveBeenCalledWith("repoName");
		onSidebarSortChange.mockClear();
		const repoHandle = container.querySelector("[data-repo-dnd-handle='true']");
		expect(repoHandle).toBeInTheDocument();

		fireEvent.pointerDown(repoHandle!, {
			button: 0,
			clientX: 10,
			clientY: 10,
			pointerId: 1,
		});

		expect(onSidebarSortChange).not.toHaveBeenCalledWith("custom");

		fireEvent.pointerMove(window, {
			clientX: 10,
			clientY: 30,
			pointerId: 1,
		});
		fireEvent.pointerUp(window, {
			clientX: 10,
			clientY: 30,
			pointerId: 1,
		});

		expect(onSidebarSortChange).toHaveBeenCalledWith("custom");
		expect(onMoveRepositoryInSidebar).toHaveBeenCalledWith("repo-beta", null, [
			"repo-alpha",
			"repo-gamma",
			"repo-beta",
		]);
	});

	it("shows an Open in Finder action for active workspaces", async () => {
		const user = userEvent.setup();
		const onOpenInFinder = vi.fn();

		render(
			<TooltipProvider delayDuration={0}>
				<WorkspacesSidebar
					groups={workspaceGroups}
					archivedRows={[]}
					onOpenInFinder={onOpenInFinder}
				/>
			</TooltipProvider>,
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
			<TooltipProvider delayDuration={0}>
				<WorkspacesSidebar
					groups={workspaceGroups}
					archivedRows={[archivedRow]}
					selectedWorkspaceId={null}
				/>
			</TooltipProvider>,
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
			<TooltipProvider delayDuration={0}>
				<WorkspacesSidebar groups={emptyGroups} archivedRows={[]} />
			</TooltipProvider>,
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
			<TooltipProvider delayDuration={0}>
				<WorkspacesSidebar
					groups={groups}
					archivedRows={[]}
					onArchiveWorkspace={onArchiveWorkspace}
					archivingWorkspaceIds={new Set(["workspace-1"])}
				/>
			</TooltipProvider>,
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
			<TooltipProvider delayDuration={0}>
				<WorkspacesSidebar
					groups={workspaceGroups}
					archivedRows={[]}
					onArchiveWorkspace={onArchiveWorkspace}
					creatingWorkspaceRepoId="repo-1"
				/>
			</TooltipProvider>,
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
			<TooltipProvider delayDuration={0}>
				<WorkspacesSidebar
					groups={collapsedGroups}
					archivedRows={[]}
					selectedWorkspaceId={null}
				/>
			</TooltipProvider>,
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
			<TooltipProvider delayDuration={0}>
				<WorkspacesSidebar
					groups={collapsedGroups}
					archivedRows={[]}
					selectedWorkspaceId={null}
				/>
			</TooltipProvider>,
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
			<TooltipProvider delayDuration={0}>
				<WorkspacesSidebar
					groups={groups}
					archivedRows={[]}
					selectedWorkspaceId="workspace-1"
					interactionRequiredWorkspaceIds={
						new Set(["workspace-1", "workspace-2"])
					}
				/>
			</TooltipProvider>,
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
			<TooltipProvider delayDuration={0}>
				<WorkspacesSidebar
					groups={groups}
					archivedRows={[]}
					selectedWorkspaceId="workspace-1"
				/>
			</TooltipProvider>,
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
			<TooltipProvider delayDuration={0}>
				<WorkspacesSidebar
					groups={[...groups.map((g) => ({ ...g, rows: [...g.rows] }))]}
					archivedRows={[]}
					selectedWorkspaceId="workspace-1"
				/>
			</TooltipProvider>,
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
			<TooltipProvider delayDuration={0}>
				<WorkspacesSidebar
					groups={initialGroups}
					archivedRows={[]}
					selectedWorkspaceId="ws-move"
				/>
			</TooltipProvider>,
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
			<TooltipProvider delayDuration={0}>
				<WorkspacesSidebar
					groups={afterMoveGroups}
					archivedRows={[]}
					selectedWorkspaceId="ws-move"
				/>
			</TooltipProvider>,
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
			<TooltipProvider delayDuration={0}>
				<WorkspacesSidebar
					groups={groups}
					archivedRows={[]}
					selectedWorkspaceId="workspace-1"
				/>
			</TooltipProvider>,
		);

		// Collapse "Done"
		await user.click(screen.getByRole("button", { name: /^Done/ }));
		expect(
			screen.queryByRole("button", { name: "Completed WS" }),
		).not.toBeInTheDocument();

		// Select a workspace inside the collapsed "Done" group
		rerender(
			<TooltipProvider delayDuration={0}>
				<WorkspacesSidebar
					groups={groups}
					archivedRows={[]}
					selectedWorkspaceId="ws-completed"
				/>
			</TooltipProvider>,
		);

		// Group should expand because selectedWorkspaceId changed
		expect(
			screen.getByRole("button", { name: "Completed WS" }),
		).toBeInTheDocument();
	});

	it("shows workspace hover actions without an opacity transition", () => {
		render(
			<TooltipProvider delayDuration={0}>
				<WorkspacesSidebar
					groups={workspaceGroups}
					archivedRows={[]}
					onArchiveWorkspace={vi.fn()}
				/>
			</TooltipProvider>,
		);

		const actionButton = screen.getByRole("button", {
			name: "Archive workspace",
		});
		const actionOverlay = actionButton.parentElement?.parentElement;

		expect(actionOverlay).not.toBeNull();
		expect(actionOverlay).not.toHaveClass("transition-opacity");
	});

	describe("repo grouping mode", () => {
		const repoGroups: WorkspaceGroup[] = [
			{
				id: "repo:repo-1",
				label: "helmor",
				tone: "pinned",
				rows: [
					{
						...workspaceRow,
						id: "ws-1",
						repoId: "repo-1",
						repoName: "helmor",
					},
				],
			},
		];

		it("renders a `+` button on a repo group header that fires onCreateWorkspaceForRepo with the repo id", async () => {
			const user = userEvent.setup();
			const onCreateWorkspaceForRepo = vi.fn();

			render(
				<TooltipProvider delayDuration={0}>
					<WorkspacesSidebar
						groups={repoGroups}
						archivedRows={[]}
						sidebarGrouping="repo"
						onCreateWorkspaceForRepo={onCreateWorkspaceForRepo}
					/>
				</TooltipProvider>,
			);

			const addButton = screen.getByRole("button", {
				name: "New workspace in helmor",
			});
			await user.click(addButton);

			expect(onCreateWorkspaceForRepo).toHaveBeenCalledTimes(1);
			expect(onCreateWorkspaceForRepo).toHaveBeenCalledWith("repo-1");
		});

		it("doesn't expose row count badge / chevron for repo groups", () => {
			render(
				<TooltipProvider delayDuration={0}>
					<WorkspacesSidebar
						groups={repoGroups}
						archivedRows={[]}
						sidebarGrouping="repo"
						onCreateWorkspaceForRepo={vi.fn()}
					/>
				</TooltipProvider>,
			);

			// Repo header is a div role="button" (not a <button>) so the
			// `+` button can nest inside it. The header itself shouldn't
			// surface the rows.length badge.
			const header = screen
				.getAllByRole("button", { name: /helmor/i })
				.find((el) => el.tagName === "DIV");
			expect(header).toBeDefined();
			// Row count badge is `1` for this group — assert it's NOT
			// inside the header.
			expect(header?.textContent).not.toMatch(/\b1\b/);
		});

		it("clicking the `+` button doesn't bubble up and toggle the section", async () => {
			const user = userEvent.setup();
			const onCreateWorkspaceForRepo = vi.fn();

			render(
				<TooltipProvider delayDuration={0}>
					<WorkspacesSidebar
						groups={repoGroups}
						archivedRows={[]}
						sidebarGrouping="repo"
						onCreateWorkspaceForRepo={onCreateWorkspaceForRepo}
					/>
				</TooltipProvider>,
			);

			// Row visible BEFORE click.
			expect(screen.getByLabelText("Workspace 1")).toBeInTheDocument();

			await user.click(
				screen.getByRole("button", { name: "New workspace in helmor" }),
			);

			// Row STILL visible — click on `+` did not toggle the section
			// closed (stopPropagation guard works).
			expect(screen.getByLabelText("Workspace 1")).toBeInTheDocument();
			expect(onCreateWorkspaceForRepo).toHaveBeenCalledTimes(1);
		});

		it("clicking the repo header (off the `+` button) toggles the section", async () => {
			const user = userEvent.setup();

			render(
				<TooltipProvider delayDuration={0}>
					<WorkspacesSidebar
						groups={repoGroups}
						archivedRows={[]}
						sidebarGrouping="repo"
						onCreateWorkspaceForRepo={vi.fn()}
					/>
				</TooltipProvider>,
			);

			expect(screen.getByLabelText("Workspace 1")).toBeInTheDocument();

			const header = screen
				.getAllByRole("button", { name: /helmor/i })
				.find((el) => el.tagName === "DIV");
			expect(header).toBeDefined();
			await user.click(header as HTMLElement);

			// Row hidden after toggle (collapsed).
			expect(screen.queryByLabelText("Workspace 1")).toBeNull();
		});
	});
});

describe("repoOrderFromGroups", () => {
	it("preserves filtered-out and empty repository positions", () => {
		expect(
			repoOrderFromGroups(
				[
					{ id: "repo:repo-c", label: "C", tone: "pinned", rows: [] },
					{ id: "repo:repo-d", label: "D", tone: "pinned", rows: [] },
				],
				[
					{ id: "repo-a", name: "A" },
					{ id: "repo-b", name: "B" },
					{ id: "repo-c", name: "C" },
					{ id: "repo-d", name: "D" },
					{ id: "repo-empty", name: "Empty" },
				],
			),
		).toEqual(["repo-a", "repo-b", "repo-c", "repo-d", "repo-empty"]);
	});

	it("seeds a full repo order from the visible sorted order", () => {
		expect(
			repoOrderFromGroups(
				[
					{ id: "repo:repo-a", label: "A", tone: "pinned", rows: [] },
					{ id: "repo:repo-b", label: "B", tone: "pinned", rows: [] },
					{ id: "repo:repo-c", label: "C", tone: "pinned", rows: [] },
				],
				[
					{ id: "repo-c", name: "C" },
					{ id: "repo-a", name: "A" },
					{ id: "repo-b", name: "B" },
				],
			),
		).toEqual(["repo-a", "repo-b", "repo-c"]);
	});
});

describe("resolveWorkspaceDropBeforeId", () => {
	it("keeps a filtered drop after the last visible row before following hidden rows", () => {
		const fullGroups: WorkspaceGroup[] = [
			{
				id: "progress",
				label: "In progress",
				tone: "progress",
				rows: [
					{ ...workspaceRow, id: "ws-a", title: "A", repoId: "repo-1" },
					{ ...workspaceRow, id: "ws-c", title: "C", repoId: "repo-1" },
					{ ...workspaceRow, id: "ws-b", title: "B", repoId: "repo-2" },
				],
			},
		];
		const filteredGroups: WorkspaceGroup[] = [
			{
				...fullGroups[0]!,
				rows: fullGroups[0]!.rows.filter((row) => row.repoId === "repo-1"),
			},
		];

		expect(
			resolveWorkspaceDropBeforeId({
				groups: filteredGroups,
				unfilteredGroups: fullGroups,
				workspaceId: "ws-a",
				targetGroupId: "progress",
				beforeWorkspaceId: null,
			}),
		).toBe("ws-b");
	});

	it("drops before the first hidden row when a filtered target has no visible rows", () => {
		const fullGroups: WorkspaceGroup[] = [
			{
				id: "review",
				label: "In review",
				tone: "review",
				rows: [{ ...workspaceRow, id: "ws-hidden", repoId: "repo-2" }],
			},
		];

		expect(
			resolveWorkspaceDropBeforeId({
				groups: [{ ...fullGroups[0]!, rows: [] }],
				unfilteredGroups: fullGroups,
				workspaceId: "ws-a",
				targetGroupId: "review",
				beforeWorkspaceId: null,
			}),
		).toBe("ws-hidden");
	});

	it("resolves filtered drops against the supplied sorted full order", () => {
		const filteredGroups: WorkspaceGroup[] = [
			{
				id: "progress",
				label: "In progress",
				tone: "progress",
				rows: [
					{ ...workspaceRow, id: "ws-a", title: "A", repoId: "repo-1" },
					{ ...workspaceRow, id: "ws-c", title: "C", repoId: "repo-1" },
				],
			},
		];
		const sortedFullGroups: WorkspaceGroup[] = [
			{
				...filteredGroups[0]!,
				rows: [
					{ ...workspaceRow, id: "ws-a", title: "A", repoId: "repo-1" },
					{ ...workspaceRow, id: "ws-b", title: "B", repoId: "repo-2" },
					{ ...workspaceRow, id: "ws-c", title: "C", repoId: "repo-1" },
				],
			},
		];

		expect(
			resolveWorkspaceDropBeforeId({
				groups: filteredGroups,
				unfilteredGroups: sortedFullGroups,
				workspaceId: "ws-a",
				targetGroupId: "progress",
				beforeWorkspaceId: null,
			}),
		).toBeNull();
	});
});
