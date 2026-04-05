import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { WorkspaceGroup, WorkspaceRow } from "@/lib/api";
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

describe("WorkspacesSidebar", () => {
	it("updates the row icon immediately when a workspace enters sending state", () => {
		const { rerender } = render(
			<WorkspacesSidebar
				groups={workspaceGroups}
				archivedRows={[]}
				selectedWorkspaceId="workspace-1"
				sendingWorkspaceIds={new Set()}
			/>,
		);

		const initialRow = screen.getByRole("button", { name: "Workspace 1" });
		expect(initialRow.querySelector(".animate-spin")).toBeNull();

		rerender(
			<WorkspacesSidebar
				groups={workspaceGroups}
				archivedRows={[]}
				selectedWorkspaceId="workspace-1"
				sendingWorkspaceIds={new Set(["workspace-1"])}
			/>,
		);

		const updatedRow = screen.getByRole("button", { name: "Workspace 1" });
		expect(updatedRow.querySelector(".animate-spin")).not.toBeNull();
	});
});
