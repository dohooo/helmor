import {
	type AutoScrollOptions,
	type CollisionDetection,
	closestCorners,
	DndContext,
	type DragCancelEvent,
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
import { Maximize2, Minimize2 } from "lucide-react";
import {
	type KeyboardEventHandler,
	type MouseEventHandler,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { InboxSidebar } from "@/features/inbox";
import type { WorkspaceDetail, WorkspaceGroup, WorkspaceRow } from "@/lib/api";
import { setWorkspaceStatus } from "@/lib/api";
import {
	helmorQueryKeys,
	workspaceGroupsQueryOptions,
} from "@/lib/query-client";
import { cn } from "@/lib/utils";
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
const KANBAN_AUTO_SCROLL: AutoScrollOptions = {
	acceleration: 3,
	interval: 16,
	threshold: {
		x: 0.12,
		y: 0.18,
	},
};

type KanbanPageProps = {
	boardMaxWidth: number;
	boardWidth: number;
	inboxWidth: number;
	inboxMaxWidth: number;
	isBoardExpanded: boolean;
	isBoardResizing: boolean;
	isInboxResizing: boolean;
	minWidth: number;
	onBoardExpandToggle: (expandedWidth: number) => void;
	onBoardResizeKeyDown: KeyboardEventHandler<HTMLDivElement>;
	onBoardResizeStart: MouseEventHandler<HTMLDivElement>;
	onInboxResizeKeyDown: KeyboardEventHandler<HTMLDivElement>;
	onInboxResizeStart: MouseEventHandler<HTMLDivElement>;
	resizeHitArea: number;
};

type SettlingDrop =
	| {
			columnId: KanbanColumnId;
			height: number | null;
			placement: "inline";
			workspaceId: string;
	  }
	| {
			columnId: KanbanColumnId;
			height: number | null;
			placement: "top";
			row: WorkspaceRow;
			workspaceId: string;
	  };

const kanbanCollisionDetection: CollisionDetection = (args) => {
	const pointerCollisions = pointerWithin(args);
	return pointerCollisions.length > 0
		? pointerCollisions
		: closestCorners(args);
};

export function KanbanPage({
	boardMaxWidth,
	boardWidth,
	inboxWidth,
	inboxMaxWidth,
	isBoardExpanded,
	isBoardResizing,
	isInboxResizing,
	minWidth,
	onBoardExpandToggle,
	onBoardResizeKeyDown,
	onBoardResizeStart,
	onInboxResizeKeyDown,
	onInboxResizeStart,
	resizeHitArea,
}: KanbanPageProps) {
	const queryClient = useQueryClient();
	const groupsQuery = useQuery(workspaceGroupsQueryOptions());
	const pageRef = useRef<HTMLDivElement | null>(null);
	const sensors = useSensors(
		useSensor(PointerSensor, {
			activationConstraint: {
				distance: 6,
			},
		}),
		useSensor(KeyboardSensor),
	);
	const [activeId, setActiveId] = useState<string | null>(null);
	const [overColumnId, setOverColumnId] = useState<KanbanColumnId | null>(null);
	const [activeCardRect, setActiveCardRect] = useState<{
		height: number;
		width: number;
	} | null>(null);
	const [settlingDrop, setSettlingDrop] = useState<SettlingDrop | null>(null);
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
	const handleBoardExpandToggle = useCallback(() => {
		const pageWidth =
			pageRef.current?.clientWidth ?? boardMaxWidth + inboxWidth;
		const expandedWidth = Math.min(
			boardMaxWidth,
			Math.max(minWidth, pageWidth - inboxWidth),
		);
		onBoardExpandToggle(expandedWidth);
	}, [boardMaxWidth, inboxWidth, minWidth, onBoardExpandToggle]);

	useEffect(() => {
		return () => {
			if (settleTimerRef.current) {
				clearTimeout(settleTimerRef.current);
			}
		};
	}, []);

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

	const startSettlingDrop = useCallback((drop: SettlingDrop) => {
		if (settleTimerRef.current) {
			clearTimeout(settleTimerRef.current);
		}
		setSettlingDrop(drop);
		settleTimerRef.current = setTimeout(() => {
			setSettlingDrop((current) =>
				current?.workspaceId === drop.workspaceId ? null : current,
			);
			settleTimerRef.current = null;
		}, DROP_SETTLE_MS);
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

	const handleDragCancel = useCallback(
		(_event: DragCancelEvent) => {
			resetDragState();
		},
		[resetDragState],
	);

	const handleDragEnd = useCallback(
		(event: DragEndEvent) => {
			const workspaceId = String(event.active.id);
			const row = rowsById.get(workspaceId);
			const targetColumnId = getColumnIdFromOver(event.over);
			resetDragState();

			if (!row || !targetColumnId) {
				return;
			}

			if (targetColumnId === row.status) {
				startSettlingDrop({
					columnId: row.status,
					height: activeCardRect?.height ?? null,
					placement: "inline",
					workspaceId,
				});
				return;
			}

			const settledRow: WorkspaceRow = { ...row, status: targetColumnId };
			startSettlingDrop({
				columnId: targetColumnId,
				height: activeCardRect?.height ?? null,
				placement: "top",
				row: settledRow,
				workspaceId,
			});
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
		[
			activeCardRect?.height,
			queryClient,
			resetDragState,
			rowsById,
			startSettlingDrop,
		],
	);

	return (
		<DndContext
			autoScroll={KANBAN_AUTO_SCROLL}
			collisionDetection={kanbanCollisionDetection}
			onDragCancel={handleDragCancel}
			onDragEnd={handleDragEnd}
			onDragOver={handleDragOver}
			onDragStart={handleDragStart}
			sensors={sensors}
		>
			<div
				ref={pageRef}
				aria-label="Kanban page"
				className="relative flex min-h-0 flex-1 bg-background"
			>
				<aside
					aria-label="Kanban inbox"
					className="flex h-full shrink-0 flex-col overflow-hidden border-border/60 border-r bg-sidebar"
					style={{ width: `${inboxWidth}px` }}
				>
					<InboxSidebar className="flex flex-1" />
				</aside>
				<KanbanResizeHandle
					ariaLabel="Resize kanban inbox"
					ariaValueMax={inboxMaxWidth}
					ariaValueMin={minWidth}
					ariaValueNow={inboxWidth}
					edge="right"
					isResizing={isInboxResizing}
					onKeyDown={onInboxResizeKeyDown}
					onMouseDown={onInboxResizeStart}
					resizeHitArea={resizeHitArea}
					style={{ left: `${inboxWidth - resizeHitArea / 2}px` }}
				/>
				<div
					aria-label="Kanban main content"
					className="min-w-0 flex-1 bg-background"
				/>
				<KanbanResizeHandle
					ariaLabel="Resize kanban board"
					ariaValueMax={boardMaxWidth}
					ariaValueMin={minWidth}
					ariaValueNow={boardWidth}
					edge="left"
					isResizing={isBoardResizing}
					onKeyDown={onBoardResizeKeyDown}
					onMouseDown={onBoardResizeStart}
					resizeHitArea={resizeHitArea}
					style={{ right: `${boardWidth - resizeHitArea / 2}px` }}
				/>
				<aside
					className="relative flex h-full shrink-0 flex-col border-border/60 border-l bg-background"
					style={{ width: `${boardWidth}px` }}
				>
					<div className="flex h-8 shrink-0 items-center justify-between border-border/50 border-b px-3">
						<h1 className="text-[13px] font-medium text-muted-foreground">
							Kanban
						</h1>
						<button
							type="button"
							aria-label={
								isBoardExpanded
									? "Collapse kanban board"
									: "Expand kanban board"
							}
							title={
								isBoardExpanded
									? "Collapse kanban board"
									: "Expand kanban board"
							}
							className="inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
							onClick={handleBoardExpandToggle}
						>
							{isBoardExpanded ? (
								<Minimize2 className="size-3.5" strokeWidth={1.8} />
							) : (
								<Maximize2 className="size-3.5" strokeWidth={1.8} />
							)}
						</button>
					</div>
					<div
						className={cn(
							"flex min-h-0 flex-1 scroll-pl-3 gap-3 overflow-x-auto p-3 pt-2 pb-1 [scrollbar-width:thin]",
							activeId
								? "snap-none scroll-auto overscroll-x-contain"
								: "snap-x snap-mandatory scroll-smooth",
						)}
					>
						{KANBAN_COLUMNS.map((column) => (
							<KanbanColumn
								key={column.id}
								activePlaceholderHeight={activeCardRect?.height ?? null}
								activePlaceholderRowId={
									activeRow && column.id === activeColumnId
										? activeRow.id
										: null
								}
								dropPreview={getDropPreview({
									activeRow,
									columnId: column.id,
									placeholderHeight: activeCardRect?.height ?? null,
									previewColumnId,
									settlingDrop,
								})}
								hiddenRowId={
									settlingDrop?.placement === "top" &&
									settlingDrop.columnId === column.id
										? settlingDrop.workspaceId
										: null
								}
								id={column.id}
								isDropTarget={
									previewColumnId === column.id ||
									settlingDrop?.columnId === column.id
								}
								label={column.label}
								settlingPlaceholder={
									settlingDrop?.placement === "inline" &&
									settlingDrop.columnId === column.id
										? {
												fadeMs: DROP_SETTLE_MS,
												height: settlingDrop.height,
												workspaceId: settlingDrop.workspaceId,
											}
										: null
								}
								tone={column.tone}
								rows={columns[column.id]}
							/>
						))}
					</div>
					<div
						aria-hidden="true"
						className="pointer-events-none absolute inset-y-0 right-0 z-20 w-8 bg-gradient-to-l from-black/28 via-black/10 to-transparent dark:from-black/45 dark:via-black/16"
					/>
				</aside>
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
							className="border-border/70 bg-card shadow-lg"
						/>
					</div>
				) : null}
			</DragOverlay>
		</DndContext>
	);
}

function KanbanResizeHandle({
	ariaLabel,
	ariaValueMax,
	ariaValueMin,
	ariaValueNow,
	edge,
	isResizing,
	onKeyDown,
	onMouseDown,
	resizeHitArea,
	style,
}: {
	ariaLabel: string;
	ariaValueMax: number;
	ariaValueMin: number;
	ariaValueNow: number;
	edge: "left" | "right";
	isResizing: boolean;
	onKeyDown: KeyboardEventHandler<HTMLDivElement>;
	onMouseDown: MouseEventHandler<HTMLDivElement>;
	resizeHitArea: number;
	style: React.CSSProperties;
}) {
	return (
		<div
			role="separator"
			tabIndex={0}
			aria-label={ariaLabel}
			aria-orientation="vertical"
			aria-valuemin={ariaValueMin}
			aria-valuemax={ariaValueMax}
			aria-valuenow={ariaValueNow}
			onMouseDown={onMouseDown}
			onKeyDown={onKeyDown}
			className="group absolute inset-y-0 z-30 cursor-ew-resize touch-none outline-none"
			style={{
				...style,
				width: `${resizeHitArea}px`,
			}}
		>
			<span
				aria-hidden="true"
				className={cn(
					"pointer-events-none absolute inset-y-0 transition-[width,background-color,box-shadow]",
					"left-1/2 -translate-x-1/2",
					isResizing
						? edge === "right"
							? "w-[2px] bg-foreground/80 shadow-[0_0_12px_rgba(0,0,0,0.12)] dark:shadow-[0_0_12px_rgba(255,255,255,0.16)]"
							: "w-[2px] bg-transparent shadow-none"
						: "w-px bg-border group-hover:w-[2px] group-hover:bg-muted-foreground/75 group-focus-visible:w-[2px] group-focus-visible:bg-muted-foreground/75",
				)}
			/>
		</div>
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
	settlingDrop: SettlingDrop | null;
}) {
	if (settlingDrop?.placement === "top" && settlingDrop.columnId === columnId) {
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

type KanbanCollisionEntry = {
	data: {
		current?: {
			columnId?: unknown;
		};
	};
	id: UniqueIdentifier;
};

function getColumnIdFromOver(
	over: KanbanCollisionEntry | null,
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
