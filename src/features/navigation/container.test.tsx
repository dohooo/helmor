import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
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
	const originalRequestAnimationFrame = window.requestAnimationFrame;
	const originalCancelAnimationFrame = window.cancelAnimationFrame;

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
		vi.useRealTimers();
		vi.clearAllMocks();
		Object.defineProperty(window, "requestAnimationFrame", {
			configurable: true,
			value: originalRequestAnimationFrame,
		});
		Object.defineProperty(window, "cancelAnimationFrame", {
			configurable: true,
			value: originalCancelAnimationFrame,
		});
	});

	it("defers external workspace selection until after the next frame", () => {
		vi.useFakeTimers();
		const onSelectWorkspace = vi.fn();
		const frameCallbacks = new Map<number, FrameRequestCallback>();
		let nextFrameId = 1;

		Object.defineProperty(window, "requestAnimationFrame", {
			configurable: true,
			value: vi.fn((callback: FrameRequestCallback) => {
				const id = nextFrameId;
				nextFrameId += 1;
				frameCallbacks.set(id, callback);
				return id;
			}),
		});
		Object.defineProperty(window, "cancelAnimationFrame", {
			configurable: true,
			value: vi.fn((id: number) => {
				frameCallbacks.delete(id);
			}),
		});

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

		expect(onSelectWorkspace).not.toHaveBeenCalled();
		expect(frameCallbacks.size).toBe(1);

		act(() => {
			for (const [id, callback] of frameCallbacks) {
				frameCallbacks.delete(id);
				callback(performance.now());
			}
		});

		expect(onSelectWorkspace).not.toHaveBeenCalled();

		act(() => {
			vi.runOnlyPendingTimers();
		});

		expect(onSelectWorkspace).toHaveBeenCalledTimes(1);
		expect(onSelectWorkspace).toHaveBeenCalledWith("workspace-2");
	});
});
