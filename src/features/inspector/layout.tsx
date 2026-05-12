import { ChevronDown, Plus, X, ZoomIn, ZoomOut } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { createContext, useCallback, useContext } from "react";
import { Button } from "@/components/ui/button";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import type { WorkspaceCommitButtonMode } from "@/features/commit/button";
import { getShortcut } from "@/features/shortcuts/registry";
import { InlineShortcutDisplay } from "@/features/shortcuts/shortcut-display";
import { useSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import type { ScriptIconState } from "./hooks/use-script-status";
import { useHoverZoom } from "./layout/use-hover-zoom";
import { ScriptStatusIcon } from "./script-status-icon";
import {
	getTerminalDisplayTitle,
	type TerminalInstance,
} from "./terminal-store";

export const MIN_SECTION_HEIGHT = 48;
export const DEFAULT_TABS_BODY_HEIGHT = 128;
export const RESIZE_HIT_AREA = 10;
export const TABS_ANIMATION_MS = 350;
/** Apple-style easing — used consistently across panel toggle, chevron, and hover-zoom. */
export const TABS_EASING = "cubic-bezier(0.32, 0.72, 0, 1)";
export const TABS_EASING_CURVE = [0.32, 0.72, 0, 1] as const;

/** 300ms is the industry-standard hover-intent threshold (VSCode/Material). */
export const TABS_HOVER_ACTIVATION_MS = 300;
export const TABS_HOVER_TRANSITION_MS = 400;
/** 2x both axes — grows up-and-left from the bottom-right anchor. */
export const TABS_HOVER_ZOOM_MULTIPLIER = 2;
const TABS_BLUR_PEAK_PX = 6;
const TABS_BLUR_FADE_MS = 120;
/** Hold blur slightly past the transition so xterm's late re-fit stays hidden. */
export const TABS_BLUR_HOLD_UNTIL_MS = TABS_HOVER_TRANSITION_MS - 50;
/** 32px header (h-8) + 1px section border-b. */
export const INSPECTOR_SECTION_HEADER_HEIGHT = 33;
const TABS_WRAPPER_COLLAPSED_MIN_HEIGHT_PX = INSPECTOR_SECTION_HEADER_HEIGHT;

// Inspector layout persistence
export const INSPECTOR_ACTIONS_OPEN_STORAGE_KEY =
	"helmor.workspaceInspectorActionsOpen";
export const INSPECTOR_TABS_OPEN_STORAGE_KEY =
	"helmor.workspaceInspectorTabsOpen";
export const INSPECTOR_ACTIVE_TAB_STORAGE_KEY =
	"helmor.workspaceInspectorActiveTab";
export const INSPECTOR_CHANGES_HEIGHT_STORAGE_KEY =
	"helmor.workspaceInspectorChangesHeight";
export const INSPECTOR_TABS_HEIGHT_STORAGE_KEY =
	"helmor.workspaceInspectorTabsHeight";

export function getInitialActionsOpen(): boolean {
	if (typeof window === "undefined") {
		return true; // default: Actions open
	}
	try {
		const stored = window.localStorage.getItem(
			INSPECTOR_ACTIONS_OPEN_STORAGE_KEY,
		);
		if (!stored) return true;
		return stored === "true";
	} catch {
		return true;
	}
}

export function getInitialTabsOpen(): boolean {
	if (typeof window === "undefined") {
		return false; // default: Tabs collapsed
	}
	try {
		const stored = window.localStorage.getItem(INSPECTOR_TABS_OPEN_STORAGE_KEY);
		if (!stored) return false;
		return stored === "true";
	} catch {
		return false;
	}
}

export function getInitialActiveTab(): string {
	if (typeof window === "undefined") {
		return "setup";
	}
	try {
		const stored = window.localStorage.getItem(
			INSPECTOR_ACTIVE_TAB_STORAGE_KEY,
		);
		return stored || "setup";
	} catch {
		return "setup";
	}
}

export function getInitialChangesHeight(defaultHeight: number): number {
	if (typeof window === "undefined") {
		return defaultHeight;
	}
	try {
		const stored = window.localStorage.getItem(
			INSPECTOR_CHANGES_HEIGHT_STORAGE_KEY,
		);
		if (!stored) return defaultHeight;
		const parsed = Number.parseInt(stored, 10);
		return Number.isFinite(parsed) ? parsed : defaultHeight;
	} catch {
		return defaultHeight;
	}
}

export function getInitialTabsHeight(defaultHeight: number): number {
	if (typeof window === "undefined") {
		return defaultHeight;
	}
	try {
		const stored = window.localStorage.getItem(
			INSPECTOR_TABS_HEIGHT_STORAGE_KEY,
		);
		if (!stored) return defaultHeight;
		const parsed = Number.parseInt(stored, 10);
		return Number.isFinite(parsed) ? parsed : defaultHeight;
	} catch {
		return defaultHeight;
	}
}

export const INSPECTOR_SECTION_HEADER_CLASS =
	"flex h-8 min-w-0 shrink-0 items-center justify-between border-b border-border/60 bg-muted/25 px-3";
export const INSPECTOR_SECTION_TITLE_CLASS =
	"text-[13px] leading-8 font-medium tracking-[-0.01em] text-muted-foreground";
/** `px-3` + `gap-0` on tablist → uniform 24px gap between any two tabs. */
const INSPECTOR_TAB_BUTTON_CLASS =
	"relative inline-flex h-full cursor-pointer items-center justify-center gap-1.5 px-3 text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-0";

/** Zoom state published to tab bodies (e.g. corner Stop/Rerun button). */
type TabsZoomState = {
	/** True for the full duration of both expand and collapse animations. */
	isZoomPresented: boolean;
	/** Target of the CSS transition — true while zoomed in. */
	isHoverExpanded: boolean;
};

export const TabsZoomContext = createContext<TabsZoomState>({
	isZoomPresented: false,
	isHoverExpanded: false,
});

export function useTabsZoom(): TabsZoomState {
	return useContext(TabsZoomContext);
}

export function getGitSectionHeaderHighlightClass(
	mode: WorkspaceCommitButtonMode,
) {
	switch (mode) {
		case "fix":
			return "bg-[var(--workspace-pr-closed-header-bg)]";
		case "resolve-conflicts":
			return "bg-[var(--workspace-pr-conflicts-header-bg)]";
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
	/**
	 * Optional slot for tab-specific actions rendered on the right side of the
	 * header, just before the collapse/expand chevron. Used e.g. to expose the
	 * "Open dev server" shortcut while the Run script is live.
	 */
	tabActions?: React.ReactNode;
	setupScriptState: ScriptIconState;
	runScriptState: ScriptIconState;
	/**
	 * Live list of terminal sub-tabs for the current workspace. Each instance
	 * becomes a tab in the unified row, identified by `instance.id` as the
	 * activeTab value. Display labels are positional (`getTerminalDisplayTitle`).
	 */
	terminalInstances: TerminalInstance[];
	/** Spawn a new terminal and switch to it. */
	onAddTerminal: () => void;
	/** SIGTERM the shell and remove its tab. */
	onCloseTerminal: (instanceId: string) => void;
	/** Disable / enable the inspector's hover-to-zoom enlargement for a single
	 * terminal. */
	onToggleTerminalHoverZoom: (instanceId: string, disabled: boolean) => void;
	/** False when there's no repo/workspace context — disables the "+" button. */
	canSpawnTerminal: boolean;
	bodyHeight: number;
	/** Enables the height transition only for explicit panel toggles. */
	animatePanelToggle?: boolean;
	isResizing?: boolean;
	/**
	 * Gate for the hover-to-zoom effect. When false, hovering the body does
	 * nothing — used so we only zoom when there's actual terminal output worth
	 * enlarging (and not on the empty "Run setup" / "Open settings" placeholders).
	 */
	canHoverExpand: boolean;
	children?: React.ReactNode;
};

export function InspectorTabsSection({
	wrapperRef,
	open,
	onToggle,
	activeTab,
	onTabChange,
	tabActions,
	setupScriptState,
	runScriptState,
	terminalInstances,
	onAddTerminal,
	onCloseTerminal,
	onToggleTerminalHoverZoom,
	canSpawnTerminal,
	bodyHeight,
	animatePanelToggle = false,
	isResizing,
	canHoverExpand,
	children,
}: InspectorTabsSectionProps) {
	const { settings } = useSettings();
	const newTerminalShortcut = getShortcut(settings.shortcuts, "terminal.new");
	const shouldReduceMotion = useReducedMotion();
	const panelTransition = {
		duration:
			animatePanelToggle && !isResizing && !shouldReduceMotion
				? TABS_ANIMATION_MS / 1000
				: 0,
		ease: TABS_EASING_CURVE,
	};
	const chevronTransitionMs =
		animatePanelToggle && !shouldReduceMotion ? TABS_ANIMATION_MS : 0;

	const {
		isHoverExpanded,
		isZoomPresented,
		isContentBlurred,
		onBodyMouseEnter: handleBodyMouseEnter,
		onBodyMouseDown: handleBodyMouseDown,
		onContainerMouseEnter: handleContainerMouseEnter,
		onContainerMouseLeave: handleContainerMouseLeave,
		onTabContextMenuOpenChange: handleTabContextMenuOpenChange,
	} = useHoverZoom({ open, canHoverExpand });

	const zoomedSize = `${TABS_HOVER_ZOOM_MULTIPLIER * 100}%`;

	// Smart tab click: closed → open + activate; open + clicking the active
	// tab → collapse; open + different tab → just switch. Lets the user use
	// any tab as a toggle handle, not just the chevron.
	const handleTabClick = useCallback(
		(tabId: string) => {
			if (!open) {
				onTabChange(tabId);
				onToggle();
				return;
			}
			if (activeTab === tabId) {
				onToggle();
				return;
			}
			onTabChange(tabId);
		},
		[open, activeTab, onTabChange, onToggle],
	);

	// "+" / placeholder Terminal: spawning a terminal while the panel is
	// collapsed would create one the user can't see — pop the panel open too.
	const handleNewTerminalClick = useCallback(() => {
		if (!open) onToggle();
		onAddTerminal();
	}, [open, onAddTerminal, onToggle]);

	return (
		<motion.div
			ref={wrapperRef}
			className={cn(
				"relative flex min-h-0 shrink-0 flex-col",
				!isZoomPresented && "overflow-hidden",
			)}
			initial={false}
			animate={{
				height: TABS_WRAPPER_COLLAPSED_MIN_HEIGHT_PX + (open ? bodyHeight : 0),
			}}
			transition={panelTransition}
			style={{
				// The real content lives inside the absolutely-positioned child
				// below, which contributes nothing to layout. Reserve header
				// height when the panel is closed so the parent flex column
				// keeps a stable footprint for us.
				minHeight: `${TABS_WRAPPER_COLLAPSED_MIN_HEIGHT_PX}px`,
				willChange: isResizing ? undefined : "height",
			}}
		>
			<div
				data-tabs-zoomed={isZoomPresented ? "true" : undefined}
				onMouseEnter={handleContainerMouseEnter}
				onMouseLeave={handleContainerMouseLeave}
				className={cn(
					// `bg-sidebar` is the safety floor — it guarantees the zoomed
					// area never shows through to the content underneath even if
					// the inner section somehow doesn't cover the full box.
					"absolute right-0 bottom-0 flex flex-col bg-sidebar",
					// Lift the zoomed container above the inspector resize separator
					// (z-30), the inspector width handle (z-30), and the rest of the
					// sidebar so it's the top-most layer in the app shell. Tied to
					// `isZoomPresented` (not `isHoverExpanded`) so it stays elevated
					// for the whole collapse animation, not just the one frame
					// before the shrink kicks off.
					isZoomPresented && "z-50",
				)}
				style={{
					top: isHoverExpanded ? undefined : 0,
					width: isHoverExpanded ? zoomedSize : "100%",
					height: isHoverExpanded ? zoomedSize : "100%",
					// Cap the zoomed box to a fraction of the viewport so a
					// large inspector on a wide display (e.g. 27" fullscreen)
					// doesn't grow past the window edges. The right/bottom
					// anchors stay pinned, so capping just shortens the up/left
					// extent. Resting size (100%) is well below the caps so it's
					// unaffected.
					maxWidth: "min(85vw, 1400px)",
					maxHeight: "min(75vh, 900px)",
					// `height` only transitions during hover-zoom; outside of
					// zoom the toggle's web-animation drives wrapper height
					// and inner must follow instantly.
					transition: isZoomPresented
						? `width ${TABS_HOVER_TRANSITION_MS}ms ${TABS_EASING}, height ${TABS_HOVER_TRANSITION_MS}ms ${TABS_EASING}, box-shadow ${TABS_HOVER_TRANSITION_MS}ms ${TABS_EASING}`
						: `width ${TABS_HOVER_TRANSITION_MS}ms ${TABS_EASING}, box-shadow ${TABS_HOVER_TRANSITION_MS}ms ${TABS_EASING}`,
					// Tell the browser that nothing inside this container can affect
					// layout, paint, or size outside of it. This lets the browser
					// treat the zoom box as an independent compositing/layout
					// island — width/height changes don't invalidate the outer
					// inspector/sidebar layout, and box-shadow paints stay local.
					// Pairs with the `suspendTerminalFit()` lock to keep the
					// per-frame cost of the animation as low as possible.
					contain: "layout paint",
					// Drop shadow only. The top edge line is drawn by the section's
					// own `border-t` below — inset shadows are painted UNDER child
					// backgrounds, so putting it here would be hidden by the
					// section's `bg-sidebar`.
					// Shadow offsets are negative on both axes so the drop shadow
					// radiates toward the TOP and LEFT — the panel is anchored to
					// the bottom-right of the aside, so shadow on the bottom/right
					// would be invisible (clipped by the aside edge). The two
					// layers give a soft ambient edge plus a tighter contact halo.
					// Collapsed state keeps the same layer count (two) so the
					// box-shadow transition interpolates cleanly layer-by-layer.
					boxShadow: isHoverExpanded
						? "-2px -2px 10px -2px rgba(0, 0, 0, 0.08), -6px -6px 28px -10px rgba(0, 0, 0, 0.10)"
						: "0 0 0 0 rgba(0, 0, 0, 0), 0 0 0 0 rgba(0, 0, 0, 0)",
				}}
			>
				<section
					aria-label="Inspector section Tabs"
					// Whole scripts-area belongs to terminal scope so Mod+T from
					// Run output spawns a terminal instead of a chat session.
					data-focus-scope="terminal"
					className={cn(
						"relative flex min-h-0 flex-1 flex-col overflow-hidden border-b border-border/60 bg-sidebar",
						// Draw the top edge line on the section itself so it paints
						// above the section's `bg-sidebar` and scales with the
						// container as it grows. Tied to `isZoomPresented` so the
						// border stays drawn for the whole collapse animation too.
						isZoomPresented && "border-t border-t-border/60",
					)}
				>
					<div
						className="flex min-h-0 flex-1 flex-col gap-0"
						style={{
							// Gaussian blur pulse during the transition. `filter` is
							// GPU-composited so this costs almost nothing; wrapping
							// header + body (but NOT the section with its bg/border)
							// means the container's edges stay crisp while the
							// content inside looks like it's "focusing in / out."
							filter: isContentBlurred
								? `blur(${TABS_BLUR_PEAK_PX}px)`
								: "blur(0)",
							transition: `filter ${TABS_BLUR_FADE_MS}ms ease-out`,
							willChange: "filter",
						}}
					>
						<div
							className={cn(
								INSPECTOR_SECTION_HEADER_CLASS,
								"relative z-10 items-stretch pt-0",
								!open && "border-b-transparent",
							)}
						>
							<div
								role="tablist"
								aria-orientation="horizontal"
								className="scrollbar-none flex h-full min-w-0 flex-1 self-stretch items-stretch gap-0 overflow-x-auto overflow-y-hidden"
							>
								<button
									type="button"
									role="tab"
									id="inspector-tab-setup"
									aria-controls="inspector-panel-setup"
									aria-selected={activeTab === "setup"}
									tabIndex={activeTab === "setup" ? 0 : -1}
									className={cn(
										INSPECTOR_TAB_BUTTON_CLASS,
										"shrink-0",
										activeTab === "setup" && "text-foreground",
									)}
									onClick={() => handleTabClick("setup")}
								>
									<ScriptStatusIcon state={setupScriptState} />
									Setup
									<span
										aria-hidden="true"
										className={cn(
											"pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-foreground opacity-0 transition-opacity",
											activeTab === "setup" && "opacity-100",
										)}
									/>
								</button>
								<button
									type="button"
									role="tab"
									id="inspector-tab-run"
									aria-controls="inspector-panel-run"
									aria-selected={activeTab === "run"}
									tabIndex={activeTab === "run" ? 0 : -1}
									className={cn(
										INSPECTOR_TAB_BUTTON_CLASS,
										"shrink-0",
										activeTab === "run" && "text-foreground",
									)}
									onClick={() => handleTabClick("run")}
								>
									<ScriptStatusIcon state={runScriptState} />
									Run
									<span
										aria-hidden="true"
										className={cn(
											"pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-foreground opacity-0 transition-opacity",
											activeTab === "run" && "opacity-100",
										)}
									/>
								</button>
								{terminalInstances.length === 0 ? (
									// Placeholder tab so the Terminal entry point is always
									// discoverable, even on a fresh workspace with no live
									// shells. Clicking it spawns the first terminal — same
									// effect as clicking "+", but with a visible label.
									<button
										type="button"
										role="tab"
										id="inspector-tab-terminal-placeholder"
										aria-selected={false}
										tabIndex={-1}
										disabled={!canSpawnTerminal}
										onClick={handleNewTerminalClick}
										className={cn(
											INSPECTOR_TAB_BUTTON_CLASS,
											"shrink-0 disabled:cursor-not-allowed disabled:opacity-50",
										)}
									>
										Terminal
									</button>
								) : (
									terminalInstances.map((instance, index) => {
										const label = getTerminalDisplayTitle(
											index,
											terminalInstances.length,
										);
										const isActive = activeTab === instance.id;
										const isHoverZoomDisabled = instance.hoverZoomDisabled;
										return (
											<ContextMenu
												key={instance.id}
												onOpenChange={handleTabContextMenuOpenChange}
											>
												<ContextMenuTrigger asChild>
													<div
														role="tab"
														id={`inspector-tab-terminal-${instance.id}`}
														aria-controls={`inspector-panel-terminal-${instance.id}`}
														aria-selected={isActive}
														tabIndex={isActive ? 0 : -1}
														// Mirrors session-tab layout (no hover color, layout
														// stable on mask toggle). `transform-gpu` keeps it
														// on its own compositing layer.
														className={cn(
															"group/tab relative flex h-full min-w-[5rem] shrink-0 transform-gpu cursor-pointer items-center overflow-hidden px-3 text-[12px] font-medium text-muted-foreground focus-visible:outline-none focus-visible:ring-0",
															isActive && "text-foreground",
														)}
														onClick={() => handleTabClick(instance.id)}
														onMouseDown={(e) => {
															if (e.button === 1) {
																// Middle-click closes the tab (matches
																// browser tab UX). preventDefault stops
																// the browser's autoscroll-anchor cursor.
																e.preventDefault();
																onCloseTerminal(instance.id);
															}
														}}
														onKeyDown={(e) => {
															if (e.key === "Enter" || e.key === " ") {
																e.preventDefault();
																handleTabClick(instance.id);
															}
														}}
													>
														<span className="terminal-tab-fade flex min-w-0 flex-1 items-center justify-center">
															<span className="truncate">{label}</span>
														</span>
														<button
															type="button"
															aria-label={`Close ${label}`}
															onClick={(e) => {
																e.stopPropagation();
																onCloseTerminal(instance.id);
															}}
															// Visibility-only toggle (no opacity transition) —
															// matches session-tab + workspace-row patterns.
															className="pointer-events-none invisible absolute inset-y-0 right-0 flex w-3 cursor-pointer items-center justify-center text-muted-foreground/70 hover:text-foreground group-hover/tab:pointer-events-auto group-hover/tab:visible focus-visible:pointer-events-auto focus-visible:visible"
														>
															<X className="size-3" strokeWidth={2} />
														</button>
														<span
															aria-hidden="true"
															className={cn(
																"pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-foreground opacity-0 transition-opacity",
																isActive && "opacity-100",
															)}
														/>
													</div>
												</ContextMenuTrigger>
												<ContextMenuContent className="min-w-48">
													<ContextMenuItem
														onClick={() =>
															onToggleTerminalHoverZoom(
																instance.id,
																!isHoverZoomDisabled,
															)
														}
													>
														{isHoverZoomDisabled ? (
															<ZoomIn
																className="size-4 shrink-0"
																strokeWidth={1.6}
															/>
														) : (
															<ZoomOut
																className="size-4 shrink-0"
																strokeWidth={1.6}
															/>
														)}
														<span>
															{isHoverZoomDisabled
																? "Enable hover zoom"
																: "Disable hover zoom"}
														</span>
													</ContextMenuItem>
													<ContextMenuSeparator />
													<ContextMenuItem
														onClick={() => onCloseTerminal(instance.id)}
													>
														<X className="size-4 shrink-0" strokeWidth={1.6} />
														<span>Close terminal</span>
													</ContextMenuItem>
												</ContextMenuContent>
											</ContextMenu>
										);
									})
								)}
								<Tooltip>
									<TooltipTrigger asChild>
										<button
											type="button"
											aria-label="New terminal"
											onClick={handleNewTerminalClick}
											disabled={!canSpawnTerminal}
											className="ml-1 flex h-full w-6 shrink-0 cursor-pointer items-center justify-center self-center text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-0 disabled:cursor-not-allowed disabled:opacity-50"
										>
											<Plus className="size-3.5" strokeWidth={1.8} />
										</button>
									</TooltipTrigger>
									<TooltipContent
										side="bottom"
										className="flex h-[24px] items-center gap-2 rounded-md px-2 text-[12px] leading-none"
									>
										<span>New terminal</span>
										{newTerminalShortcut ? (
											<InlineShortcutDisplay
												hotkey={newTerminalShortcut}
												className="text-background/60"
											/>
										) : null}
									</TooltipContent>
								</Tooltip>
							</div>
							<div className="ml-2 flex shrink-0 items-center gap-1 self-center">
								{tabActions}
								<Button
									type="button"
									aria-label="Toggle inspector tabs section"
									onClick={onToggle}
									variant="ghost"
									size="icon-sm"
									className="shrink-0 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
								>
									<ChevronDown
										className="size-3.5"
										strokeWidth={1.9}
										style={{
											transform: open ? "rotate(0deg)" : "rotate(-90deg)",
											transition: `transform ${chevronTransitionMs}ms ${TABS_EASING}`,
										}}
									/>
								</Button>
							</div>
						</div>

						{open && (
							<div
								aria-label="Inspector tabs body"
								onMouseEnter={handleBodyMouseEnter}
								onMouseDown={handleBodyMouseDown}
								className="relative flex min-h-0 flex-1 flex-col bg-sidebar"
							>
								<TabsZoomContext.Provider
									value={{ isZoomPresented, isHoverExpanded }}
								>
									{children}
								</TabsZoomContext.Provider>
							</div>
						)}
					</div>
				</section>
			</div>
		</motion.div>
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
