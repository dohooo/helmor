import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { WorkspaceCommitButtonMode } from "@/features/commit/button";
import { cn } from "@/lib/utils";

export const MIN_SECTION_HEIGHT = 48;
export const RESIZE_HIT_AREA = 10;
export const TABS_ANIMATION_MS = 350;
export const TABS_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";

export const INSPECTOR_SECTION_HEADER_CLASS =
	"flex h-8 min-w-0 shrink-0 items-center justify-between border-b border-border/60 bg-muted/25 px-3 pt-[2px]";
export const INSPECTOR_SECTION_TITLE_CLASS =
	"inline-flex h-9 items-center text-[13px] font-medium tracking-[-0.01em] leading-none text-muted-foreground";

export function getGitSectionHeaderHighlightClass(
	mode: WorkspaceCommitButtonMode,
) {
	switch (mode) {
		case "fix":
			return "bg-[var(--workspace-pr-closed-header-bg)]";
		case "resolve-conflicts":
			return null;
		case "open-pr":
			return null;
		case "merge":
			return "bg-[var(--workspace-pr-open-header-bg)]";
		case "merged":
			return "bg-[var(--workspace-pr-merged-header-bg)]";
		case "closed":
			return "bg-[var(--workspace-pr-closed-header-bg)]";
		default:
			return null;
	}
}

type InspectorTabsSectionProps = {
	wrapperRef: React.RefObject<HTMLDivElement | null>;
	open: boolean;
	onToggle: () => void;
	activeTab: string;
	onTabChange: (tab: string) => void;
	children?: React.ReactNode;
};

export function InspectorTabsSection({
	wrapperRef,
	open,
	onToggle,
	activeTab,
	onTabChange,
	children,
}: InspectorTabsSectionProps) {
	return (
		<div
			ref={wrapperRef}
			className={cn("flex min-h-0 shrink-0 flex-col", open && "flex-1")}
		>
			<section
				aria-label="Inspector section Tabs"
				className={cn(
					"relative flex min-h-0 shrink-0 flex-col overflow-hidden border-b border-border/60 bg-sidebar",
					open && "flex-1",
				)}
			>
				<Tabs
					value={activeTab}
					onValueChange={onTabChange}
					className={cn("flex min-h-0 flex-col gap-0", open && "flex-1")}
				>
					<div
						className={cn(INSPECTOR_SECTION_HEADER_CLASS, "relative z-10 pt-0")}
					>
						<TabsList
							variant="line"
							className="h-8 gap-4 border-none bg-transparent p-0"
						>
							<TabsTrigger
								value="setup"
								className="h-8 w-auto gap-0 border-transparent px-0 text-[12px] font-medium text-muted-foreground after:bottom-[-1px] focus-visible:border-transparent focus-visible:ring-0 focus-visible:outline-none data-[state=active]:bg-transparent data-[state=active]:text-foreground"
							>
								Setup
							</TabsTrigger>
							<TabsTrigger
								value="run"
								className="h-8 w-auto gap-0 border-transparent px-0 text-[12px] font-medium text-muted-foreground after:bottom-[-1px] focus-visible:border-transparent focus-visible:ring-0 focus-visible:outline-none data-[state=active]:bg-transparent data-[state=active]:text-foreground"
							>
								Run
							</TabsTrigger>
						</TabsList>
						<Button
							type="button"
							aria-label="Toggle inspector tabs section"
							onClick={onToggle}
							variant="ghost"
							size="icon-sm"
							className="ml-auto shrink-0 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
						>
							<ChevronDown
								className="size-3.5"
								strokeWidth={1.9}
								style={{
									transform: open ? "rotate(0deg)" : "rotate(-90deg)",
									transition: `transform ${TABS_ANIMATION_MS}ms ${TABS_EASING}`,
								}}
							/>
						</Button>
					</div>

					{open && (
						<div
							aria-label="Inspector tabs body"
							className="relative flex min-h-0 flex-1 flex-col bg-sidebar"
						>
							{children}
						</div>
					)}
				</Tabs>
			</section>
		</div>
	);
}

type HorizontalResizeHandleProps = {
	onMouseDown: (event: React.MouseEvent<HTMLDivElement>) => void;
	isActive: boolean;
};

export function HorizontalResizeHandle({
	onMouseDown,
	isActive,
}: HorizontalResizeHandleProps) {
	return (
		<div
			role="separator"
			aria-orientation="horizontal"
			aria-valuenow={0}
			onMouseDown={onMouseDown}
			className="group relative z-20 shrink-0 cursor-ns-resize touch-none"
			style={{
				height: `${RESIZE_HIT_AREA}px`,
				marginTop: `-${RESIZE_HIT_AREA / 2}px`,
				marginBottom: `-${RESIZE_HIT_AREA / 2}px`,
			}}
		>
			<span
				aria-hidden="true"
				className={`pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 transition-[height,background-color,box-shadow] ${
					isActive
						? "h-[2px] bg-foreground/80 shadow-[0_0_12px_rgba(0,0,0,0.12)] dark:shadow-[0_0_12px_rgba(255,255,255,0.16)]"
						: "h-px bg-border/75 group-hover:h-[2px] group-hover:bg-muted-foreground/75"
				}`}
			/>
		</div>
	);
}
