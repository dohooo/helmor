import type { ReactElement, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

type BaseTooltipProps = {
	children: ReactElement;
	content: ReactNode;
	side?: "top" | "right" | "bottom" | "left";
	sideOffset?: number;
	align?: "start" | "center" | "end";
	className?: string;
};

export function BaseTooltip({
	children,
	content,
	side = "top",
	sideOffset = 8,
	align = "center",
	className,
}: BaseTooltipProps) {
	return (
		<Tooltip>
			<TooltipTrigger render={children} />
			<TooltipContent
				side={side}
				sideOffset={sideOffset}
				align={align}
				arrow={false}
				className={cn(
					"flex items-center rounded-md px-1.5 py-1 text-[11px] leading-none",
					className,
				)}
			>
				{content}
			</TooltipContent>
		</Tooltip>
	);
}
