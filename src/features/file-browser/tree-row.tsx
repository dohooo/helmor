import { ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

import { FileIcon } from "./file-icon";

interface Props {
	name: string;
	kind: "file" | "directory";
	depth: number;
	expanded?: boolean;
	active?: boolean;
	onClick: () => void;
	onContextMenu?: (event: React.MouseEvent) => void;
}

export function TreeRow({
	name,
	kind,
	depth,
	expanded,
	active,
	onClick,
	onContextMenu,
}: Props) {
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
			<FileIcon name={name} kind={kind} open={expanded} />
			<span className="truncate">{name}</span>
		</button>
	);
}
