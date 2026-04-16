import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function ComposerButton({
	children,
	className,
	...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
	children: ReactNode;
	className?: string;
}) {
	return (
		<Button
			{...props}
			variant="ghost"
			size="xs"
			className={cn(
				"rounded-[9px] text-muted-foreground hover:text-foreground",
				className,
			)}
		>
			{children}
		</Button>
	);
}
