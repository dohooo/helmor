import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Pure-UI single-line tool-call row used as the collapsed/static preview of
 * a tool invocation (e.g. `Edit src/features/onboarding/mockup/index.tsx`).
 *
 * The real `AssistantToolCall` (in `tool-call.tsx`) is a multi-state component
 * with streaming status, child content, and expansion — this `.ui.tsx` only
 * captures the simplest collapsed visual that the onboarding mockup needs.
 */
export function ToolCallRowUI({
	icon,
	name,
	detail,
	className,
}: {
	icon: ReactNode;
	name: string;
	detail?: ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"my-1 flex w-fit max-w-full items-center gap-2 rounded-md bg-accent/35 px-2.5 py-1.5 text-[12px] text-muted-foreground",
				className,
			)}
		>
			{icon}
			<span className="font-medium text-foreground">{name}</span>
			{detail ? (
				<span className="truncate font-mono text-[11px]">{detail}</span>
			) : null}
		</div>
	);
}
