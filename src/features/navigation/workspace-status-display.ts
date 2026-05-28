import type { WorkspaceRow } from "@/lib/api";

export const WORKSPACE_STATUS_LABEL: Record<
	NonNullable<WorkspaceRow["status"]>,
	string
> = {
	"in-progress": "In progress",
	review: "In review",
	done: "Done",
	backlog: "Backlog",
	canceled: "Canceled",
};

export const WORKSPACE_STATUS_DOT_CLASS: Record<
	NonNullable<WorkspaceRow["status"]>,
	string
> = {
	"in-progress": "bg-[var(--workspace-sidebar-status-progress)]",
	review: "bg-[var(--workspace-sidebar-status-review)]",
	done: "bg-[var(--workspace-sidebar-status-done)]",
	backlog: "bg-[var(--workspace-sidebar-status-backlog)]",
	canceled: "bg-[var(--workspace-sidebar-status-canceled)]",
};

export type WorkspaceStatusValue = NonNullable<WorkspaceRow["status"]>;

export type WorkspaceStatusDot = {
	label: string;
	dotClass: string;
};

export function deriveWorkspaceStatusDot(
	row: WorkspaceRow,
): WorkspaceStatusDot {
	// Defensive lookup: legacy DBs may have rows with "in-review" /
	// "cancelled" / etc. — a backend migration normalizes them on boot,
	// but until that runs once we fall back to in-progress rather than
	// rendering a class-less (transparent) dot.
	const raw = row.status ?? "in-progress";
	const status: WorkspaceStatusValue =
		raw in WORKSPACE_STATUS_DOT_CLASS
			? (raw as WorkspaceStatusValue)
			: "in-progress";
	return {
		label: WORKSPACE_STATUS_LABEL[status],
		dotClass: WORKSPACE_STATUS_DOT_CLASS[status],
	};
}
