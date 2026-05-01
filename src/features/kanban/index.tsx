import {
	type CollisionDetection,
	closestCorners,
	DndContext,
	type DragEndEvent,
	type DragOverEvent,
	DragOverlay,
	type DragStartEvent,
	KeyboardSensor,
	PointerSensor,
	pointerWithin,
	type UniqueIdentifier,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { WorkspaceDetail, WorkspaceGroup, WorkspaceRow } from "@/lib/api";
import { setWorkspaceStatus } from "@/lib/api";
import {
	helmorQueryKeys,
	workspaceGroupsQueryOptions,
} from "@/lib/query-client";
import { describeUnknownError } from "@/lib/workspace-helpers";
import {
	applyKanbanTopPlacements,
	KANBAN_COLUMNS,
	type KanbanTopPlacement,
	projectGroupsToKanbanColumns,
} from "./board-state";
import { KanbanCardPreview } from "./card";
import { columnDropId, KanbanColumn } from "./column";
import type { KanbanColumnId } from "./types";

const DROP_SETTLE_MS = 190;

const kanbanCollisionDetection: CollisionDetection = (args) => {
	const pointerCollisions = pointerWithin(args);
	return pointerCollisions.length > 0
		? pointerCollisions
		: closestCorners(args);
};

export function KanbanPage() {
	const queryClient = useQueryClient();
	const groupsQuery = useQuery(workspaceGroupsQueryOptions());
	const [activeId, setActiveId] = useState<string | null>(null);
	const [overColumnId, setOverColumnId] = useState<KanbanColumnId | null>(null);
	const [activeCardRect, setActiveCardRect] = useState<{
		height: number;
		width: number;
	} | null>(null);
	const [settlingDrop, setSettlingDrop] = useState<{
		columnId: KanbanColumnId;
		height: number | null;
		row: WorkspaceRow;
		workspaceId: string;
	} | null>(null);
	const [topPlacements, setTopPlacements] = useState<KanbanTopPlacement[]>([]);
	const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const baseColumns = useMemo(
		() => projectGroupsToKanbanColumns(groupsQuery.data ?? []),
		[groupsQuery.data],
	);
	const columns = useMemo(
		() => applyKanbanTopPlacements(baseColumns, topPlacements),
		[baseColumns, topPlacements],
	);
	const rowsById = useMemo(() => {
		const rows = new Map<string, WorkspaceRow>();
		for (const column of KANBAN_COLUMNS) {
			for (const row of columns[column.id]) {
				rows.set(row.id, row);
			}
		}
		return rows;
	}, [columns]);
	const activeRow = activeId ? (rowsById.get(activeId) ?? null) : null;
	const activeColumnId = activeRow?.status ?? null;
	const previewColumnId =
		overColumnId && overColumnId !== activeColumnId ? overColumnId : null;

	useEffect(() => {
		return () => {
			if (settleTimerRef.current) {
				clearTimeout(settleTimerRef.current);
			}
		};
	}, []);

	const sensors = useSensors(
		useSensor(PointerSensor, {
			activationConstraint: {
				distance: 6,
			},
		}),
		useSensor(KeyboardSensor),
	);

	const resetDragState = useCallback(() => {
		setActiveId(null);
		setOverColumnId(null);
		setActiveCardRect(null);
	}, []);

	const clearSettlingDrop = useCallback(() => {
		if (settleTimerRef.current) {
			clearTimeout(settleTimerRef.current);
			settleTimerRef.current = null;
		}
		setSettlingDrop(null);
	}, []);

	const handleDragStart = useCallback(
		(event: DragStartEvent) => {
			clearSettlingDrop();
			const id = String(event.active.id);
			const initialRect = event.active.rect.current.initial;
			setActiveId(id);
			setOverColumnId(getColumnIdFromOver(event.active));
			setActiveCardRect(
				initialRect
					? { height: initialRect.height, width: initialRect.width }
					: null,
			);
		},
		[clearSettlingDrop],
	);

	const handleDragOver = useCallback((event: DragOverEvent) => {
		setOverColumnId(getColumnIdFromOver(event.over));
	}, []);

	const handleDragEnd = useCallback(
		(event: DragEndEvent) => {
			const workspaceId = String(event.active.id);
			const row = rowsById.get(workspaceId);
			const targetColumnId = getColumnIdFromOver(event.over);
			resetDragState();

			if (!row || !targetColumnId || targetColumnId === row.status) {
				return;
			}

			const settledRow: WorkspaceRow = { ...row, status: targetColumnId };
			setSettlingDrop({
				columnId: targetColumnId,
				height: activeCardRect?.height ?? null,
				row: settledRow,
				workspaceId,
			});
			settleTimerRef.current = setTimeout(() => {
				setSettlingDrop((current) =>
					current?.workspaceId === workspaceId ? null : current,
				);
				settleTimerRef.current = null;
			}, DROP_SETTLE_MS);
			setTopPlacements((placements) => [
				{ workspaceId, columnId: targetColumnId },
				...placements.filter(
					(placement) => placement.workspaceId !== workspaceId,
				),
			]);
			queryClient.setQueryData<WorkspaceGroup[] | undefined>(
				helmorQueryKeys.workspaceGroups,
				(groups) =>
					updateWorkspaceStatusInGroups(groups, workspaceId, targetColumnId),
			);
			queryClient.setQueryData<WorkspaceDetail | undefined>(
				helmorQueryKeys.workspaceDetail(workspaceId),
				(detail) => (detail ? { ...detail, status: targetColumnId } : detail),
			);

			void setWorkspaceStatus(workspaceId, targetColumnId)
				.then(() => {
					void queryClient.invalidateQueries({
						queryKey: helmorQueryKeys.workspaceGroups,
					});
				})
				.catch((error) => {
					setTopPlacements((placements) =>
						placements.filter(
							(placement) => placement.workspaceId !== workspaceId,
						),
					);
					setSettlingDrop((current) =>
						current?.workspaceId === workspaceId ? null : current,
					);
					void queryClient.invalidateQueries({
						queryKey: helmorQueryKeys.workspaceGroups,
					});
					void queryClient.invalidateQueries({
						queryKey: helmorQueryKeys.workspaceDetail(workspaceId),
					});
					toast(describeUnknownError(error, "Unable to move workspace card."));
				});
		},
		[activeCardRect?.height, queryClient, resetDragState, rowsById],
	);

	return (
		<DndContext
			collisionDetection={kanbanCollisionDetection}
			onDragCancel={resetDragState}
			onDragEnd={handleDragEnd}
			onDragOver={handleDragOver}
			onDragStart={handleDragStart}
			sensors={sensors}
		>
			<div
				aria-label="Kanban page"
				className="flex min-h-0 flex-1 flex-col bg-background"
			>
				<div className="flex h-9 shrink-0 items-center border-border/50 border-b px-4">
					<h1 className="text-[13px] font-medium text-muted-foreground">
						Kanban
					</h1>
				</div>
				<div className="scrollbar-stable flex min-h-0 flex-1 gap-3 overflow-x-auto p-4 [scrollbar-width:thin]">
					{KANBAN_COLUMNS.map((column) => (
						<KanbanColumn
							key={column.id}
							dropPreview={getDropPreview({
								activeRow,
								columnId: column.id,
								placeholderHeight: activeCardRect?.height ?? null,
								previewColumnId,
								settlingDrop,
							})}
							hiddenRowId={
								settlingDrop?.columnId === column.id
									? settlingDrop.workspaceId
									: null
							}
							id={column.id}
							isDropTarget={
								previewColumnId === column.id ||
								settlingDrop?.columnId === column.id
							}
							label={column.label}
							tone={column.tone}
							rows={columns[column.id]}
						/>
					))}
				</div>
			</div>
			<DragOverlay
				adjustScale={false}
				dropAnimation={{
					duration: DROP_SETTLE_MS,
					easing: "cubic-bezier(0.2, 0, 0, 1)",
				}}
			>
				{activeRow ? (
					<div
						className="cursor-grabbing"
						style={
							activeCardRect
								? {
										height: activeCardRect.height,
										width: activeCardRect.width,
									}
								: undefined
						}
					>
						<KanbanCardPreview
							row={activeRow}
							className="border-primary/30 bg-card shadow-lg ring-1 ring-primary/10"
						/>
					</div>
				) : null}
			</DragOverlay>
		</DndContext>
	);
}

function getDropPreview({
	activeRow,
	columnId,
	placeholderHeight,
	previewColumnId,
	settlingDrop,
}: {
	activeRow: WorkspaceRow | null;
	columnId: KanbanColumnId;
	placeholderHeight: number | null;
	previewColumnId: KanbanColumnId | null;
	settlingDrop: {
		columnId: KanbanColumnId;
		height: number | null;
		row: WorkspaceRow;
	} | null;
}) {
	if (settlingDrop?.columnId === columnId) {
		return {
			fadeMs: DROP_SETTLE_MS,
			height: settlingDrop.height,
			mode: "settling" as const,
			row: settlingDrop.row,
		};
	}

	if (previewColumnId === columnId && activeRow) {
		return {
			height: placeholderHeight,
			mode: "hover" as const,
			row: { ...activeRow, status: columnId },
		};
	}

	return null;
}

type KanbanDndEntry = {
	data: {
		current?: {
			columnId?: unknown;
		};
	};
	id: UniqueIdentifier;
};

function getColumnIdFromOver(
	over: KanbanDndEntry | null,
): KanbanColumnId | null {
	if (!over) return null;

	const columnId = over.data.current?.columnId;
	if (isKanbanColumnId(columnId)) return columnId;

	const id = String(over.id);
	for (const column of KANBAN_COLUMNS) {
		if (id === columnDropId(column.id)) return column.id;
	}

	return null;
}

function isKanbanColumnId(value: unknown): value is KanbanColumnId {
	return KANBAN_COLUMNS.some((column) => column.id === value);
}

function updateWorkspaceStatusInGroups(
	groups: WorkspaceGroup[] | undefined,
	workspaceId: string,
	columnId: KanbanColumnId,
): WorkspaceGroup[] | undefined {
	if (!groups) return groups;

	return groups.map((group) => ({
		...group,
		rows: group.rows.map((row) =>
			row.id === workspaceId ? { ...row, status: columnId } : row,
		),
	}));
}
