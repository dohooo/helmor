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

export type KanbanTopPlacement = {
	workspaceId: string;
	columnId: KanbanColumnId;
};

export function applyKanbanTopPlacements(
	columns: KanbanColumns,
	placements: KanbanTopPlacement[],
): KanbanColumns {
	const next = createEmptyKanbanColumns();
	const rowsById = new Map<string, WorkspaceRow>();

	for (const column of KANBAN_COLUMNS) {
		next[column.id] = [...columns[column.id]];
		for (const row of columns[column.id]) {
			rowsById.set(row.id, row);
		}
	}

	for (const placement of [...placements].reverse()) {
		const row = rowsById.get(placement.workspaceId);
		if (!row) continue;

		for (const column of KANBAN_COLUMNS) {
			next[column.id] = next[column.id].filter(
				(item) => item.id !== placement.workspaceId,
			);
		}

		next[placement.columnId] = [
			{ ...row, status: placement.columnId },
			...next[placement.columnId],
		];
	}

	return next;
}

export function moveWorkspaceToKanbanTop(
	columns: KanbanColumns,
	workspaceId: string,
	columnId: KanbanColumnId,
): KanbanColumns {
	return applyKanbanTopPlacements(columns, [{ workspaceId, columnId }]);
}

function normalizeWorkspaceStatus(
	status: WorkspaceStatus | undefined,
): KanbanColumnId {
	return status ?? "in-progress";
}
