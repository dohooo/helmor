import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { workspaceGroupsQueryOptions } from "@/lib/query-client";
import { KANBAN_COLUMNS, projectGroupsToKanbanColumns } from "./board-state";
import { KanbanColumn } from "./column";

export function KanbanPage() {
	const groupsQuery = useQuery(workspaceGroupsQueryOptions());
	const columns = useMemo(
		() => projectGroupsToKanbanColumns(groupsQuery.data ?? []),
		[groupsQuery.data],
	);

	return (
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
						label={column.label}
						tone={column.tone}
						rows={columns[column.id]}
					/>
				))}
			</div>
		</div>
	);
}
