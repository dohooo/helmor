import { describe, expect, it } from "vitest";
import type { WorkspaceGroup, WorkspaceRow } from "@/lib/api";
import {
	applyKanbanTopPlacements,
	moveWorkspaceToKanbanTop,
	projectGroupsToKanbanColumns,
} from "./board-state";

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

	it("moves a workspace to the top of the target column", () => {
		const columns = projectGroupsToKanbanColumns([
			{
				id: "progress",
				label: "In progress",
				tone: "progress",
				rows: [row("active", "in-progress")],
			},
			{
				id: "review",
				label: "In review",
				tone: "review",
				rows: [row("first-review", "review"), row("second-review", "review")],
			},
		]);

		const next = moveWorkspaceToKanbanTop(columns, "active", "review");

		expect(next["in-progress"].map((item) => item.id)).toEqual([]);
		expect(next.review.map((item) => item.id)).toEqual([
			"active",
			"first-review",
			"second-review",
		]);
		expect(next.review[0]?.status).toBe("review");
	});

	it("keeps the latest top placement first", () => {
		const columns = projectGroupsToKanbanColumns([
			{
				id: "progress",
				label: "In progress",
				tone: "progress",
				rows: [row("a", "in-progress"), row("b", "in-progress")],
			},
			{
				id: "review",
				label: "In review",
				tone: "review",
				rows: [row("existing", "review")],
			},
		]);

		const next = applyKanbanTopPlacements(columns, [
			{ workspaceId: "b", columnId: "review" },
			{ workspaceId: "a", columnId: "review" },
		]);

		expect(next.review.map((item) => item.id)).toEqual(["b", "a", "existing"]);
	});
});
