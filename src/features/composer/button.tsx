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
			size="sm"
			className={cn(
				"h-auto gap-1.5 rounded-lg text-muted-foreground hover:text-foreground",
				className,
			)}
		>
			{children}
		</Button>
	);
}
