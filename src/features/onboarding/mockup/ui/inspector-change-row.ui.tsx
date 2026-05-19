import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { InspectorFileStatus } from "./shared";

const STATUS_COLORS: Record<InspectorFileStatus, string> = {
	M: "text-yellow-500",
	A: "text-green-500",
	D: "text-red-500",
};

/**
 * Pure-UI single change row inside the Changes section. Mirrors the row body
 * rendered by `ChangesSection` (file icon + file name + folder + line stats +
 * status letter). The real container additionally wires keyboard handlers,
 * staged/unstaged grouping, hover actions, and ShinyFlash on update.
 */
export type InspectorChangeRowUIProps = {
	name: string;
	path: string;
	status: InspectorFileStatus;
	icon: ReactNode;
	active?: boolean;
	insertions?: number | null;
	deletions?: number | null;
	onClick?: () => void;
};

export function InspectorChangeRowUI({
	name,
	path,
	status,
	icon,
	active = false,
	insertions = null,
	deletions = null,
	onClick,
}: InspectorChangeRowUIProps) {
	const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
	return (
		<div
			role={onClick ? "button" : undefined}
			tabIndex={onClick ? 0 : undefined}
			onClick={onClick}
			className={cn(
				"group/row flex items-center gap-1.5 py-[1.5px] pl-2 pr-2 text-muted-foreground transition-colors hover:bg-accent/60",
				onClick && "cursor-interactive",
				active && "bg-muted/60 text-foreground",
			)}
		>
			{icon}
			<span className="min-w-0 max-w-[60%] truncate">{name}</span>
			<span className="min-w-0 flex-1 truncate text-right text-[10px] text-muted-foreground">
				{folder}
			</span>
			<span className="flex shrink-0 items-center gap-1 tabular-nums">
				{insertions !== null || deletions !== null ? (
					<span className="text-[10px] tabular-nums">
						{insertions ? (
							<span className="text-green-500">+{insertions}</span>
						) : null}
						{insertions && deletions ? " " : null}
						{deletions ? (
							<span className="text-red-500">-{deletions}</span>
						) : null}
					</span>
				) : null}
				<span
					className={cn(
						"inline-flex h-4 w-4 items-center justify-center text-[10px] font-semibold",
						STATUS_COLORS[status],
					)}
				>
					{status}
				</span>
			</span>
		</div>
	);
}
