import { STATUS_OPTIONS } from "@/features/navigation/shared";
import type { WorkspaceGroup, WorkspaceRow, WorkspaceStatus } from "@/lib/api";
import type { KanbanColumnId, KanbanColumns } from "./types";

export const KANBAN_COLUMNS = STATUS_OPTIONS.map((option) => ({
	id: option.value,
	label: option.label,
	tone: option.tone,
}));

const EMPTY_COLUMNS = KANBAN_COLUMNS.reduce((columns, column) => {
	columns[column.id] = [];
	return columns;
}, {} as KanbanColumns);

export function createEmptyKanbanColumns(): KanbanColumns {
	return KANBAN_COLUMNS.reduce((next, column) => {
		next[column.id] = [...EMPTY_COLUMNS[column.id]];
		return next;
	}, {} as KanbanColumns);
}

export function projectGroupsToKanbanColumns(
	groups: WorkspaceGroup[],
): KanbanColumns {
	const columns = createEmptyKanbanColumns();
	const rowsById = new Map<string, WorkspaceRow>();

	for (const group of groups) {
		for (const row of group.rows) {
			rowsById.set(row.id, row);
		}
	}

	for (const row of rowsById.values()) {
		const status = normalizeWorkspaceStatus(row.status);
		columns[status].push({ ...row, status });
	}

	return columns;
}

function normalizeWorkspaceStatus(
	status: WorkspaceStatus | undefined,
): KanbanColumnId {
	return status ?? "in-progress";
}
