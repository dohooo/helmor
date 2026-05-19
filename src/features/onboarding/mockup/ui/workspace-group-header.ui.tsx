import { Archive, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { GroupIcon, type GroupTone } from "./shared";

/**
 * Pure-UI button for a workspace group header in the sidebar
 * (e.g. "In progress 2", "Backlog 1", "Archived").
 *
 * Used by:
 * - the real `WorkspacesSidebar` virtualizer when rendering a `group-header` row
 * - the onboarding mockup, which renders a static list of groups
 */
export type WorkspaceGroupHeaderUIProps = {
	label: string;
	count: number;
	tone: GroupTone;
	isOpen: boolean;
	canCollapse: boolean;
	isArchivedSection?: boolean;
	onToggle?: () => void;
};

export function WorkspaceGroupHeaderUI({
	label,
	count,
	tone,
	isOpen,
	canCollapse,
	isArchivedSection = false,
	onToggle,
}: WorkspaceGroupHeaderUIProps) {
	const isEmptyGroup = count === 0;
	return (
		<button
			type="button"
			className={cn(
				"group/trigger flex w-full select-none items-center justify-between rounded-lg px-2 text-[13px] font-semibold tracking-[-0.01em] text-foreground hover:bg-accent/60",
				"py-1",
				canCollapse ? "cursor-interactive" : "cursor-default",
			)}
			data-empty-group={isEmptyGroup ? "true" : "false"}
			disabled={!canCollapse}
			onClick={onToggle}
		>
			<span className="flex items-center gap-2">
				{isArchivedSection ? (
					<Archive
						className="size-[14px] shrink-0 text-[var(--workspace-sidebar-status-backlog)]"
						strokeWidth={1.9}
					/>
				) : (
					<GroupIcon tone={tone} />
				)}
				<span>{label}</span>
			</span>

			{count > 0 ? (
				<span className="relative flex h-5 min-w-5 items-center justify-center">
					<Badge
						variant="secondary"
						className="h-4 min-w-[16px] justify-center rounded-full px-1 text-[9.5px] leading-none transition-opacity group-hover/trigger:opacity-0"
					>
						{count}
					</Badge>
					<ChevronRight
						className={cn(
							"absolute left-1/2 top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 text-muted-foreground opacity-0 transition-all group-hover/trigger:opacity-100",
							isOpen && "rotate-90",
						)}
						strokeWidth={2}
					/>
				</span>
			) : null}
		</button>
	);
}
