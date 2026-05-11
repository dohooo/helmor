import { ChevronsDownUp, FilePlus, FolderPlus, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface Props {
	onCreateFile: () => void;
	onCreateFolder: () => void;
	onRefresh: () => void;
	onCollapseAll: () => void;
	isRefreshing?: boolean;
}

export function ExplorerHeader({
	onCreateFile,
	onCreateFolder,
	onRefresh,
	onCollapseAll,
	isRefreshing,
}: Props) {
	return (
		<div className="flex h-5 shrink-0 items-center justify-between pr-0.5 pl-2">
			<span className="text-[9.5px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
				Explorer
			</span>
			<div className="flex items-center gap-0">
				<HeaderIconButton label="New File" onClick={onCreateFile}>
					<FilePlus className="size-3" strokeWidth={1.8} />
				</HeaderIconButton>
				<HeaderIconButton label="New Folder" onClick={onCreateFolder}>
					<FolderPlus className="size-3" strokeWidth={1.8} />
				</HeaderIconButton>
				<HeaderIconButton label="Refresh Explorer" onClick={onRefresh}>
					<RefreshCw
						className={cn("size-3", isRefreshing && "animate-spin")}
						strokeWidth={1.8}
					/>
				</HeaderIconButton>
				<HeaderIconButton label="Collapse Folders" onClick={onCollapseAll}>
					<ChevronsDownUp className="size-3" strokeWidth={1.8} />
				</HeaderIconButton>
			</div>
		</div>
	);
}

function HeaderIconButton({
	label,
	onClick,
	children,
}: {
	label: string;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="icon-xs"
					aria-label={label}
					onClick={onClick}
					className="size-5 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
				>
					{children}
				</Button>
			</TooltipTrigger>
			<TooltipContent
				side="bottom"
				className="flex h-[24px] items-center rounded-md px-2 text-[12px] leading-none"
			>
				{label}
			</TooltipContent>
		</Tooltip>
	);
}
