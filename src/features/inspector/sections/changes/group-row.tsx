import {
	ChevronRightIcon,
	ListIcon,
	ListTreeIcon,
	LoaderCircleIcon,
	MinusIcon,
	PlusIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { RowIconButton } from "./row-primitives";
import type { ChangeListGroup } from "./types";

export function ChangeGroupHeaderRow({ group }: { group: ChangeListGroup }) {
	const { action, onBatchAction } = group;

	return (
		<div className="group/header flex h-6 w-full items-center gap-1 py-1 pl-1 pr-2 text-mini font-semibold tracking-[-0.01em] text-muted-foreground">
			<Button
				type="button"
				variant="ghost"
				size="xs"
				onClick={group.onToggle}
				aria-expanded={group.open}
				className="h-auto min-w-0 flex-1 justify-start gap-1 rounded-none px-0 text-left hover:bg-transparent hover:text-foreground dark:hover:bg-transparent aria-expanded:bg-transparent aria-expanded:text-foreground"
			>
				<ChevronRightIcon
					data-icon="inline-start"
					className={cn(
						"size-3 shrink-0 transition-transform",
						group.open && "rotate-90",
					)}
					strokeWidth={2}
				/>
				{group.icon}
				<span className="truncate">{group.label}</span>
			</Button>
			<ViewToggleButton
				treeView={group.treeView}
				onToggle={group.onToggleTreeView}
			/>
			{onBatchAction && action && (
				<RowIconButton
					aria-label={
						action === "stage" ? "Stage all changes" : "Unstage all changes"
					}
					onClick={onBatchAction}
					className="text-transparent hover:bg-transparent group-hover/header:text-muted-foreground group-hover/header:hover:text-foreground"
				>
					{action === "stage" ? (
						<PlusIcon className="size-3.5" strokeWidth={2} />
					) : (
						<MinusIcon className="size-3.5" strokeWidth={2} />
					)}
				</RowIconButton>
			)}
			<Badge
				variant="secondary"
				className="h-4 min-w-[16px] justify-center rounded-full px-1 text-nano leading-none"
			>
				{group.loading ? (
					<LoaderCircleIcon className="size-2.5 animate-spin" />
				) : (
					group.count
				)}
			</Badge>
		</div>
	);
}

function ViewToggleButton({
	treeView,
	onToggle,
}: {
	treeView: boolean;
	onToggle: () => void;
}) {
	return (
		<RowIconButton
			aria-label={treeView ? "Switch to list view" : "Switch to tree view"}
			onClick={onToggle}
			className="text-transparent hover:bg-transparent group-hover/header:text-muted-foreground group-hover/header:hover:text-foreground"
		>
			{treeView ? (
				<ListIcon className="size-3.5" strokeWidth={1.8} />
			) : (
				<ListTreeIcon className="size-3.5" strokeWidth={1.8} />
			)}
		</RowIconButton>
	);
}
