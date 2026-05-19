import { invoke } from "@tauri-apps/api/core";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { WorkspacesSidebar } from "./features/navigation";
import { WorkspacePanel } from "./features/panel";
import type { WorkspaceGroup } from "./lib/api";
import { renderWithProviders } from "./test/render-with-providers";

vi.mock("./App.css", () => ({}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
	open: vi.fn(),
}));

const SIDEBAR_WIDTH_STORAGE_KEY = "helmor.workspaceSidebarWidth";
const INSPECTOR_WIDTH_STORAGE_KEY = "helmor.workspaceInspectorWidth";
const SIDEBAR_WIDTH_VAR = "--shell-sidebar-width";
const INSPECTOR_WIDTH_VAR = "--shell-inspector-width";

function getShellWidthVar(name: string): string {
	return document.documentElement.style.getPropertyValue(name);
}

describe("App", () => {
	beforeEach(() => {
		window.localStorage.clear();
	});

	afterEach(() => {
		cleanup();
	});

	it("renders the sidebar shell with tooltips, avatars, archive actions, and collapsible groups", async () => {
		const { container } = render(<App />);

		// App boots with githubIdentityState = "checking" and flips to
		// "connected" on the next microtask via the mocked invoke. Wait for
		// the real shell before running sync queries.
		const shell = await screen.findByRole("main", {
			name: "Application shell",
		});
		const sidebar = screen.getByLabelText("Workspace sidebar");
		const inspector = screen.getByLabelText("Inspector sidebar");
		const panel = screen.getByLabelText("Workspace panel");
		const dragRegion = screen.getByLabelText("Workspace panel drag region");
		const viewport = screen.getByLabelText("Workspace viewport");
		const composer = screen.getByLabelText("Workspace composer");
		const input = screen.getByLabelText("Workspace input");
		const resizeHandle = screen.getByRole("separator", {
			name: "Resize sidebar",
		});
		const inspectorResizeHandle = screen.getByRole("separator", {
			name: "Resize inspector sidebar",
		});
		const doneGroup = screen.getByRole("button", { name: "Done" });
		const progressGroup = screen.getByRole("button", {
			name: /^In progress/,
		});
		const addRepositoryButton = screen.getByRole("button", {
			name: "Add repository",
		});
		const newWorkspaceButton = screen.getByRole("button", {
			name: "New workspace",
		});
		const safeAreas = container.querySelectorAll(
			'[data-slot="window-safe-top"]',
		);
		const groupsScrollRegion = container.querySelector(
			'[data-slot="workspace-groups-scroll"]',
		);

		expect(shell).toHaveClass("bg-background");
		expect(shell).toHaveClass("h-screen");
		expect(shell).toHaveClass("overflow-hidden");
		expect(sidebar).toHaveClass("bg-sidebar");
		expect(sidebar).toHaveClass("overflow-hidden");
		expect(inspector).toHaveClass("bg-inspector");
		expect(inspector).toHaveClass("overflow-hidden");
		// Width driven by CSS var — assert on the documentElement var, not inline style.
		expect(getShellWidthVar(SIDEBAR_WIDTH_VAR)).toBe("336px");
		expect(getShellWidthVar(INSPECTOR_WIDTH_VAR)).toBe("336px");
		expect(screen.getByLabelText("Inspector section Git")).toBeInTheDocument();
		expect(
			screen.getByLabelText("Inspector section Actions"),
		).toBeInTheDocument();
		expect(screen.getByLabelText("Inspector section Tabs")).toBeInTheDocument();
		expect(screen.getByLabelText("Changes panel body")).toBeInTheDocument();
		expect(screen.getByLabelText("Actions panel body")).toBeInTheDocument();
		// Inspector tabs section starts collapsed; body only mounts when opened.
		expect(
			screen.queryByLabelText("Inspector tabs body"),
		).not.toBeInTheDocument();
		expect(screen.getByRole("tab", { name: "Setup" })).toBeInTheDocument();
		expect(screen.getByRole("tab", { name: "Run" })).toBeInTheDocument();
		expect(screen.getByRole("tab", { name: "Terminal" })).toBeInTheDocument();
		expect(panel).toHaveClass("relative");
		expect(panel).toHaveClass("bg-background");
		expect(dragRegion).toHaveAttribute("data-tauri-drag-region");
		expect(viewport).toHaveClass("bg-background");
		expect(composer).toBeInTheDocument();
		expect(input).toHaveAttribute("aria-multiline", "true");
		expect(
			screen.getByText("Ask to make changes, @mention files, run /commands"),
		).toBeInTheDocument();
		expect(resizeHandle).toHaveAttribute("aria-valuenow", "336");
		expect(inspectorResizeHandle).toHaveAttribute("aria-valuenow", "336");
		// Position driven by CSS var; inline style is expressed as calc(var(...) - X).
		expect(inspectorResizeHandle).toHaveStyle({ width: "20px" });
		expect(inspectorResizeHandle.style.right).toBe(
			`calc(var(--shell-inspector-width, 336px) - 20px)`,
		);
		expect(safeAreas).toHaveLength(1);
		expect(groupsScrollRegion).toHaveClass("overflow-y-auto");
		expect(groupsScrollRegion).toHaveClass("flex-1");
		expect(screen.getByText("Workspaces")).toBeInTheDocument();
		expect(doneGroup).toBeInTheDocument();
		expect(progressGroup).toBeInTheDocument();

		expect(addRepositoryButton).toBeInTheDocument();
		expect(newWorkspaceButton).toBeInTheDocument();
	});

	it("toggles the inspector tabs section while leaving the first two panels expanded", async () => {
		const user = userEvent.setup();
		render(<App />);
		await screen.findByRole("main", { name: "Application shell" });
		const tabsToggle = screen.getByLabelText("Toggle inspector tabs section");
		const tabsChevron = tabsToggle.querySelector("svg");
		const actionsChevron = screen
			.getByLabelText("Toggle inspector actions section")
			.querySelector("svg");

		expect(tabsChevron).toHaveStyle({
			transition: "none",
		});
		expect(actionsChevron).toHaveStyle({
			transition: "none",
		});

		// Default: tabs section collapsed; changes + actions bodies present.
		expect(screen.getByLabelText("Changes panel body")).toBeInTheDocument();
		expect(screen.getByLabelText("Actions panel body")).toBeInTheDocument();
		expect(
			screen.queryByLabelText("Inspector tabs body"),
		).not.toBeInTheDocument();

		// Clicking the toggle expands the tabs body.
		await user.click(tabsToggle);

		expect(screen.getByLabelText("Changes panel body")).toBeInTheDocument();
		expect(screen.getByLabelText("Actions panel body")).toBeInTheDocument();
		expect(screen.getByLabelText("Inspector tabs body")).toBeInTheDocument();

		// Clicking again collapses it back.
		await user.click(tabsToggle);

		expect(screen.getByLabelText("Changes panel body")).toBeInTheDocument();
		expect(screen.getByLabelText("Actions panel body")).toBeInTheDocument();
		expect(
			screen.queryByLabelText("Inspector tabs body"),
		).not.toBeInTheDocument();
	});

	it("measures the inspector height before the first visible frame", async () => {
		const getBoundingClientRect = vi
			.spyOn(HTMLElement.prototype, "getBoundingClientRect")
			.mockReturnValue({
				x: 0,
				y: 0,
				width: 336,
				height: 900,
				top: 0,
				right: 336,
				bottom: 900,
				left: 0,
				toJSON: () => ({}),
			});

		try {
			render(<App />);
			await screen.findByRole("main", { name: "Application shell" });

			// Section heights are driven by CSS variables on the inspector
			// container so that mid-drag mousemove can update them without
			// going through React. Verify the container has the right vars
			// written via useLayoutEffect (synchronous, runs before first paint).
			await waitFor(() => {
				const container = screen.getByLabelText("Inspector section Git")
					.parentElement as HTMLElement;
				expect(
					container.style.getPropertyValue("--inspector-changes-body-height"),
				).toBe("240px");
			});
			const container = screen.getByLabelText("Inspector section Git")
				.parentElement as HTMLElement;
			expect(
				container.style.getPropertyValue("--inspector-actions-body-height"),
			).toBe("561px");
			expect(
				container.style.getPropertyValue("--inspector-tabs-body-height"),
			).toBe("0px");
			// Tabs wrapper is collapsed (tabsOpen=false default) so its height
			// is fixed at the section-header constant — not driven by the var.
			const tabsWrapper = screen.getByLabelText("Inspector section Tabs")
				.parentElement?.parentElement;
			expect(tabsWrapper).toHaveStyle({
				height: "33px",
			});
		} finally {
			getBoundingClientRect.mockRestore();
		}
	});

	it("resizes the sidebar and persists the width", async () => {
		render(<App />);
		await screen.findByRole("main", { name: "Application shell" });

		const resizeHandle = screen.getByRole("separator", {
			name: "Resize sidebar",
		});

		fireEvent.mouseDown(resizeHandle, { clientX: 336 });

		await waitFor(() => {
			expect(document.body.style.cursor).toBe("ew-resize");
		});

		fireEvent.mouseMove(window, { clientX: 360 });

		// During drag, width is driven via the CSS var (to avoid React renders),
		// so assert on the documentElement var rather than inline width.
		// Note: aria-valuenow doesn't update mid-drag (the separator doesn't
		// re-render) — it syncs on mouseup.
		await waitFor(() => {
			expect(getShellWidthVar(SIDEBAR_WIDTH_VAR)).toBe("360px");
		});

		fireEvent.mouseUp(window);

		await waitFor(() => {
			expect(document.body.style.cursor).toBe("");
			expect(resizeHandle).toHaveAttribute("aria-valuenow", "360");
		});

		expect(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe("360");
	});

	it("resizes the inspector sidebar and persists the width", async () => {
		render(<App />);
		await screen.findByRole("main", { name: "Application shell" });

		const resizeHandle = screen.getByRole("separator", {
			name: "Resize inspector sidebar",
		});

		fireEvent.mouseDown(resizeHandle, { clientX: 1200 });

		await waitFor(() => {
			expect(document.body.style.cursor).toBe("ew-resize");
		});

		fireEvent.mouseMove(window, { clientX: 1172 });

		await waitFor(() => {
			expect(getShellWidthVar(INSPECTOR_WIDTH_VAR)).toBe("364px");
		});

		fireEvent.mouseUp(window);

		await waitFor(() => {
			expect(document.body.style.cursor).toBe("");
			expect(resizeHandle).toHaveAttribute("aria-valuenow", "364");
		});

		expect(window.localStorage.getItem(INSPECTOR_WIDTH_STORAGE_KEY)).toBe(
			"364",
		);
	});

	it("restores the saved sidebar width from localStorage", async () => {
		window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, "404");
		window.localStorage.setItem(INSPECTOR_WIDTH_STORAGE_KEY, "388");

		render(<App />);
		await screen.findByRole("main", { name: "Application shell" });

		// Width is exposed via the CSS var; the React state sync writes it immediately after mount.
		await waitFor(() => {
			expect(getShellWidthVar(SIDEBAR_WIDTH_VAR)).toBe("404px");
			expect(getShellWidthVar(INSPECTOR_WIDTH_VAR)).toBe("388px");
		});
		expect(
			screen.getByRole("separator", { name: "Resize sidebar" }),
		).toHaveAttribute("aria-valuenow", "404");
		expect(
			screen.getByRole("separator", { name: "Resize inspector sidebar" }),
		).toHaveAttribute("aria-valuenow", "388");
	});

	it("shows the update button beside the sidebar toggle when an update is ready", async () => {
		const invokeMock = vi.mocked(invoke);
		const baseInvokeImpl = invokeMock.getMockImplementation();

		invokeMock.mockImplementation(
			async (command: string, ...args: unknown[]) => {
				if (command === "get_app_update_status") {
					return {
						stage: "downloaded",
						configured: true,
						autoUpdateEnabled: true,
						update: {
							currentVersion: "1.0.0",
							version: "1.1.0",
							releaseUrl: "https://example.com/release",
						},
						lastError: null,
						lastAttemptAt: null,
						downloadedAt: "2026-04-23T00:00:00Z",
					};
				}

				return baseInvokeImpl?.(command, args[0] as undefined);
			},
		);

		try {
			const user = userEvent.setup();
			render(<App />);
			await screen.findByRole("main", { name: "Application shell" });

			expect(
				await screen.findByRole("button", {
					name: "Update Helmor to 1.1.0",
				}),
			).toBeInTheDocument();

			await user.click(
				screen.getByRole("button", { name: "Collapse left sidebar" }),
			);

			expect(
				await screen.findByRole("button", {
					name: "Update Helmor to 1.1.0",
				}),
			).toBeInTheDocument();
		} finally {
			invokeMock.mockImplementation(baseInvokeImpl ?? (async () => undefined));
		}
	});

	it("falls back to repo-name initials when a workspace has no icon", () => {
		const groups: WorkspaceGroup[] = [
			{
				id: "progress",
				label: "In progress",
				tone: "progress",
				rows: [
					{
						id: "repo-avatar",
						title: "Investigate repo avatar fallback",
						repoName: "helmor-core",
					},
				],
			},
		];

		renderWithProviders(
			<WorkspacesSidebar groups={groups} archivedRows={[]} />,
		);

		const workspaceRow = screen.getByRole("button", {
			name: "Investigate repo avatar fallback",
		});
		const workspaceAvatar = workspaceRow.querySelector(
			'[data-slot="workspace-avatar"]',
		);
		expect(workspaceAvatar).toHaveAttribute("data-fallback", "HC");
	});

	it("calls restore for archived workspaces and shows restore errors", async () => {
		const user = userEvent.setup();
		const onRestoreWorkspace = vi.fn();

		renderWithProviders(
			<WorkspacesSidebar
				groups={[]}
				archivedRows={[
					{
						id: "archived-workspace",
						title: "Archived workspace",
						state: "archived",
						repoName: "helmor-core",
					},
				]}
				onRestoreWorkspace={onRestoreWorkspace}
			/>,
		);

		await user.click(screen.getByRole("button", { name: /^Archived/ }));
		await user.click(screen.getByRole("button", { name: "Restore workspace" }));

		expect(onRestoreWorkspace).toHaveBeenCalledWith("archived-workspace");
	});

	it("calls archive for ready workspaces", async () => {
		const user = userEvent.setup();
		const onArchiveWorkspace = vi.fn();

		renderWithProviders(
			<WorkspacesSidebar
				groups={[
					{
						id: "progress",
						label: "In progress",
						tone: "progress",
						rows: [
							{
								id: "ready-workspace",
								title: "Ready workspace",
								state: "ready",
								repoName: "helmor-core",
							},
						],
					},
				]}
				archivedRows={[]}
				onArchiveWorkspace={onArchiveWorkspace}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "Archive workspace" }));
		expect(onArchiveWorkspace).not.toHaveBeenCalled();

		await user.click(
			screen.getByRole("button", { name: "Confirm archive workspace" }),
		);

		expect(onArchiveWorkspace).toHaveBeenCalledWith("ready-workspace");
	});

	it("opens the workspace start page from the new workspace button", async () => {
		const user = userEvent.setup();
		const onOpenNewWorkspace = vi.fn();

		renderWithProviders(
			<WorkspacesSidebar
				groups={[]}
				archivedRows={[]}
				onOpenNewWorkspace={onOpenNewWorkspace}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "New workspace" }));

		expect(screen.queryByPlaceholderText("Search repositories")).toBeNull();
		expect(screen.queryByText("Repositories")).toBeNull();
		expect(onOpenNewWorkspace).toHaveBeenCalledTimes(1);
	});

	it("opens a workspace context menu and calls mark as unread", async () => {
		const user = userEvent.setup();
		const onMarkWorkspaceUnread = vi.fn();

		renderWithProviders(
			<WorkspacesSidebar
				groups={[
					{
						id: "progress",
						label: "In progress",
						tone: "progress",
						rows: [
							{
								id: "ready-workspace",
								title: "Ready workspace",
								state: "ready",
								repoName: "helmor-core",
								hasUnread: false,
							},
						],
					},
				]}
				archivedRows={[]}
				onMarkWorkspaceUnread={onMarkWorkspaceUnread}
			/>,
		);

		fireEvent.contextMenu(
			screen.getByRole("button", { name: "Ready workspace" }),
		);
		await user.click(screen.getByText("Mark as unread"));

		expect(onMarkWorkspaceUnread).toHaveBeenCalledWith("ready-workspace");
	});

	it("allows marking the selected workspace as unread", async () => {
		const user = userEvent.setup();
		const onMarkWorkspaceUnread = vi.fn();

		renderWithProviders(
			<WorkspacesSidebar
				groups={[
					{
						id: "progress",
						label: "In progress",
						tone: "progress",
						rows: [
							{
								id: "selected-workspace",
								title: "Selected workspace",
								state: "ready",
								repoName: "helmor-core",
								hasUnread: false,
							},
						],
					},
				]}
				archivedRows={[]}
				selectedWorkspaceId="selected-workspace"
				onMarkWorkspaceUnread={onMarkWorkspaceUnread}
			/>,
		);

		fireEvent.contextMenu(
			screen.getByRole("button", { name: "Selected workspace" }),
		);
		await user.click(screen.getByText("Mark as unread"));

		expect(onMarkWorkspaceUnread).toHaveBeenCalledWith("selected-workspace");
	});

	it("uses unread emphasis without treating ready rows as selected", () => {
		renderWithProviders(
			<WorkspacesSidebar
				groups={[
					{
						id: "progress",
						label: "In progress",
						tone: "progress",
						rows: [
							{
								id: "selected-read",
								title: "Selected read",
								state: "ready",
								repoName: "helmor-core",
								hasUnread: false,
							},
							{
								id: "unselected-unread",
								title: "Unselected unread",
								state: "ready",
								repoName: "helmor-core",
								hasUnread: true,
							},
						],
					},
				]}
				archivedRows={[]}
				selectedWorkspaceId="selected-read"
			/>,
		);

		// Walk up past the `HyperText`-injected `<span class="inline-block">` to
		// the sidebar's own label span — that's where the font-weight classes
		// live now that branch/title text goes through the scramble animation.
		const selectedReadLabel = screen
			.getByText("Selected read")
			.closest("span.truncate");
		const unreadLabel = screen
			.getByText("Unselected unread")
			.closest("span.truncate");

		expect(selectedReadLabel?.className).toContain("font-medium");
		expect(selectedReadLabel?.className).not.toContain("font-semibold");
		expect(unreadLabel?.className).toContain("font-semibold");
	});

	it("reopens a collapsed group when selection moves into it", async () => {
		const user = userEvent.setup();
		const groups: WorkspaceGroup[] = [
			{
				id: "review",
				label: "In review",
				tone: "review",
				rows: [
					{
						id: "review-workspace",
						title: "Review workspace",
						state: "ready",
						repoName: "helmor-core",
					},
				],
			},
			{
				id: "progress",
				label: "In progress",
				tone: "progress",
				rows: [
					{
						id: "progress-workspace",
						title: "Progress workspace",
						state: "ready",
						repoName: "helmor-core",
					},
				],
			},
		];
		const { rerender } = renderWithProviders(
			<WorkspacesSidebar
				groups={groups}
				archivedRows={[]}
				selectedWorkspaceId="review-workspace"
			/>,
		);

		await user.click(screen.getByRole("button", { name: /^In progress/ }));

		expect(
			screen.queryByRole("button", { name: "Progress workspace" }),
		).not.toBeInTheDocument();

		rerender(
			<WorkspacesSidebar
				groups={groups}
				archivedRows={[]}
				selectedWorkspaceId="progress-workspace"
			/>,
		);

		await waitFor(() => {
			expect(
				screen.getByRole("button", { name: "Progress workspace" }),
			).toBeInTheDocument();
		});
	});

	it("opens archived and shows the selected workspace", async () => {
		const archivedRows = [
			{
				id: "archived-workspace",
				title: "Archived workspace",
				state: "archived" as const,
				repoName: "helmor-core",
			},
		];

		const { rerender } = renderWithProviders(
			<WorkspacesSidebar groups={[]} archivedRows={archivedRows} />,
		);

		rerender(
			<WorkspacesSidebar
				groups={[]}
				archivedRows={archivedRows}
				selectedWorkspaceId="archived-workspace"
			/>,
		);

		await waitFor(() => {
			expect(
				screen.getByRole("button", { name: "Archived workspace" }),
			).toBeInTheDocument();
		});
	});

	it("disables restore while a workspace is being restored", async () => {
		const user = userEvent.setup();
		const onRestoreWorkspace = vi.fn();

		renderWithProviders(
			<WorkspacesSidebar
				groups={[]}
				archivedRows={[
					{
						id: "archived-workspace",
						title: "Archived workspace",
						state: "archived",
						repoName: "helmor-core",
					},
				]}
				onRestoreWorkspace={onRestoreWorkspace}
				restoringWorkspaceId="archived-workspace"
			/>,
		);

		await user.click(screen.getByRole("button", { name: /^Archived/ }));
		const restoreButton = screen.getByRole("button", {
			name: "Restore workspace",
		});

		expect(restoreButton).toBeDisabled();
		await user.click(restoreButton);
		expect(onRestoreWorkspace).not.toHaveBeenCalled();
	});

	it("disables archive while another workspace mutation is running", async () => {
		const user = userEvent.setup();
		const onArchiveWorkspace = vi.fn();

		renderWithProviders(
			<WorkspacesSidebar
				groups={[
					{
						id: "progress",
						label: "In progress",
						tone: "progress",
						rows: [
							{
								id: "ready-workspace",
								title: "Ready workspace",
								state: "ready",
								repoName: "helmor-core",
							},
						],
					},
				]}
				archivedRows={[]}
				onArchiveWorkspace={onArchiveWorkspace}
				archivingWorkspaceIds={new Set(["ready-workspace"])}
			/>,
		);

		const archiveButton = screen.getByRole("button", {
			name: "Archive workspace",
		});

		expect(archiveButton).toBeDisabled();
		await user.click(archiveButton);
		expect(onArchiveWorkspace).not.toHaveBeenCalled();
	});

	it("shows unread indicators in inactive session tabs", () => {
		renderWithProviders(
			<WorkspacePanel
				workspace={null}
				sessions={[
					{
						id: "session-1",
						workspaceId: "workspace-1",
						title: "Unread session",
						agentType: "claude",
						status: "idle",
						permissionMode: "default",
						unreadCount: 1,
						fastMode: false,
						createdAt: "2026-04-03T00:00:00Z",
						updatedAt: "2026-04-03T00:00:00Z",
						isHidden: false,
						active: false,
					},
				]}
				selectedSessionId={null}
				sessionPanes={[
					{
						sessionId: "session-1",
						messages: [],
						sending: false,
						hasLoaded: true,
						presentationState: "presented",
					},
				]}
			/>,
		);

		expect(screen.getByLabelText("Unread session")).toBeInTheDocument();
	});

	it("keeps large threads on the progressive viewport while sending", () => {
		const messages = Array.from({ length: 30 }, (_, index) => ({
			role: "assistant" as const,
			id: `assistant-${index}`,
			createdAt: `2026-04-03T00:00:${String(index).padStart(2, "0")}Z`,
			content: [
				{
					type: "text" as const,
					id: `assistant-${index}:txt:0`,
					text: `message ${index} `.repeat(8),
				},
			],
			status: { type: "complete" as const, reason: "stop" as const },
		}));

		renderWithProviders(
			<WorkspacePanel
				workspace={null}
				sessions={[
					{
						id: "session-1",
						workspaceId: "workspace-1",
						title: "Streaming session",
						agentType: "claude",
						status: "idle",
						permissionMode: "default",
						unreadCount: 0,
						fastMode: false,
						createdAt: "2026-04-03T00:00:00Z",
						updatedAt: "2026-04-03T00:00:00Z",
						isHidden: false,
						active: true,
					},
				]}
				selectedSessionId="session-1"
				sending
				sessionPanes={[
					{
						sessionId: "session-1",
						messages,
						sending: true,
						hasLoaded: true,
						presentationState: "presented",
					},
				]}
			/>,
		);

		expect(
			screen.getByLabelText("Conversation rows for session session-1"),
		).toBeInTheDocument();
	});
});
