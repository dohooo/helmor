import { useDroppable } from "@dnd-kit/core";
import type { CSSProperties } from "react";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { GroupIcon } from "@/features/navigation/shared";
import type { GroupTone, WorkspaceRow } from "@/lib/api";
import { cn } from "@/lib/utils";
import { KanbanCard, KanbanCardPreview } from "./card";
import type { KanbanColumnId } from "./types";

type KanbanColumnProps = {
	dropPreview: KanbanDropPreview | null;
	hiddenRowId: string | null;
	id: KanbanColumnId;
	isDropTarget: boolean;
	label: string;
	tone: GroupTone;
	rows: WorkspaceRow[];
};

export type KanbanDropPreview = {
	height: number | null;
	mode: "hover" | "settling";
	row: WorkspaceRow;
};

export function columnDropId(id: KanbanColumnId) {
	return `kanban-column:${id}`;
}

export function KanbanColumn({
	dropPreview,
	hiddenRowId,
	id,
	isDropTarget,
	label,
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
				"flex min-h-0 w-[280px] shrink-0 flex-col rounded-lg border border-border/60 bg-sidebar/60 transition-[border-color,background-color,box-shadow] duration-150",
				(isDropTarget || isOver) &&
					"border-primary/35 bg-sidebar/80 ring-1 ring-primary/15",
			)}
		>
			<header className="flex h-10 shrink-0 items-center justify-between border-border/50 border-b px-3">
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
					className="flex min-h-20 w-full flex-col gap-2 rounded-md p-2"
				>
					{dropPreview ? (
						dropPreview.mode === "settling" ? (
							<KanbanCard row={dropPreview.row} settling />
						) : (
							<KanbanDropPlaceholder
								height={dropPreview.height}
								row={dropPreview.row}
							/>
						)
					) : null}
					{rows.length > 0 ? (
						rows.map((row) =>
							row.id === hiddenRowId ? null : (
								<KanbanCard key={row.id} row={row} />
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

function KanbanDropPlaceholder({
	height,
	row,
}: {
	height: number | null;
	row: WorkspaceRow;
}) {
	return (
		<div
			aria-hidden="true"
			className="kanban-drop-placeholder relative overflow-hidden rounded-lg border border-dashed border-primary/45 bg-primary/10 shadow-inner"
			style={
				height
					? ({
							"--kanban-placeholder-height": `${height}px`,
						} as CSSProperties)
					: undefined
			}
		>
			<KanbanCardPreview
				row={row}
				className="pointer-events-none h-full border-primary/20 bg-primary/5 opacity-30 shadow-none"
			/>
			<div className="absolute inset-0 rounded-lg bg-gradient-to-br from-primary/10 to-transparent" />
		</div>
	);
}
