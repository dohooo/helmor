import type { ReactNode } from "react";
import type { PendingDeferredTool } from "@/features/conversation/pending-deferred-tool";
import { cn } from "@/lib/utils";
import type { DeferredToolResponseHandler } from "../deferred-tool";

export type DeferredToolPanelProps = {
	deferred: PendingDeferredTool;
	disabled?: boolean;
	onResponse: DeferredToolResponseHandler;
};

export function DeferredToolCard({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"mb-3 rounded-[16px] bg-background/80 px-2.5 py-2.5 ring-1 ring-inset ring-border/35 backdrop-blur-sm",
				className,
			)}
		>
			{children}
		</div>
	);
}

export function autosizeTextarea(element: HTMLTextAreaElement | null) {
	if (!element) return;
	element.style.height = "0px";
	element.style.height = `${element.scrollHeight}px`;
}

export const INLINE_TEXTAREA_CLASS =
	"min-h-0 resize-none overflow-hidden rounded-none border-0 !bg-transparent px-1 py-0.5 leading-5 shadow-none placeholder:text-muted-foreground/55 focus-visible:ring-0 disabled:!bg-transparent dark:!bg-transparent dark:disabled:!bg-transparent";
