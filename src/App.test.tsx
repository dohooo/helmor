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
import type { WorkspaceGroup } from "./lib/conductor";

vi.mock("./App.css", () => ({}));

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
    expect(viewport).toHaveClass("bg-app-elevated");
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
        workspaceActionError="Restore failed."
      />,
    );

    await user.click(screen.getByRole("button", { name: "Archived" }));
    await user.click(screen.getByRole("button", { name: "Restore workspace" }));

    expect(onRestoreWorkspace).toHaveBeenCalledWith("archived-workspace");
    expect(screen.getByText("Restore failed.")).toBeInTheDocument();
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
});
