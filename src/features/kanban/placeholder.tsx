import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

export function KanbanPlaceholder({
	className,
	fadeMs,
	height,
	phase = "in",
}: {
	className?: string;
	fadeMs?: number;
	height: number | null;
	phase?: "in" | "out";
}) {
	return (
		<div
			aria-hidden="true"
			className={cn(
				phase === "out"
					? "kanban-drop-placeholder-out"
					: "kanban-drop-placeholder",
				"rounded-lg border border-dashed border-primary/30",
				className,
			)}
			style={
				fadeMs || height
					? ({
							...(fadeMs
								? { "--kanban-placeholder-fade-ms": `${fadeMs}ms` }
								: {}),
							...(height
								? { "--kanban-placeholder-height": `${height}px` }
								: {}),
						} as CSSProperties)
					: undefined
			}
		/>
	);
}
