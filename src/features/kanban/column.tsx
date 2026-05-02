import { useDroppable } from "@dnd-kit/core";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { GroupIcon } from "@/features/navigation/shared";
import type { GroupTone, WorkspaceRow } from "@/lib/api";
import { cn } from "@/lib/utils";
import { KanbanCard } from "./card";
import { KanbanPlaceholder } from "./placeholder";
import type { KanbanColumnId } from "./types";

type KanbanColumnProps = {
	activePlaceholderHeight: number | null;
	activePlaceholderRowId: string | null;
	dropPreview: KanbanDropPreview | null;
	hiddenRowId: string | null;
	id: KanbanColumnId;
	isDropTarget: boolean;
	label: string;
	settlingPlaceholder: KanbanSettlingInlinePlaceholder | null;
	tone: GroupTone;
	rows: WorkspaceRow[];
};

export type KanbanDropPreview = {
	fadeMs?: number;
	height: number | null;
	mode: "hover" | "settling";
	row: WorkspaceRow;
};

type KanbanSettlingInlinePlaceholder = {
	fadeMs?: number;
	height: number | null;
	workspaceId: string;
};

export function columnDropId(id: KanbanColumnId) {
	return `kanban-column:${id}`;
}

export function KanbanColumn({
	activePlaceholderHeight,
	activePlaceholderRowId,
	dropPreview,
	hiddenRowId,
	id,
	isDropTarget,
	label,
	settlingPlaceholder,
	tone,
	rows,
}: KanbanColumnProps) {
	const { isOver, setNodeRef } = useDroppable({
		id: columnDropId(id),
		data: {
			columnId: id,
			type: "kanban-column",
		},
	});

	return (
		<section
			aria-label={label}
			className={cn(
				"flex min-h-0 w-[280px] shrink-0 snap-start flex-col rounded-lg border border-border/60 bg-sidebar transition-[border-color,background-color,box-shadow] duration-150 [scroll-snap-stop:always]",
				(isDropTarget || isOver) &&
					"border-primary/35 bg-sidebar ring-1 ring-primary/15",
			)}
		>
			<header className="flex h-[37px] shrink-0 items-center justify-between border-border/50 border-b px-2.5">
				<div className="flex min-w-0 items-center gap-2">
					<GroupIcon tone={tone} />
					<h2 className="truncate text-[13px] font-semibold text-foreground">
						{label}
					</h2>
				</div>
				<Badge
					variant="secondary"
					className="h-4 min-w-[16px] justify-center rounded-full px-1 text-[9.5px] leading-none"
				>
					{rows.length}
				</Badge>
			</header>

			<ScrollArea className="min-h-0 flex-1 [&_[data-orientation=vertical]]:w-2 [&_[data-slot=scroll-area-scrollbar]]:p-0.5">
				<div
					ref={setNodeRef}
					className="flex min-h-20 w-full flex-col gap-2 rounded-md px-2 pt-2 pb-[280px]"
				>
					{dropPreview ? (
						dropPreview.mode === "settling" ? (
							<KanbanSettlingPlaceholder
								fadeMs={dropPreview.fadeMs}
								height={dropPreview.height}
								row={dropPreview.row}
							/>
						) : (
							<KanbanPlaceholder height={dropPreview.height} />
						)
					) : null}
					{rows.length > 0 ? (
						rows.map((row) =>
							row.id === hiddenRowId ? null : (
								<KanbanCard
									key={row.id}
									dragPlaceholderHeight={
										row.id === activePlaceholderRowId
											? activePlaceholderHeight
											: undefined
									}
									row={row}
									settlingPlaceholder={
										settlingPlaceholder?.workspaceId === row.id
											? settlingPlaceholder
											: null
									}
								/>
							),
						)
					) : isDropTarget ? null : (
						<div className="flex min-h-20 w-full items-center justify-center rounded-md border border-dashed border-border/70 text-[12px] text-muted-foreground">
							No workspaces
						</div>
					)}
				</div>
			</ScrollArea>
		</section>
	);
}

function KanbanSettlingPlaceholder({
	fadeMs,
	height,
	row,
}: {
	fadeMs?: number;
	height: number | null;
	row: WorkspaceRow;
}) {
	return (
		<div className="relative">
			<KanbanCard className="opacity-0" row={row} settling />
			<KanbanPlaceholder
				className="pointer-events-none absolute inset-0"
				fadeMs={fadeMs}
				height={height}
				phase="out"
			/>
		</div>
	);
}
