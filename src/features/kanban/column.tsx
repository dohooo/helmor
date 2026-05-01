import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { GroupIcon } from "@/features/navigation/shared";
import type { GroupTone, WorkspaceRow } from "@/lib/api";
import { KanbanCard } from "./card";

type KanbanColumnProps = {
	label: string;
	tone: GroupTone;
	rows: WorkspaceRow[];
};

export function KanbanColumn({ label, tone, rows }: KanbanColumnProps) {
	return (
		<section
			aria-label={label}
			className="flex min-h-0 w-[280px] shrink-0 flex-col rounded-lg border border-border/60 bg-sidebar/60"
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
				<div className="flex min-h-20 w-full flex-col gap-2 rounded-md p-2">
					{rows.length > 0 ? (
						rows.map((row) => <KanbanCard key={row.id} row={row} />)
					) : (
						<div className="flex min-h-20 w-full items-center justify-center rounded-md border border-dashed border-border/70 text-[12px] text-muted-foreground">
							No workspaces
						</div>
					)}
				</div>
			</ScrollArea>
		</section>
	);
}
