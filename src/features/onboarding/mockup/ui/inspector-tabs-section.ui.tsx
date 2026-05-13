import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { INSPECTOR_SECTION_HEADER_CLASS } from "./shared";

const INSPECTOR_TAB_BUTTON_CLASS =
	"relative inline-flex h-full cursor-interactive items-center justify-center gap-1.5 px-0 text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-0";

/**
 * Pure-UI Setup/Run tab strip header with optional chevron + body slot.
 * Mirrors the visible row at the top of the real `InspectorTabsSection` —
 * sans the hover-zoom / blur machinery and the actual terminal panes.
 */
export type InspectorTabsHeaderUIProps = {
	tabs: { id: string; label: string; icon?: ReactNode }[];
	activeTabId: string;
	onTabChange?: (id: string) => void;
	rightSlot?: ReactNode;
};

export function InspectorTabsHeaderUI({
	tabs,
	activeTabId,
	onTabChange,
	rightSlot,
}: InspectorTabsHeaderUIProps) {
	return (
		<div
			className={cn(
				INSPECTOR_SECTION_HEADER_CLASS,
				"relative z-10 items-stretch pt-0",
			)}
		>
			<div
				role="tablist"
				aria-orientation="horizontal"
				className="flex h-full self-stretch items-stretch gap-4"
			>
				{tabs.map((tab) => {
					const isActive = tab.id === activeTabId;
					return (
						<button
							key={tab.id}
							type="button"
							role="tab"
							aria-selected={isActive}
							tabIndex={isActive ? 0 : -1}
							className={cn(
								INSPECTOR_TAB_BUTTON_CLASS,
								isActive && "text-foreground",
							)}
							onClick={() => onTabChange?.(tab.id)}
						>
							{tab.icon}
							{tab.label}
							<span
								aria-hidden="true"
								className={cn(
									"pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-foreground opacity-0 transition-opacity",
									isActive && "opacity-100",
								)}
							/>
						</button>
					);
				})}
			</div>
			{rightSlot ?? <ChevronDown className="size-3.5 text-muted-foreground" />}
		</div>
	);
}

/**
 * The empty-state pane placed inside the tabs body when there's nothing to
 * show — used by the onboarding mockup to display "Repository setup is ready"
 * with a centered icon.
 */
export function InspectorTabsEmptyStateUI({
	icon,
	message,
}: {
	icon: ReactNode;
	message: string;
}) {
	return (
		<div className="flex min-h-0 flex-1 items-center justify-center bg-muted/10 px-4 text-center text-[11px] leading-5 text-muted-foreground">
			<div>
				<div className="mx-auto mb-2 flex justify-center">{icon}</div>
				{message}
			</div>
		</div>
	);
}

/**
 * Terminal-style log pane shown inside the Setup/Run tab body when a script is
 * running. Mockup-only — kept here so the onboarding preview can render a
 * realistic stream of setup output without pulling in the production terminal
 * machinery.
 *
 * Each entry is one line:
 *   - `cmd`     → prefixed with `$ ` and rendered in foreground (the command).
 *   - `step`    → prefixed with `↳ ` (an in-progress step the script ran).
 *   - `success` → prefixed with `✓ ` and rendered in chart-2 green (a result).
 */
export type InspectorTabsLogEntry =
	| { kind: "cmd"; text: string }
	| { kind: "step"; text: string }
	| { kind: "success"; text: string };

export function InspectorTabsLogsUI({
	entries,
}: {
	entries: InspectorTabsLogEntry[];
}) {
	return (
		<div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-hidden bg-muted/10 px-3 py-2 font-mono text-[10.5px] leading-[14px] text-muted-foreground">
			{entries.map((entry, i) => {
				if (entry.kind === "cmd") {
					return (
						<div key={i} className="text-foreground">
							$ {entry.text}
						</div>
					);
				}
				if (entry.kind === "success") {
					return (
						<div key={i} className="text-chart-2">
							✓ {entry.text}
						</div>
					);
				}
				return <div key={i}>↳ {entry.text}</div>;
			})}
		</div>
	);
}
