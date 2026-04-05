import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "./ui/collapsible";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";

const DEFAULT_CHANGES_HEIGHT = 120;
const DEFAULT_ACTIONS_HEIGHT = 120;
const MIN_SECTION_HEIGHT = 48;
const RESIZE_HIT_AREA = 8;

export function WorkspaceInspectorSidebar() {
	const [tabsOpen, setTabsOpen] = useState(true);
	const [activeTab, setActiveTab] = useState("setup");
	const [changesHeight, setChangesHeight] = useState(DEFAULT_CHANGES_HEIGHT);
	const [actionsHeight, setActionsHeight] = useState(DEFAULT_ACTIONS_HEIGHT);
	const [resizeState, setResizeState] = useState<{
		pointerY: number;
		initialChangesHeight: number;
		initialActionsHeight: number;
		target: "actions" | "tabs";
	} | null>(null);

	const isResizing = resizeState !== null;
	const isActionsResizing = resizeState?.target === "actions";
	const isTabsResizing = resizeState?.target === "tabs";

	useEffect(() => {
		if (!resizeState) return;

		const handleMouseMove = (event: globalThis.MouseEvent) => {
			const deltaY = event.clientY - resizeState.pointerY;

			if (resizeState.target === "actions") {
				const nextChanges = Math.max(
					MIN_SECTION_HEIGHT,
					resizeState.initialChangesHeight + deltaY,
				);
				const actualDelta = nextChanges - resizeState.initialChangesHeight;
				const nextActions = Math.max(
					MIN_SECTION_HEIGHT,
					resizeState.initialActionsHeight - actualDelta,
				);
				setChangesHeight(nextChanges);
				setActionsHeight(nextActions);
			} else {
				setActionsHeight(
					Math.max(
						MIN_SECTION_HEIGHT,
						resizeState.initialActionsHeight + deltaY,
					),
				);
			}
		};

		const handleMouseUp = () => {
			setResizeState(null);
		};

		const previousCursor = document.body.style.cursor;
		const previousUserSelect = document.body.style.userSelect;
		document.body.style.cursor = "ns-resize";
		document.body.style.userSelect = "none";

		window.addEventListener("mousemove", handleMouseMove);
		window.addEventListener("mouseup", handleMouseUp);

		return () => {
			document.body.style.cursor = previousCursor;
			document.body.style.userSelect = previousUserSelect;
			window.removeEventListener("mousemove", handleMouseMove);
			window.removeEventListener("mouseup", handleMouseUp);
		};
	}, [resizeState]);

	const handleResizeStart = useCallback(
		(target: "actions" | "tabs") =>
			(event: React.MouseEvent<HTMLDivElement>) => {
				event.preventDefault();
				setResizeState({
					pointerY: event.clientY,
					initialChangesHeight: changesHeight,
					initialActionsHeight: actionsHeight,
					target,
				});
			},
		[changesHeight, actionsHeight],
	);

	return (
		<div
			className={cn(
				"flex h-full min-h-0 flex-col border-l border-app-border/70 bg-app-sidebar",
				isResizing && "select-none",
			)}
		>
			<StaticSection title="Changes" bodyHeight={changesHeight} />

			<HorizontalResizeHandle
				onMouseDown={handleResizeStart("actions")}
				isActive={isActionsResizing}
			/>

			<StaticSection title="Actions" bodyHeight={actionsHeight} />

			<HorizontalResizeHandle
				onMouseDown={handleResizeStart("tabs")}
				isActive={isTabsResizing}
			/>

			<Collapsible
				open={tabsOpen}
				onOpenChange={setTabsOpen}
				className={cn(
					"mt-auto flex min-h-0 flex-col",
					tabsOpen ? "flex-1" : null,
				)}
			>
				<section
					aria-label="Inspector section Tabs"
					className={cn(
						"flex min-h-0 flex-col border-b border-app-border/60 bg-app-sidebar",
						tabsOpen ? "flex-1" : null,
					)}
				>
					<Tabs
						value={activeTab}
						onValueChange={setActiveTab}
						className="flex min-h-0 flex-1 flex-col gap-0"
					>
						<div className="flex h-9 min-w-0 items-center border-b border-app-border/60 bg-app-base/[0.3] pl-1.5 pr-2">
							<CollapsibleTrigger
								aria-label="Toggle inspector tabs section"
								className="group/trigger mr-1 flex size-7 shrink-0 items-center justify-center rounded-md text-app-foreground-soft outline-none transition-colors hover:bg-app-foreground/[0.04]"
							>
								<span className="flex size-3.5 items-center justify-center transition-transform group-data-[panel-open]/trigger:rotate-0 group-data-[panel-closed]/trigger:-rotate-90">
									<ChevronDown className="size-3.5" strokeWidth={1.9} />
								</span>
							</CollapsibleTrigger>

							<TabsList
								variant="line"
								className="h-9 gap-0 border-none bg-transparent p-0"
							>
								<TabsTrigger
									value="setup"
									variant="line"
									className="h-9 w-auto gap-0 px-2.5 text-[12px] font-medium text-app-foreground-soft data-[state=active]:border-app-foreground-soft/80 data-[state=active]:bg-transparent data-[state=active]:text-app-foreground"
								>
									Setup
								</TabsTrigger>
								<TabsTrigger
									value="run"
									variant="line"
									className="h-9 w-auto gap-0 px-2.5 text-[12px] font-medium text-app-foreground-soft data-[state=active]:border-app-foreground-soft/80 data-[state=active]:bg-transparent data-[state=active]:text-app-foreground"
								>
									Run
								</TabsTrigger>
							</TabsList>
						</div>

						{tabsOpen ? (
							<CollapsibleContent className="flex min-h-0 flex-1 flex-col">
								<div
									aria-label="Inspector tabs body"
									className="min-h-[12rem] flex-1 bg-app-base/[0.16]"
								/>
							</CollapsibleContent>
						) : null}
					</Tabs>
				</section>
			</Collapsible>
		</div>
	);
}

function HorizontalResizeHandle({
	onMouseDown,
	isActive,
}: {
	onMouseDown: (event: React.MouseEvent<HTMLDivElement>) => void;
	isActive: boolean;
}) {
	return (
		<div
			role="separator"
			aria-orientation="horizontal"
			aria-valuenow={0}
			onMouseDown={onMouseDown}
			className="group relative z-10 cursor-ns-resize touch-none"
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
						? "h-[2px] bg-app-foreground/80 shadow-[0_0_12px_rgba(250,249,246,0.2)]"
						: "h-px bg-transparent group-hover:h-[2px] group-hover:bg-app-foreground-soft/75 group-hover:shadow-[0_0_10px_rgba(250,249,246,0.08)]"
				}`}
			/>
		</div>
	);
}

function StaticSection({
	bodyHeight,
	title,
}: {
	bodyHeight: number;
	title: string;
}) {
	return (
		<section
			aria-label={`Inspector section ${title}`}
			className="flex min-h-0 flex-col border-b border-app-border/60 bg-app-sidebar"
		>
			<div className="flex h-9 min-w-0 items-center border-b border-app-border/60 bg-app-base/[0.3] px-3">
				<span className="inline-flex h-9 items-center text-[12px] font-medium tracking-[-0.01em] text-app-foreground-soft">
					{title}
				</span>
			</div>

			<div
				aria-label={`${title} panel body`}
				className="bg-app-base/[0.16]"
				style={{ height: `${bodyHeight}px` }}
			/>
		</section>
	);
}
