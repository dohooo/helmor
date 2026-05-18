import { Plus } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Pure-UI session tab visual — provider icon + truncated title + optional
 * unread/interaction-required dot. Mirrors the visible shape of a tab inside
 * the real `WorkspacePanelHeader` (sans editing/Tooltip/hover-actions).
 *
 * Used directly by the onboarding mockup. The real header still wraps tabs in
 * Radix `Tabs` + `Tooltip` + edit/close actions, so it does not import this
 * file — but the className footprint is kept in sync.
 */
export type SessionTabUIProps = {
	icon: ReactNode;
	title: string;
	selected?: boolean;
	hasStatusDot?: boolean;
	statusTone?: "unread" | "interaction-required";
};

export function SessionTabUI({
	icon,
	title,
	selected = false,
	hasStatusDot = false,
	statusTone = "unread",
}: SessionTabUIProps) {
	return (
		<div
			data-state={selected ? "active" : "inactive"}
			className={cn(
				"group/tab relative inline-flex h-[1.85rem] w-auto min-w-[6.5rem] max-w-[14rem] shrink-0 flex-none items-center justify-start gap-1.5 overflow-hidden rounded-md px-2 pr-5 text-[13px] text-muted-foreground",
				selected && "bg-muted text-foreground",
			)}
		>
			<span className="tab-content-fade flex min-w-0 flex-1 items-center gap-1.5">
				{icon}
				<span
					className={cn(
						"truncate font-medium",
						hasStatusDot && !selected ? "text-foreground" : undefined,
					)}
				>
					{title}
				</span>
				{hasStatusDot ? (
					<span
						aria-label={
							statusTone === "interaction-required"
								? "Interaction required"
								: "Unread session"
						}
						className={cn(
							"size-1.5 shrink-0 rounded-full",
							statusTone === "interaction-required"
								? "bg-yellow-500"
								: "bg-chart-2",
						)}
					/>
				) : null}
			</span>
		</div>
	);
}

/**
 * Pure-UI scrollable session-tab strip wrapper. Lays out tabs left and a
 * "new session" plus button on the right.
 */
export function SessionTabsRowUI({
	tabs,
	onNewSession,
	rightSlot,
}: {
	tabs: ReactNode;
	onNewSession?: () => void;
	rightSlot?: ReactNode;
}) {
	return (
		<div className="flex items-center px-4 pb-1">
			<div className="group/tabs-scroll relative min-w-0 flex-1">
				<div className="scrollbar-none flex min-w-0 flex-1 gap-1 overflow-x-auto">
					{tabs}
				</div>
			</div>
			{onNewSession ? (
				<Button
					aria-label="New session"
					onClick={onNewSession}
					variant="ghost"
					size="icon-sm"
					className="ml-0.5 shrink-0 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
				>
					<Plus className="size-3.5" strokeWidth={1.8} />
				</Button>
			) : null}
			{rightSlot}
		</div>
	);
}
