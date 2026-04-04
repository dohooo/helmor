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
import { WorkspacesSidebar } from "./components/workspaces-sidebar";
import { WorkspacePanel } from "./components/workspace-panel";
import type { RepositoryCreateOption, WorkspaceGroup } from "./lib/api";

vi.mock("./App.css", () => ({}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

const SIDEBAR_WIDTH_STORAGE_KEY = "helmor.workspaceSidebarWidth";

describe("App", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the sidebar shell with tooltips, avatars, archive actions, and collapsible groups", async () => {
    const user = userEvent.setup();
    const { container } = render(<App />);

    const shell = screen.getByRole("main", { name: "Application shell" });
    const sidebar = screen.getByLabelText("Workspace sidebar");
    const panel = screen.getByLabelText("Workspace panel");
    const dragRegion = screen.getByLabelText("Workspace panel drag region");
    const viewport = screen.getByLabelText("Workspace viewport");
    const composer = screen.getByLabelText("Workspace composer");
    const input = screen.getByLabelText("Workspace input");
    const resizeHandle = screen.getByRole("separator", {
      name: "Resize sidebar",
    });
    const doneGroup = screen.getByRole("button", { name: "Done" });
    const progressGroup = screen.getByRole("button", { name: "In progress" });
    const addRepositoryButton = screen.getByRole("button", {
      name: "Add repository",
    });
    const newWorkspaceButton = screen.getByRole("button", {
      name: "New workspace",
    });
    const safeAreas = container.querySelectorAll('[data-slot="window-safe-top"]');
    const avatars = container.querySelectorAll('[data-slot="workspace-avatar"]');
    const groupsScrollRegion = container.querySelector(
      '[data-slot="workspace-groups-scroll"]',
    );

    expect(shell).toHaveClass("bg-app-base");
    expect(shell).toHaveClass("h-screen");
    expect(shell).toHaveClass("overflow-hidden");
    expect(sidebar).toHaveClass("bg-app-sidebar");
    expect(sidebar).toHaveClass("overflow-hidden");
    expect(sidebar).toHaveStyle({ width: "336px" });
    expect(panel).toHaveClass("relative");
    expect(panel).toHaveClass("bg-app-elevated");
    expect(dragRegion).toHaveAttribute("data-tauri-drag-region");
    expect(viewport).toHaveClass("bg-white");
    expect(viewport).toHaveClass("dark:bg-app-elevated");
    expect(composer).toBeInTheDocument();
    expect(input).toHaveAttribute(
      "placeholder",
      "Ask to make changes, @mention files, run /commands",
    );
    expect(resizeHandle).toHaveAttribute("aria-valuenow", "336");
    expect(safeAreas).toHaveLength(1);
    expect(avatars).toHaveLength(11);
    expect(groupsScrollRegion).toHaveClass("overflow-hidden");
    expect(groupsScrollRegion).toHaveClass("flex-1");
    expect(screen.getByText("Workspaces")).toBeInTheDocument();
    expect(doneGroup).toBeInTheDocument();
    expect(progressGroup).toBeInTheDocument();
    expect(screen.getByText("Cambridge")).toBeInTheDocument();
    expect(screen.queryByText("9")).not.toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "Archive workspace" }),
    ).toHaveLength(11);

    expect(addRepositoryButton).toBeInTheDocument();
    expect(newWorkspaceButton).toBeInTheDocument();

    await user.click(progressGroup);
    expect(screen.queryByText("Cambridge")).not.toBeInTheDocument();
    await user.click(progressGroup);
    expect(screen.getByText("Cambridge")).toBeInTheDocument();
  });

  it("resizes the sidebar and persists the width", async () => {
    render(<App />);

    const sidebar = screen.getByLabelText("Workspace sidebar");
    const resizeHandle = screen.getByRole("separator", {
      name: "Resize sidebar",
    });

    fireEvent.mouseDown(resizeHandle, { clientX: 336 });

    await waitFor(() => {
      expect(document.body.style.cursor).toBe("ew-resize");
    });

    fireEvent.mouseMove(window, { clientX: 360 });

    await waitFor(() => {
      expect(sidebar).toHaveStyle({ width: "360px" });
      expect(resizeHandle).toHaveAttribute("aria-valuenow", "360");
    });

    fireEvent.mouseUp(window);

    await waitFor(() => {
      expect(document.body.style.cursor).toBe("");
    });

    expect(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe("360");
  });

  it("restores the saved sidebar width from localStorage", () => {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, "404");

    render(<App />);

    expect(screen.getByLabelText("Workspace sidebar")).toHaveStyle({
      width: "404px",
    });
    expect(
      screen.getByRole("separator", { name: "Resize sidebar" }),
    ).toHaveAttribute("aria-valuenow", "404");
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

    render(<WorkspacesSidebar groups={groups} archivedRows={[]} />);

    expect(screen.getByText("HC")).toBeInTheDocument();
  });

  it("calls restore for archived workspaces and shows restore errors", async () => {
    const user = userEvent.setup();
    const onRestoreWorkspace = vi.fn();

    render(
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

    await user.click(screen.getByRole("button", { name: "Archived" }));
    await user.click(screen.getByRole("button", { name: "Restore workspace" }));

    expect(onRestoreWorkspace).toHaveBeenCalledWith("archived-workspace");
  });

  it("calls archive for ready workspaces", async () => {
    const user = userEvent.setup();
    const onArchiveWorkspace = vi.fn();

    render(
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

    expect(onArchiveWorkspace).toHaveBeenCalledWith("ready-workspace");
  });

  it("opens the repo picker and creates a workspace from a selected repository", async () => {
    const user = userEvent.setup();
    const onCreateWorkspace = vi.fn();
    const repositories: RepositoryCreateOption[] = [
      {
        id: "repo-1",
        name: "dosu-cli",
        defaultBranch: "main",
        repoInitials: "DC",
      },
      {
        id: "repo-2",
        name: "helmor",
        defaultBranch: "main",
        repoInitials: "H",
      },
    ];

    render(
      <WorkspacesSidebar
        groups={[]}
        archivedRows={[]}
        availableRepositories={repositories}
        onCreateWorkspace={onCreateWorkspace}
      />,
    );

    await user.click(screen.getByRole("button", { name: "New workspace" }));

    expect(
      screen.getByRole("dialog", { name: "Create workspace from repository" }),
    ).toBeInTheDocument();

    await user.type(screen.getByLabelText("Search repositories"), "dosu");
    await user.click(screen.getByText("dosu-cli"));

    expect(onCreateWorkspace).toHaveBeenCalledWith("repo-1");
  });

  it("opens a workspace context menu and calls mark as unread", async () => {
    const user = userEvent.setup();
    const onMarkWorkspaceUnread = vi.fn();

    render(
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

    fireEvent.contextMenu(screen.getByRole("button", { name: "Ready workspace" }));
    await user.click(screen.getByText("Mark as unread"));

    expect(onMarkWorkspaceUnread).toHaveBeenCalledWith("ready-workspace");
  });

  it("allows marking the selected workspace as unread", async () => {
    const user = userEvent.setup();
    const onMarkWorkspaceUnread = vi.fn();

    render(
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

    fireEvent.contextMenu(screen.getByRole("button", { name: "Selected workspace" }));
    await user.click(screen.getByText("Mark as unread"));

    expect(onMarkWorkspaceUnread).toHaveBeenCalledWith("selected-workspace");
  });

  it("uses unread emphasis without treating ready rows as selected", () => {
    render(
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

    const selectedReadLabel = screen.getByText("Selected read");
    const unreadLabel = screen.getByText("Unselected unread");

    expect(selectedReadLabel.className).toContain("font-medium");
    expect(selectedReadLabel.className).not.toContain("font-semibold");
    expect(unreadLabel.className).toContain("font-semibold");
  });

  it("disables restore while a workspace is being restored", async () => {
    const user = userEvent.setup();
    const onRestoreWorkspace = vi.fn();

    render(
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

    await user.click(screen.getByRole("button", { name: "Archived" }));
    const restoreButton = screen.getByRole("button", { name: "Restore workspace" });

    expect(restoreButton).toBeDisabled();
    await user.click(restoreButton);
    expect(onRestoreWorkspace).not.toHaveBeenCalled();
  });

  it("disables archive while another workspace mutation is running", async () => {
    const user = userEvent.setup();
    const onArchiveWorkspace = vi.fn();

    render(
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
        archivingWorkspaceId="ready-workspace"
      />,
    );

    const archiveButton = screen.getByRole("button", { name: "Archive workspace" });

    expect(archiveButton).toBeDisabled();
    await user.click(archiveButton);
    expect(onArchiveWorkspace).not.toHaveBeenCalled();
  });

  it("shows unread indicators in session tabs", () => {
    render(
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
            contextTokenCount: 0,
            thinkingEnabled: false,
            fastMode: false,
            createdAt: "2026-04-03T00:00:00Z",
            updatedAt: "2026-04-03T00:00:00Z",
            isHidden: false,
            isCompacting: false,
            active: false,
          },
        ]}
        selectedSessionId="session-1"
        messages={[]}
      />,
    );

    expect(screen.getByLabelText("Unread session")).toBeInTheDocument();
  });
});
