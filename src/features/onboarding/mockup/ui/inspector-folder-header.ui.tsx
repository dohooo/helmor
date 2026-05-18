import { ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Pure-UI folder/group header inside the Changes section — chevron + icon +
 * label + count badge. Mirrors the "Remote" / "Local" row at the top of the
 * tree in `ChangesSection`.
 */
export type InspectorFolderHeaderUIProps = {
	icon: ReactNode;
	label: string;
	count: number;
	open: boolean;
	onToggle?: () => void;
	rightSlot?: ReactNode;
};

export function InspectorFolderHeaderUI({
	icon,
	label,
	count,
	open,
	onToggle,
	rightSlot,
}: InspectorFolderHeaderUIProps) {
	return (
		<div className="group/header flex w-full items-center gap-1 py-1 pl-1 pr-2 text-[11.5px] font-semibold tracking-[-0.01em] text-muted-foreground">
			<Button
				type="button"
				variant="ghost"
				size="xs"
				onClick={onToggle}
				aria-expanded={open}
				className="h-auto min-w-0 flex-1 justify-start gap-1 rounded-none px-0 text-left hover:bg-transparent hover:text-foreground dark:hover:bg-transparent aria-expanded:bg-transparent aria-expanded:text-foreground"
			>
				<ChevronRightIcon
					data-icon="inline-start"
					className={cn(
						"size-3 shrink-0 transition-transform",
						open && "rotate-90",
					)}
					strokeWidth={2}
				/>
				{icon}
				<span className="truncate">{label}</span>
			</Button>
			{rightSlot}
			<Badge
				variant="secondary"
				className="h-4 min-w-[16px] justify-center rounded-full px-1 text-[9.5px] leading-none"
			>
				{count}
			</Badge>
		</div>
	);
}
