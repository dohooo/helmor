import { ChevronDown, Plus, X, ZoomIn, ZoomOut } from "lucide-react";
import {
	createContext,
	type RefObject,
	useCallback,
	useContext,
	useRef,
	useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import type { WorkspaceCommitButtonMode } from "@/features/commit/button";
import { getShortcut } from "@/features/shortcuts/registry";
import { InlineShortcutDisplay } from "@/features/shortcuts/shortcut-display";
import type { RunAction } from "@/lib/api";
import { useSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import type { ScriptIconState } from "./hooks/use-script-status";
import { useScriptStatus } from "./hooks/use-script-status";
import { useHoverZoom } from "./layout/use-hover-zoom";
import { ScriptStatusIcon } from "./script-status-icon";
import {
	getTerminalDisplayTitle,
	type TerminalInstance,
} from "./terminal-store";

export const MIN_SECTION_HEIGHT = 48;
export const DEFAULT_TABS_BODY_HEIGHT = 128;
export const RESIZE_HIT_AREA = 10;
/** Apple-style easing for hover-zoom. */
export const TABS_EASING = "cubic-bezier(0.32, 0.72, 0, 1)";

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
	"flex h-8 min-w-0 shrink-0 items-center justify-between border-b border-border/60 bg-inspector-section-header px-3";
export const INSPECTOR_SECTION_TITLE_CLASS =
	"text-ui leading-8 font-medium tracking-[-0.01em] text-muted-foreground";
/** `px-3` + `gap-0` on tablist → uniform 24px gap between any two tabs. */
const INSPECTOR_TAB_BUTTON_CLASS =
	"relative inline-flex h-full cursor-interactive items-center justify-center gap-1.5 px-3 text-small font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-0";

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
		case "merge-blocked":
			return "bg-[var(--workspace-pr-closed-header-bg)]";
		case "open-pr":
			return null;
		case "checks-running":
			return "bg-[var(--workspace-pr-checks-running-header-bg)]";
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
	 * Text rendered inside the Run tab. "Run" for the single-action case
	 * (the dropdown carries identity); the active action's name when the
	 * workspace has multiple configured, so the user can tell at a glance
	 * which output buffer is on-screen once the placeholder copy is gone.
	 */
	runTabLabel: string;
	/** Current workspace id — needed so each Run-tab dropdown item can
	 * subscribe to its own action's live status (per-action loading /
	 * success / failure glyph). `null` outside a workspace context — the
	 * dropdown then renders each item without a status icon. */
	workspaceId: string | null;
	/**
	 * All run actions configured for the current repo (DB + helmor.json
	 * merged). Empty when none configured — the Run-tab dropdown still
	 * renders, but only carries the "Create new" entry.
	 */
	runActions: RunAction[];
	/** id of the run action the user has picked as active in this workspace
	 * (or `null` to mean "the first action"). */
	activeRunActionId: string | null;
	/** Setting a new active id from the dropdown radio. */
	onSelectRunAction: (actionId: string) => void;
	/** "Create" item in the dropdown — opens the repo settings UI focused
	 * on the run-scripts section. */
	onCreateRunAction: () => void;
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
	runTabLabel,
	workspaceId,
	runActions,
	activeRunActionId,
	onSelectRunAction,
	onCreateRunAction,
	terminalInstances,
	onAddTerminal,
	onCloseTerminal,
	onToggleTerminalHoverZoom,
	canSpawnTerminal,
	canHoverExpand,
	children,
}: InspectorTabsSectionProps) {
	const { settings } = useSettings();
	const newTerminalShortcut = getShortcut(settings.shortcuts, "terminal.new");

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

	// Run-tab dropdown open state is lifted here so the Run label button
	// can also act as a trigger when the tab is already active — letting
	// the user click anywhere on the active Run tab (not just the chevron)
	// to open the action menu. While Run is inactive the label keeps its
	// normal tab-switching role; only the chevron opens the menu.
	const [runMenuOpen, setRunMenuOpen] = useState(false);
	const runLabelRef = useRef<HTMLButtonElement>(null);

	const handleRunMenuOpenChange = useCallback(
		(next: boolean) => {
			setRunMenuOpen(next);
			// Keep the hover-zoom controller in the loop so the panel
			// doesn't collapse mid-menu when the cursor enters a portaled
			// item — same fix the chevron always relied on.
			handleTabContextMenuOpenChange(next);
		},
		[handleTabContextMenuOpenChange],
	);

	const handleRunTabClick = useCallback(() => {
		if (activeTab !== "run") {
			handleTabClick("run");
			return;
		}
		// Already on Run — the whole tab acts as the dropdown trigger.
		// Toggle so a second click on the label closes the menu, matching
		// the chevron's behaviour.
		handleRunMenuOpenChange(!runMenuOpen);
	}, [activeTab, handleRunMenuOpenChange, handleTabClick, runMenuOpen]);

	// "+" / placeholder Terminal: spawning a terminal while the panel is
	// collapsed would create one the user can't see — pop the panel open too.
	const handleNewTerminalClick = useCallback(() => {
		if (!open) onToggle();
		onAddTerminal();
	}, [open, onAddTerminal, onToggle]);

	return (
		<div
			ref={wrapperRef}
			className={cn(
				"relative flex min-h-0 shrink-0 flex-col",
				!isZoomPresented && "overflow-hidden",
			)}
			// Height written via `wrapperRef` by `useWorkspaceInspectorSidebar`.
			style={{ minHeight: `${TABS_WRAPPER_COLLAPSED_MIN_HEIGHT_PX}px` }}
		>
			<div
				data-tabs-zoomed={isZoomPresented ? "true" : undefined}
				onMouseEnter={handleContainerMouseEnter}
				onMouseLeave={handleContainerMouseLeave}
				className={cn(
					// Safety floor for the zoomed area — matches the inspector chrome.
					"absolute right-0 bottom-0 flex flex-col bg-inspector",
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
						"relative flex min-h-0 flex-1 flex-col overflow-hidden border-b border-border/60 bg-inspector",
						// Draw the top edge line on the section itself so it paints
						// above the section's `bg-inspector` and scales with the
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
								{/* Run tab + dropdown chevron share a wrapper so the
								    active-tab underline can span both — covering the
								    chevron too, not just the "Run" label. */}
								<div className="relative flex shrink-0 items-stretch">
									<button
										type="button"
										role="tab"
										ref={runLabelRef}
										id="inspector-tab-run"
										aria-controls="inspector-panel-run"
										aria-selected={activeTab === "run"}
										// Once Run is the active tab, the label doubles as the
										// dropdown trigger; advertise that to assistive tech.
										aria-haspopup={activeTab === "run" ? "menu" : undefined}
										aria-expanded={
											activeTab === "run" ? runMenuOpen : undefined
										}
										tabIndex={activeTab === "run" ? 0 : -1}
										className={cn(
											INSPECTOR_TAB_BUTTON_CLASS,
											// Tighten right padding so the dropdown chevron sits
											// flush against the label instead of inheriting the
											// full tab gutter.
											"shrink-0 pr-1",
											activeTab === "run" && "text-foreground",
										)}
										onClick={handleRunTabClick}
									>
										<ScriptStatusIcon state={runScriptState} />
										{/* Capped width + truncate so a long custom action
										    name (helmor.json) can't push the dropdown chevron
										    off-screen or stretch the tab past its neighbours. */}
										<span className="max-w-[8rem] truncate">{runTabLabel}</span>
									</button>
									<RunActionsDropdown
										activeTab={activeTab}
										workspaceId={workspaceId}
										runActions={runActions}
										activeRunActionId={activeRunActionId}
										onSelectRunAction={onSelectRunAction}
										onCreateRunAction={onCreateRunAction}
										open={runMenuOpen}
										onOpenChange={handleRunMenuOpenChange}
										labelRef={runLabelRef}
									/>
									<span
										aria-hidden="true"
										className={cn(
											"pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-foreground opacity-0 transition-opacity",
											activeTab === "run" && "opacity-100",
										)}
									/>
								</div>
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
															"group/tab relative flex h-full min-w-[5rem] shrink-0 transform-gpu cursor-interactive items-center overflow-hidden px-3 text-small font-medium text-muted-foreground focus-visible:outline-none focus-visible:ring-0",
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
															className="pointer-events-none invisible absolute inset-y-0 right-0 flex w-3 cursor-interactive items-center justify-center text-muted-foreground/70 hover:text-foreground group-hover/tab:pointer-events-auto group-hover/tab:visible focus-visible:pointer-events-auto focus-visible:visible"
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
											className="ml-1 flex h-full w-6 shrink-0 cursor-interactive items-center justify-center self-center text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-0 disabled:cursor-not-allowed disabled:opacity-50"
										>
											<Plus className="size-3.5" strokeWidth={1.8} />
										</button>
									</TooltipTrigger>
									<TooltipContent
										side="bottom"
										className="flex h-[24px] items-center gap-2 rounded-md px-2 text-small leading-none"
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
											transition: "none",
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
								className="relative flex min-h-0 flex-1 flex-col bg-inspector"
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

/**
 * Chevron trigger rendered to the right of the Run tab label. Clicking it
 * (a) does NOT switch tabs — the dropdown handles its own focus — and
 * (b) shows the list of configured run actions plus a "Create" entry
 * that punts to the repository settings panel.
 *
 * Composition-only: uses the project's standard shadcn DropdownMenu
 * primitives (RadioGroup / RadioItem / Separator / Item) so visual style
 * stays consistent with every other menu in the app.
 */
function RunActionsDropdown({
	activeTab,
	workspaceId,
	runActions,
	activeRunActionId,
	onSelectRunAction,
	onCreateRunAction,
	open,
	onOpenChange,
	labelRef,
}: {
	activeTab: string;
	workspaceId: string | null;
	runActions: RunAction[];
	activeRunActionId: string | null;
	onSelectRunAction: (id: string) => void;
	onCreateRunAction: () => void;
	/** Controlled open state — lifted to the parent so the Run label can
	 * also toggle this menu when the tab is active. */
	open: boolean;
	/** Combined sink: updates the lifted state AND bridges to the hover-zoom
	 * controller (so the portaled menu doesn't collapse the panel the moment
	 * the cursor enters a menu item). */
	onOpenChange: (open: boolean) => void;
	/** Reference to the Run-tab label button. Used by the menu's outside-
	 * click handler so a click on the label is owned by the label's own
	 * toggle rather than being auto-closed by Radix mid-toggle. */
	labelRef: RefObject<HTMLButtonElement | null>;
}) {
	// Resolve which radio value should be checked. Falls back to the first
	// action when the persisted id is missing or stale (recently deleted).
	const resolvedActiveId =
		runActions.find((a) => a.id === activeRunActionId)?.id ??
		runActions[0]?.id ??
		"";
	return (
		<DropdownMenu open={open} onOpenChange={onOpenChange}>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					aria-label="Switch run action"
					// Sit visually adjacent to the Run tab without claiming
					// tab semantics — pure menu trigger. Pull a hair to the
					// left so it nests against the label.
					//
					// Hover feedback mirrors the inline-icon-button pattern
					// already used in this file: muted → foreground text +
					// a soft `bg-accent/60` halo so the affordance reads
					// even when the chevron is already at full color
					// (active-Run case). `data-[state=open]` keeps the bg
					// pinned while the dropdown is open — Radix sets that
					// attribute on the trigger automatically.
					className={cn(
						"-ml-0.5 flex h-full w-5 shrink-0 cursor-interactive items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-0 data-[state=open]:bg-accent/60 data-[state=open]:text-foreground",
						activeTab === "run" && "text-foreground",
					)}
					// Don't bubble the click — the parent tablist would
					// otherwise interpret it as activating the Run tab.
					onClick={(e) => e.stopPropagation()}
				>
					<ChevronDown className="size-3" strokeWidth={2} />
				</button>
			</DropdownMenuTrigger>
			{/* `align="end"` pins the dropdown's right edge to the chevron's
			    right edge — the menu extends leftward, so each item's
			    right edge lines up cleanly with the trigger. Min width is
			    tight; Radix grows the panel to fit the longest item, so
			    short labels stay compact. */}
			<DropdownMenuContent
				align="end"
				className="min-w-[112px]"
				onPointerDownOutside={(event) => {
					// Only when Run is the active tab does the label double as
					// the dropdown trigger — and only then does Radix's
					// outside-close race the label's own toggle. While Run is
					// inactive the label is just a tab switcher, so letting
					// Radix close the menu naturally is the right behaviour.
					if (activeTab !== "run") return;
					const target = event.target as Node | null;
					if (target && labelRef.current?.contains(target)) {
						event.preventDefault();
					}
				}}
			>
				{runActions.length > 0 && (
					<>
						<DropdownMenuRadioGroup
							value={resolvedActiveId}
							onValueChange={onSelectRunAction}
						>
							{runActions.map((action) => (
								<RunActionDropdownItem
									key={action.id}
									action={action}
									workspaceId={workspaceId}
								/>
							))}
						</DropdownMenuRadioGroup>
						<DropdownMenuSeparator />
					</>
				)}
				{/* Leading-icon shape: glyph on the left, label after. Sits in
				    the normal flex flow (gap-1.5 from the shared item class)
				    rather than mirroring the radio rows' right-pinned `✓`
				    column — this is an action row, not a selection row, so
				    the icon-then-label reading order signals "do" instead of
				    "current". */}
				<DropdownMenuItem onSelect={onCreateRunAction} className="gap-2">
					<Plus className="size-3" strokeWidth={1.8} />
					<span>Create</span>
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/**
 * Single radio item in the Run dropdown. Pulled out so each row can own
 * its own `useScriptStatus` subscription — that's how the per-action
 * loading / success / failure glyph stays live without the parent
 * re-rendering the whole list on every status tick.
 *
 * `aria-hidden` on the icon keeps the radio item's accessible name as
 * just the action's display name (matching the header tab convention).
 */
function RunActionDropdownItem({
	action,
	workspaceId,
}: {
	action: RunAction;
	workspaceId: string | null;
}) {
	const state = useScriptStatus(
		workspaceId,
		"run",
		action.command.trim().length > 0,
		action.id,
	);
	return (
		<DropdownMenuRadioItem
			value={action.id}
			className="flex items-center gap-2"
		>
			<ScriptStatusIcon state={state} />
			<span className="truncate">{action.name}</span>
		</DropdownMenuRadioItem>
	);
}
