import { describe, expect, it } from "vitest";
import type { WorkspaceGroup, WorkspaceRow } from "@/lib/api";
import { projectGroupsToKanbanColumns } from "./board-state";

function row(id: string, status: WorkspaceRow["status"]): WorkspaceRow {
	return {
		id,
		status,
		title: id,
	};
}

describe("kanban board state", () => {
	it("projects existing workspace groups into status columns", () => {
		const groups: WorkspaceGroup[] = [
			{
				id: "pinned",
				label: "Pinned",
				tone: "pinned",
				rows: [row("pinned-review", "review")],
			},
			{
				id: "progress",
				label: "In progress",
				tone: "progress",
				rows: [row("active", "in-progress")],
			},
		];

		const columns = projectGroupsToKanbanColumns(groups);

		expect(columns.review.map((item) => item.id)).toEqual(["pinned-review"]);
		expect(columns["in-progress"].map((item) => item.id)).toEqual(["active"]);
	});
});
