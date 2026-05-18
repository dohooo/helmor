import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
	INSPECTOR_SECTION_HEADER_CLASS,
	INSPECTOR_SECTION_TITLE_CLASS,
} from "./shared";

/**
 * Pure-UI inspector section — the title bar plus body slot.
 * Consumes the same className constants the real sections use, so the visual
 * stays in lockstep with `ChangesSection` / `ActionsSection` / `SetupSection`.
 */
export function InspectorSectionUI({
	title,
	rightSlot,
	bodyClassName,
	children,
	containerClassName,
	headerClassName,
}: {
	title: ReactNode;
	rightSlot?: ReactNode;
	bodyClassName?: string;
	children: ReactNode;
	containerClassName?: string;
	headerClassName?: string;
}) {
	return (
		<section
			className={cn(
				"flex min-h-0 flex-col overflow-hidden border-b border-border/60 bg-sidebar",
				containerClassName,
			)}
		>
			<div className={cn(INSPECTOR_SECTION_HEADER_CLASS, headerClassName)}>
				<div className="flex min-w-0 items-center gap-2">
					{typeof title === "string" ? (
						<span className={INSPECTOR_SECTION_TITLE_CLASS}>{title}</span>
					) : (
						title
					)}
				</div>
				{rightSlot}
			</div>
			<div className={cn("min-h-0 flex-1 overflow-hidden", bodyClassName)}>
				{children}
			</div>
		</section>
	);
}
