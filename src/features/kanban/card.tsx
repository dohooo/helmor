import { useDraggable } from "@dnd-kit/core";
import { GitBranch, MessageSquare, Pin } from "lucide-react";
import { memo } from "react";
import { WorkspaceAvatar } from "@/features/navigation/avatar";
import {
	branchToneClasses,
	humanizeBranch,
} from "@/features/navigation/shared";
import type { WorkspaceRow } from "@/lib/api";
import { cn } from "@/lib/utils";
import { getWorkspaceBranchTone } from "@/lib/workspace-helpers";

type KanbanCardProps = {
	className?: string;
	row: WorkspaceRow;
	settling?: boolean;
};

export const KanbanCard = memo(function KanbanCard({
	className,
	row,
	settling = false,
}: KanbanCardProps) {
	const displayTitle = row.branch ? humanizeBranch(row.branch) : row.title;
	const { attributes, isDragging, listeners, setNodeRef } = useDraggable({
		id: row.id,
		data: {
			columnId: row.status,
			type: "kanban-card",
		},
	});

	return (
		<div
			ref={setNodeRef}
			aria-label={displayTitle}
			data-workspace-id={row.id}
			className={cn(
				"relative block w-full touch-none rounded-lg transition-opacity duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50",
				"cursor-grab active:cursor-grabbing",
				isDragging && !settling && "opacity-25",
				settling && "pointer-events-none",
				className,
			)}
			{...attributes}
			{...listeners}
		>
			<KanbanCardPreview row={row} />
		</div>
	);
});

export function KanbanCardPreview({
	className,
	row,
}: {
	className?: string;
	row: WorkspaceRow;
}) {
	const displayTitle = row.branch ? humanizeBranch(row.branch) : row.title;
	const branchTone = getWorkspaceBranchTone({
		workspaceState: row.state,
		status: row.status,
	});

	return (
		<div
			className={cn(
				"flex w-full flex-col gap-2 rounded-lg border border-border/70 bg-card px-3 py-2 text-left opacity-100 shadow-xs transition-[background-color,border-color,box-shadow]",
				"hover:border-border hover:bg-accent/35",
				className,
			)}
		>
			<div className="flex min-w-0 items-start gap-2">
				<WorkspaceAvatar
					repoIconSrc={row.repoIconSrc}
					repoInitials={row.repoInitials ?? row.avatar ?? null}
					repoName={row.repoName}
					title={displayTitle}
					className="mt-0.5 size-6 rounded-md"
					fallbackClassName="text-[9px]"
				/>
				<div className="min-w-0 flex-1">
					<div className="flex min-w-0 items-center gap-1.5">
						<span className="truncate text-[13px] font-medium leading-5 text-foreground">
							{displayTitle}
						</span>
						{row.pinnedAt ? (
							<Pin
								aria-label="Pinned"
								className="-rotate-45 size-3 shrink-0 text-muted-foreground"
								strokeWidth={2}
							/>
						) : null}
					</div>
					{row.repoName ? (
						<div className="truncate text-[11px] leading-4 text-muted-foreground">
							{row.repoName}
						</div>
					) : null}
				</div>
			</div>

			<div className="flex min-w-0 items-center justify-between gap-2 text-[11px] text-muted-foreground">
				<div className="flex min-w-0 items-center gap-1.5">
					<GitBranch
						className={cn("size-3 shrink-0", branchToneClasses[branchTone])}
						strokeWidth={2}
					/>
					<span className="truncate">
						{row.branch ? humanizeBranch(row.branch) : "No branch"}
					</span>
				</div>
				{row.sessionCount || row.messageCount ? (
					<div className="flex shrink-0 items-center gap-1">
						<MessageSquare className="size-3" strokeWidth={2} />
						<span>{row.sessionCount ?? row.messageCount}</span>
					</div>
				) : null}
			</div>
		</div>
	);
}
