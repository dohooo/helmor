import { ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

import { FileIcon } from "./file-icon";
import type { ChangeStatusLetter } from "./hooks/use-changed-paths";

interface Props {
	name: string;
	kind: "file" | "directory";
	depth: number;
	expanded?: boolean;
	active?: boolean;
	onClick: () => void;
	onContextMenu?: (event: React.MouseEvent) => void;
	changeStatus?: ChangeStatusLetter;
}

const STATUS_COLOR_CLASS: Record<ChangeStatusLetter, string> = {
	M: "text-amber-500",
	A: "text-emerald-500",
	D: "text-red-500",
};

export function TreeRow({
	name,
	kind,
	depth,
	expanded,
	active,
	onClick,
	onContextMenu,
	changeStatus,
}: Props) {
	const changeTone = changeStatus ? STATUS_COLOR_CLASS[changeStatus] : null;
	return (
		<button
			type="button"
			onClick={onClick}
			onContextMenu={onContextMenu}
			data-active={active ? "true" : "false"}
			className={cn(
				"group flex h-6 w-full items-center gap-1 rounded-sm pr-2 text-left text-[12.5px] cursor-pointer",
				"hover:bg-accent/60",
				active && "bg-accent text-accent-foreground",
			)}
			style={{ paddingLeft: 6 + depth * 12 }}
		>
			{kind === "directory" ? (
				<ChevronRight
					className={cn(
						"size-3 shrink-0 text-muted-foreground transition-transform",
						expanded && "rotate-90",
					)}
					strokeWidth={2}
				/>
			) : (
				<span className="size-3 shrink-0" />
			)}
			<FileIcon name={name} kind={kind} />
			<span className={cn("truncate", changeTone)}>{name}</span>
			{changeStatus ? (
				<span
					className={cn(
						"ml-auto shrink-0 pl-2 text-[10.5px] font-semibold tabular-nums",
						changeTone,
					)}
					aria-label={`${changeStatus} status`}
				>
					{changeStatus}
				</span>
			) : null}
		</button>
	);
}
