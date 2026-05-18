import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Pure-UI shell for the inspector pane — the right-side `aside` container
 * that hosts Changes / Actions / Setup-Run sections in vertical stack.
 * Mirrors the outer container the real `InspectorPanel` renders.
 */
export function InspectorShellUI({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<aside
			className={cn(
				"relative flex h-full w-full flex-col overflow-hidden bg-sidebar",
				className,
			)}
		>
			{children}
		</aside>
	);
}
