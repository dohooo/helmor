import { ChevronRightIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { getCachedFolderIcon } from "./row-primitives";

const GROUP_BODY_INDENT_PX = 12;

export function ChangeFolderRow({
	name,
	path,
	depth,
	open,
	onToggle,
	interactionsEnabled = true,
}: {
	name: string;
	path: string;
	depth: number;
	open: boolean;
	onToggle: (path: string) => void;
	interactionsEnabled?: boolean;
}) {
	return (
		<div
			className={cn(
				"flex h-[21px] items-center gap-1 py-[1.5px] pr-2 text-muted-foreground",
				interactionsEnabled
					? "cursor-interactive transition-colors hover:bg-accent/60"
					: "cursor-default",
			)}
			style={{
				paddingLeft: `${GROUP_BODY_INDENT_PX + depth * 12 + 8}px`,
			}}
			onClick={() => onToggle(path)}
			onKeyDown={(event) => {
				if (event.key === "Enter" || event.key === " ") {
					onToggle(path);
				}
			}}
			tabIndex={0}
			role="treeitem"
			aria-expanded={open}
		>
			<ChevronRightIcon
				className={cn(
					"size-3 shrink-0 transition-transform",
					open && "rotate-90",
				)}
				strokeWidth={1.8}
			/>
			<img
				src={getCachedFolderIcon(name, open)}
				alt=""
				className="size-4 shrink-0"
			/>
			<span className="truncate">{name}</span>
		</div>
	);
}
