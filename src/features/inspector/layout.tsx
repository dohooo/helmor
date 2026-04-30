import { ChevronDown, Plus, X } from "lucide-react";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import { suspendTerminalFit } from "@/components/terminal-output";
import { Button } from "@/components/ui/button";
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
const TABS_WRAPPER_COLLAPSED_MIN_HEIGHT_PX = 33;

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
	terminalInstances,
	onAddTerminal,
	onCloseTerminal,
	canSpawnTerminal,
	canHoverExpand,
	children,
}: InspectorTabsSectionProps) {
	const { settings } = useSettings();
	const newTerminalShortcut = getShortcut(settings.shortcuts, "terminal.new");
	// `isHoverExpanded` drives the CSS transitions we CAN interpolate
	// (width / height / box-shadow). Flipping it to `false` immediately starts
	// the shrink animation.
	const [isHoverExpanded, setIsHoverExpanded] = useState(false);
	// `isZoomPresented` drives the properties the browser CANNOT transition
	// (z-index, the `data-tabs-zoomed` flag that frees the aside's overflow,
	// and the border-t that draws the top edge). It stays `true` for the full
	// duration of BOTH the expand and the collapse animation so that the
	// zoomed visual identity stays consistent while the size is changing — the
	// collapsing panel looks exactly like the expanding one in reverse.
	const [isZoomPresented, setIsZoomPresented] = useState(false);
	// Short-lived flag that applies a gaussian blur to the inner
	// header+body while the panel is mid-transition. Masks the frames where
	// xterm's canvas is being GPU-scaled and then re-fit, which would
	// otherwise look like "ugly stretched pixels, then a snap".
	const [isContentBlurred, setIsContentBlurred] = useState(false);
	const hoverTimerRef = useRef<number | null>(null);
	const presentationClearTimerRef = useRef<number | null>(null);
	const blurClearTimerRef = useRef<number | null>(null);
	const pointerInsideContainerRef = useRef(false);
	// Tracks whether the user is actively selecting text. When true, prevents
	// the panel from collapsing on mouse-leave so text selection can extend
	// beyond the container boundary without interruption.
	const isSelectingRef = useRef(false);
	// Holds the outstanding `suspendTerminalFit()` release while the CSS
	// width/height transition is running, plus the timer that will release it
	// and trigger the final fit.
	const terminalFitReleaseRef = useRef<(() => void) | null>(null);
	const fitReleaseTimerRef = useRef<number | null>(null);

	const clearHoverTimer = useCallback(() => {
		if (hoverTimerRef.current !== null) {
			window.clearTimeout(hoverTimerRef.current);
			hoverTimerRef.current = null;
		}
	}, []);

	const clearPresentationClearTimer = useCallback(() => {
		if (presentationClearTimerRef.current !== null) {
			window.clearTimeout(presentationClearTimerRef.current);
			presentationClearTimerRef.current = null;
		}
	}, []);

	const clearBlurTimer = useCallback(() => {
		if (blurClearTimerRef.current !== null) {
			window.clearTimeout(blurClearTimerRef.current);
			blurClearTimerRef.current = null;
		}
	}, []);

	// Run a quick fade-in → hold → fade-out blur over the inner content
	// during the transition. Fires on both expand and collapse because the
	// canvas artefacts and the xterm re-fit flash happen in both directions.
	// Calling this while a pulse is already underway just extends the hold
	// window, so rapid hover-in/out doesn't produce a stuttery blur.
	const triggerContentBlurPulse = useCallback(() => {
		clearBlurTimer();
		setIsContentBlurred(true);
		blurClearTimerRef.current = window.setTimeout(() => {
			blurClearTimerRef.current = null;
			setIsContentBlurred(false);
		}, TABS_BLUR_HOLD_UNTIL_MS);
	}, [clearBlurTimer]);

	const releaseTerminalFitLock = useCallback(() => {
		if (fitReleaseTimerRef.current !== null) {
			window.clearTimeout(fitReleaseTimerRef.current);
			fitReleaseTimerRef.current = null;
		}
		if (terminalFitReleaseRef.current) {
			terminalFitReleaseRef.current();
			terminalFitReleaseRef.current = null;
		}
	}, []);

	// Pause every mounted `TerminalOutput`'s FitAddon for the duration of the
	// CSS transition. Without this, each xterm re-fits once per animation
	// frame (reflowing its 5000-line scrollback) which stutters the zoom.
	// Calling this while a suspension is already active just extends the
	// release timer — the suspend count stays at 1 throughout so the terminals
	// only re-fit once the animation truly settles.
	const beginZoomAnimation = useCallback(() => {
		if (!terminalFitReleaseRef.current) {
			terminalFitReleaseRef.current = suspendTerminalFit();
		}
		if (fitReleaseTimerRef.current !== null) {
			window.clearTimeout(fitReleaseTimerRef.current);
		}
		fitReleaseTimerRef.current = window.setTimeout(() => {
			fitReleaseTimerRef.current = null;
			if (terminalFitReleaseRef.current) {
				terminalFitReleaseRef.current();
				terminalFitReleaseRef.current = null;
			}
			// A small safety margin beyond the CSS transition so the final
			// fit uses the settled dimensions rather than the last interpolated
			// frame's.
		}, TABS_HOVER_TRANSITION_MS + 50);
	}, []);

	// Drives both the CSS-transitionable properties (`isHoverExpanded`) and
	// the discrete ones (`isZoomPresented`). Expanding flips presentation on
	// immediately; collapsing keeps presentation on until the shrink
	// transition has run to completion, so z-index / overflow / border stay
	// consistent with the shrinking box.
	const setZoomTarget = useCallback(
		(target: boolean) => {
			// Fire the blur pulse on every direction change. It masks the
			// canvas-stretch frames during the CSS transition AND the sharp
			// re-fit flash that happens right after the transition ends.
			triggerContentBlurPulse();
			if (target) {
				clearPresentationClearTimer();
				setIsZoomPresented(true);
			} else {
				clearPresentationClearTimer();
				presentationClearTimerRef.current = window.setTimeout(() => {
					presentationClearTimerRef.current = null;
					setIsZoomPresented(false);
				}, TABS_HOVER_TRANSITION_MS + 20);
			}
			setIsHoverExpanded(target);
		},
		[clearPresentationClearTimer, triggerContentBlurPulse],
	);

	// Hover trigger is bound to the BODY only (not the header) so moving the
	// cursor across the Setup/Run tabs or the chevron doesn't start a zoom.
	// The 300ms "hover intent" timer still gives us the linger-to-engage feel,
	// but the intent signal now requires engaging with the actual output area.
	const handleBodyMouseEnter = useCallback(() => {
		if (!open || !canHoverExpand) return;
		if (isHoverExpanded) return;
		clearHoverTimer();
		hoverTimerRef.current = window.setTimeout(() => {
			beginZoomAnimation();
			setZoomTarget(true);
			hoverTimerRef.current = null;
		}, TABS_HOVER_ACTIVATION_MS);
	}, [
		open,
		canHoverExpand,
		isHoverExpanded,
		clearHoverTimer,
		beginZoomAnimation,
		setZoomTarget,
	]);

	// Mark the start of a potential text selection. Used to prevent the panel
	// from collapsing while the user is dragging to select text.
	const handleBodyMouseDown = useCallback(() => {
		isSelectingRef.current = true;
	}, []);

	// Un-zoom fires only when the cursor leaves the whole panel (header +
	// body). Moving from body up into the header keeps the zoom alive so the
	// Stop/Rerun action and the tab switcher stay reachable while zoomed.
	// Also skips collapsing if the user is actively selecting text.
	const handleContainerMouseLeave = useCallback(() => {
		pointerInsideContainerRef.current = false;
		const hadPendingHoverIntent = hoverTimerRef.current !== null;
		clearHoverTimer();
		// Don't collapse if user is selecting text — they might drag outside
		// the container boundary during selection. The global mouseup handler
		// will clear this flag, and then leaving will collapse normally.
		if (isSelectingRef.current) {
			return;
		}
		if (hadPendingHoverIntent || (!isHoverExpanded && !isZoomPresented)) {
			return;
		}
		beginZoomAnimation();
		setZoomTarget(false);
	}, [
		clearHoverTimer,
		isHoverExpanded,
		isZoomPresented,
		beginZoomAnimation,
		setZoomTarget,
	]);

	// When the panel collapses we must drop any pending/active zoom so it
	// doesn't linger over the neighbouring sections. Also release any
	// outstanding terminal-fit lock immediately — the terminals are about to
	// unmount or change size and shouldn't be held back.
	useEffect(() => {
		if (!open) {
			clearHoverTimer();
			clearPresentationClearTimer();
			clearBlurTimer();
			releaseTerminalFitLock();
			setIsHoverExpanded(false);
			setIsZoomPresented(false);
			setIsContentBlurred(false);
		}
	}, [
		open,
		clearHoverTimer,
		clearPresentationClearTimer,
		clearBlurTimer,
		releaseTerminalFitLock,
	]);

	// If the active tab no longer has output worth zooming (e.g. user switched
	// from Run — with a live dev server — to Setup — never run), force the
	// panel back to its resting size through the normal collapse transition.
	useEffect(() => {
		if (canHoverExpand) return;
		clearHoverTimer();
		if (pointerInsideContainerRef.current) return;
		if (!isHoverExpanded && !isZoomPresented) return;
		beginZoomAnimation();
		setZoomTarget(false);
	}, [
		canHoverExpand,
		isHoverExpanded,
		isZoomPresented,
		clearHoverTimer,
		beginZoomAnimation,
		setZoomTarget,
	]);

	// Clear the selection flag on any mouseup, even if it happens outside the
	// panel. This ensures the collapse-on-leave behavior resumes after the
	// user finishes a text selection.
	useEffect(() => {
		const handleGlobalMouseUp = () => {
			isSelectingRef.current = false;
		};
		document.addEventListener("mouseup", handleGlobalMouseUp);
		return () => document.removeEventListener("mouseup", handleGlobalMouseUp);
	}, []);

	// Clean up any pending timer on unmount.
	useEffect(() => {
		return () => {
			clearHoverTimer();
			clearPresentationClearTimer();
			clearBlurTimer();
			releaseTerminalFitLock();
		};
	}, [
		clearHoverTimer,
		clearPresentationClearTimer,
		clearBlurTimer,
		releaseTerminalFitLock,
	]);

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
		<div
			ref={wrapperRef}
			className={cn(
				"relative flex min-h-0 shrink-0 flex-col",
				open && "flex-1",
			)}
			style={{
				// The real content lives inside the absolutely-positioned child
				// below, which contributes nothing to layout. Reserve header
				// height when the panel is closed so the parent flex column
				// keeps a stable footprint for us.
				minHeight: open
					? undefined
					: `${TABS_WRAPPER_COLLAPSED_MIN_HEIGHT_PX}px`,
			}}
		>
			<div
				data-tabs-zoomed={isZoomPresented ? "true" : undefined}
				onMouseEnter={() => {
					pointerInsideContainerRef.current = true;
				}}
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
					width: isHoverExpanded ? zoomedSize : "100%",
					height: isHoverExpanded ? zoomedSize : "100%",
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
										return (
											<div
												key={instance.id}
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
											transition: `transform ${TABS_ANIMATION_MS}ms ${TABS_EASING}`,
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
