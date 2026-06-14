import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { WorkspaceGroup, WorkspaceRow } from "@/lib/api";
import { WorkspacesSidebarContainer } from "./container";

const useControllerMock = vi.hoisted(() => vi.fn());

vi.mock("./hooks/use-controller", () => ({
	useWorkspacesSidebarController: useControllerMock,
}));

type ControllerArgs = {
	onSelectWorkspace: (workspaceId: string | null) => void;
};

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

describe("WorkspacesSidebarContainer", () => {
	beforeEach(() => {
		useControllerMock.mockImplementation((args: ControllerArgs) => ({
			addingRepository: false,
			archivingWorkspaceIds: new Set<string>(),
			archivedRows: [],
			availableRepositories: [],
			creatingWorkspaceRepoId: null,
			cloneDefaultDirectory: null,
			groups: workspaceGroups,
			sidebarGrouping: "status",
			sidebarRepoFilterIds: [],
			sidebarSort: "custom",
			updateSettings: vi.fn(async () => {}),
			handleAddRepository: vi.fn(async () => {}),
			handleArchiveWorkspace: vi.fn(),
			handleCloneFromUrl: vi.fn(async () => {}),
			handleDeleteWorkspace: vi.fn(),
			handleMarkWorkspaceUnread: vi.fn(),
			handleMoveRepositoryInSidebar: vi.fn(),
			handleMoveWorkspaceInSidebar: vi.fn(),
			handleOpenCloneDialog: vi.fn(),
			handleRestoreWorkspace: vi.fn(),
			handleSelectWorkspace: (workspaceId: string) => {
				args.onSelectWorkspace(workspaceId);
			},
			handleSetWorkspaceStatus: vi.fn(),
			handleTogglePin: vi.fn(),
			isCloneDialogOpen: false,
			prefetchWorkspace: vi.fn(),
			setIsCloneDialogOpen: vi.fn(),
		}));
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	// Stage A: the rAF+setTimeout deferral moved into the selection controller's
	// `scheduleDisplayFlip` (one mechanism for mouse + keyboard). The container
	// must forward the click synchronously so the router/highlight commit stays
	// inside the input task.
	it("forwards workspace selection synchronously on click", () => {
		const onSelectWorkspace = vi.fn();

		render(
			<TooltipProvider delayDuration={0}>
				<WorkspacesSidebarContainer
					selectedWorkspaceId="workspace-1"
					onSelectWorkspace={onSelectWorkspace}
					pushWorkspaceToast={vi.fn()}
				/>
			</TooltipProvider>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Workspace 2" }));

		expect(onSelectWorkspace).toHaveBeenCalledTimes(1);
		expect(onSelectWorkspace).toHaveBeenCalledWith("workspace-2");
	});
});
