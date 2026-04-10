import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	RepositoryCreateOption,
	WorkspaceGroup,
	WorkspaceRow,
} from "@/lib/api";
import { TooltipProvider } from "./ui/tooltip";
import { WorkspacesSidebar } from "./workspaces-sidebar";

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

const repositories: RepositoryCreateOption[] = [
	{
		id: "repo-1",
		name: "helmor",
		defaultBranch: "main",
		repoInitials: "HE",
	},
	{
		id: "repo-2",
		name: "dosu-cli",
		defaultBranch: "develop",
		repoInitials: "DO",
	},
];

afterEach(() => {
	cleanup();
	window.localStorage.clear();
});

describe("WorkspacesSidebar", () => {
	it("updates the row icon immediately when a workspace enters sending state", () => {
		const { rerender } = render(
			<TooltipProvider delayDuration={0}>
				<WorkspacesSidebar
					groups={workspaceGroups}
					archivedRows={[]}
					selectedWorkspaceId="workspace-1"
					sendingWorkspaceIds={new Set()}
				/>
			</TooltipProvider>,
		);

		const initialRow = screen.getByRole("button", { name: "Workspace 1" });
		expect(initialRow.querySelector(".animate-spin")).toBeNull();

		rerender(
			<TooltipProvider delayDuration={0}>
				<WorkspacesSidebar
					groups={workspaceGroups}
					archivedRows={[]}
					selectedWorkspaceId="workspace-1"
					sendingWorkspaceIds={new Set(["workspace-1"])}
				/>
			</TooltipProvider>,
		);

		const updatedRow = screen.getByRole("button", { name: "Workspace 1" });
		expect(updatedRow.querySelector(".animate-spin")).not.toBeNull();
	});

	it("opens the repository picker and creates a workspace from the selected repository", async () => {
		const user = userEvent.setup();
		const onCreateWorkspace = vi.fn();

		const { container } = render(
			<TooltipProvider delayDuration={0}>
				<WorkspacesSidebar
					groups={workspaceGroups}
					archivedRows={[]}
					availableRepositories={repositories}
					onCreateWorkspace={onCreateWorkspace}
				/>
			</TooltipProvider>,
		);

		const [newWorkspaceButton] = within(container).getAllByRole("button", {
			name: "New workspace",
		});
		await user.click(newWorkspaceButton);

		expect(screen.queryByPlaceholderText("Search repositories")).toBeNull();
		expect(screen.queryByText("Repositories")).toBeNull();
		expect(screen.getByRole("option", { name: /helmor/i })).toBeInTheDocument();

		const [firstRepositoryOption] = screen.getAllByRole("option");
		await user.click(firstRepositoryOption);

		expect(onCreateWorkspace).toHaveBeenCalledWith("repo-1");
		expect(screen.queryByRole("option", { name: /helmor/i })).toBeNull();
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
});
