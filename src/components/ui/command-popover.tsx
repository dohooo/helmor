import type * as React from "react";
import { Command } from "@/components/ui/command";
import { PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export function CommandPopoverContent({
	className,
	commandClassName,
	children,
	...props
}: React.ComponentProps<typeof PopoverContent> & {
	commandClassName?: string;
	children: React.ReactNode;
}) {
	return (
		<PopoverContent
			className={cn("overflow-hidden rounded-lg p-0", className)}
			{...props}
		>
			<Command className={cn("rounded-lg! bg-popover p-1", commandClassName)}>
				{children}
			</Command>
		</PopoverContent>
	);
}
