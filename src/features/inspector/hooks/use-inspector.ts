import { useQuery } from "@tanstack/react-query";
import {
	type MouseEvent as ReactMouseEvent,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { loadRepoScripts, type RepoScripts } from "@/lib/api";
import type { InspectorFileItem } from "@/lib/editor-session";
import { workspaceChangesQueryOptions } from "@/lib/query-client";
import {
	getInitialActiveTab,
	getInitialTabsHeight,
	getInitialTabsOpen,
	INSPECTOR_ACTIVE_TAB_STORAGE_KEY,
	INSPECTOR_SECTION_HEADER_HEIGHT,
	INSPECTOR_TABS_HEIGHT_STORAGE_KEY,
	INSPECTOR_TABS_OPEN_STORAGE_KEY,
	TABS_ANIMATION_MS,
} from "../layout";
import { getScriptState, startScript, stopScript } from "../script-store";

// Inspector layout model
// ----------------------
// Two vertically-stacked sections: a top section (All files / Changes /
// Actions, switched via tabs) and a bottom Tabs section (Setup / Run /
// Terminal). Bodies sum to `bodyBudget = container - 2 * sectionHeader`. The
// top section absorbs the slack; the user-resized Tabs height is the only
// stored value.

const MIN_TOP_BODY = 128;
const MIN_TABS_BODY = 160;
const DEFAULT_TABS_BODY = 160;

type ResizeState = {
	pointerY: number;
	initialTabsBody: number;
	bodyBudget: number;
};

type UseWorkspaceInspectorSidebarArgs = {
	workspaceRootPath?: string | null;
	workspaceId: string | null;
	repoId: string | null;
	/** Drives the auto-relocate-to-Run-tab heuristic on workspace switch.
	 * `null` until the workspace detail query resolves; nothing happens
	 * while loading. */
	workspaceState?: string | null;
};

type DerivedSizes = {
	topBody: number;
	tabsBody: number;
};

function clamp(value: number, min: number, max: number): number {
	if (max < min) return min;
	if (value < min) return min;
	if (value > max) return max;
	return value;
}

/**
 * Pure layout derivation. Heights sum to `bodyBudget`. The Tabs section size
 * is the user-resized value (clamped); the Top section absorbs the rest.
 */
function deriveSizes({
	bodyBudget,
	tabsOpen,
	storedTabsBody,
}: {
	bodyBudget: number;
	tabsOpen: boolean;
	storedTabsBody: number;
}): DerivedSizes {
	const tabsBody = tabsOpen
		? clamp(storedTabsBody, MIN_TABS_BODY, Math.max(MIN_TABS_BODY, bodyBudget))
		: 0;
	const topBody = Math.max(MIN_TOP_BODY, bodyBudget - tabsBody);
	return { topBody, tabsBody };
}

export function useWorkspaceInspectorSidebar({
	workspaceRootPath,
	workspaceId,
	repoId,
	workspaceState,
}: UseWorkspaceInspectorSidebarArgs) {
	const [tabsOpen, setTabsOpen] = useState(getInitialTabsOpen);
	const [activeTab, setActiveTab] = useState(getInitialActiveTab);

	// On workspace switch, default the Setup/Run tab to whichever phase the
	// workspace is currently in: `setup_pending` → "setup" so the user sees
	// the script auto-running; anything else (`ready`, `archived`) → "run"
	// because setup is already past. Only overrides when the active tab is
	// already Setup/Run — leaves Terminal sub-tabs alone. Refs #460.
	const lastWorkspaceIdRef = useRef<string | null>(null);
	useEffect(() => {
		if (!workspaceId) return;
		if (lastWorkspaceIdRef.current === workspaceId) return;
		// Wait until the parent has loaded workspaceState so we don't
		// flip tabs based on a stale `null`.
		if (workspaceState === null || workspaceState === undefined) return;
		lastWorkspaceIdRef.current = workspaceId;
		setActiveTab((current) => {
			if (current !== "setup" && current !== "run") return current;
			const target = workspaceState === "setup_pending" ? "setup" : "run";
			return current === target ? current : target;
		});
	}, [workspaceId, workspaceState]);

	const [containerHeight, setContainerHeight] = useState(0);
	const [storedTabsBody, setStoredTabsBody] = useState(() =>
		getInitialTabsHeight(DEFAULT_TABS_BODY),
	);
	const [resizeState, setResizeState] = useState<ResizeState | null>(null);
	const [isPanelToggleAnimating, setIsPanelToggleAnimating] = useState(false);

	const containerRef = useRef<HTMLDivElement>(null);
	const tabsWrapperRef = useRef<HTMLDivElement>(null);
	const panelToggleTimerRef = useRef<number | null>(null);

	const beginPanelToggleAnimation = useCallback(() => {
		if (panelToggleTimerRef.current !== null) {
			window.clearTimeout(panelToggleTimerRef.current);
		}
		setIsPanelToggleAnimating(true);
		panelToggleTimerRef.current = window.setTimeout(() => {
			panelToggleTimerRef.current = null;
			setIsPanelToggleAnimating(false);
		}, TABS_ANIMATION_MS + 50);
	}, []);

	useEffect(() => {
		return () => {
			if (panelToggleTimerRef.current !== null) {
				window.clearTimeout(panelToggleTimerRef.current);
			}
		};
	}, []);

	useLayoutEffect(() => {
		const element = containerRef.current;
		if (!element) return;
		setContainerHeight(element.getBoundingClientRect().height);
	}, []);

	useEffect(() => {
		const element = containerRef.current;
		if (!element) return;

		let frameId: number | null = null;
		const observer = new ResizeObserver((entries) => {
			const entry = entries[0];
			if (!entry) return;
			if (frameId !== null) cancelAnimationFrame(frameId);
			frameId = requestAnimationFrame(() => {
				frameId = null;
				setContainerHeight(entry.contentRect.height);
			});
		});

		observer.observe(element);
		return () => {
			if (frameId !== null) cancelAnimationFrame(frameId);
			observer.disconnect();
		};
	}, []);

	const bodyBudget = Math.max(
		0,
		containerHeight - 2 * INSPECTOR_SECTION_HEADER_HEIGHT,
	);

	const { topBody, tabsBody } = useMemo(
		() =>
			deriveSizes({
				bodyBudget,
				tabsOpen,
				storedTabsBody,
			}),
		[bodyBudget, tabsOpen, storedTabsBody],
	);

	useEffect(() => {
		try {
			window.localStorage.setItem(
				INSPECTOR_TABS_OPEN_STORAGE_KEY,
				String(tabsOpen),
			);
		} catch (error) {
			console.error(
				`[helmor] tabs open save failed for "${INSPECTOR_TABS_OPEN_STORAGE_KEY}"`,
				error,
			);
		}
	}, [tabsOpen]);

	useEffect(() => {
		try {
			window.localStorage.setItem(INSPECTOR_ACTIVE_TAB_STORAGE_KEY, activeTab);
		} catch (error) {
			console.error(
				`[helmor] active tab save failed for "${INSPECTOR_ACTIVE_TAB_STORAGE_KEY}"`,
				error,
			);
		}
	}, [activeTab]);

	useEffect(() => {
		try {
			window.localStorage.setItem(
				INSPECTOR_TABS_HEIGHT_STORAGE_KEY,
				String(storedTabsBody),
			);
		} catch (error) {
			console.error(
				`[helmor] tabs height save failed for "${INSPECTOR_TABS_HEIGHT_STORAGE_KEY}"`,
				error,
			);
		}
	}, [storedTabsBody]);

	const repoScriptsQuery = useQuery({
		queryKey: ["repoScripts", repoId, workspaceId],
		queryFn: () => loadRepoScripts(repoId!, workspaceId),
		enabled: !!repoId,
		staleTime: 0,
	});
	const repoScripts: RepoScripts | null = repoScriptsQuery.data ?? null;
	const scriptsLoaded = repoScriptsQuery.isFetched;

	// Cmd+R toggle: idle/exited → start; running → stop. Tab visibility
	// unchanged — the user can open the Run tab later to replay output.
	useEffect(() => {
		const handler = () => {
			if (!repoId || !workspaceId) return;
			if (!repoScripts?.runScript?.trim()) return;
			const state = getScriptState(workspaceId, "run");
			if (state?.status === "running") {
				stopScript(repoId, "run", workspaceId);
			} else {
				startScript(repoId, "run", workspaceId);
			}
		};
		window.addEventListener("helmor:run-script", handler);
		return () => window.removeEventListener("helmor:run-script", handler);
	}, [repoId, workspaceId, repoScripts]);

	const isResizing = resizeState !== null;
	const isTabsResizing = resizeState !== null;

	// Skip while the worktree isn't fully materialised. During
	// `Initializing`, `git worktree add` is mid-checkout: `git diff`
	// against the half-populated tree returns every tracked file as a
	// phantom delete, and the inspector's auto-expanded tree stalls the
	// JS thread for seconds. `Archived` has no worktree at all.
	const changesQueryEnabled =
		!!workspaceRootPath &&
		workspaceState !== "initializing" &&
		workspaceState !== "archived";
	const changesQuery = useQuery({
		...workspaceChangesQueryOptions(workspaceRootPath ?? ""),
		enabled: changesQueryEnabled,
	});
	const changes: InspectorFileItem[] = changesQuery.data?.items ?? [];

	const prevChangesRef = useRef<Map<string, string> | null>(null);
	const prevRootPathRef = useRef(workspaceRootPath);
	if (prevRootPathRef.current !== workspaceRootPath) {
		prevRootPathRef.current = workspaceRootPath;
		prevChangesRef.current = null;
	}
	const nextChangesSnapshot = useMemo(() => {
		const snapshot = new Map<string, string>();
		for (const item of changes) {
			// Flashing key includes all three areas — any line-count change
			// in any area should trigger the flash.
			snapshot.set(
				item.path,
				`${item.stagedInsertions}:${item.stagedDeletions}:${item.unstagedInsertions}:${item.unstagedDeletions}:${item.committedInsertions}:${item.committedDeletions}:${item.status}`,
			);
		}
		return snapshot;
	}, [changes]);
	const flashingPaths = useMemo(() => {
		const previous = prevChangesRef.current;
		if (previous === null) {
			return new Set<string>();
		}

		const flashing = new Set<string>();
		for (const item of changes) {
			const nextKey = nextChangesSnapshot.get(item.path);
			if (!nextKey) {
				continue;
			}
			const previousKey = previous.get(item.path);
			if (previousKey === undefined || previousKey !== nextKey) {
				flashing.add(item.path);
			}
		}
		return flashing;
	}, [changes, nextChangesSnapshot]);
	useEffect(() => {
		prevChangesRef.current = nextChangesSnapshot;
	}, [nextChangesSnapshot]);

	useEffect(() => {
		const prefetched = changesQuery.data?.prefetched;
		if (!prefetched?.length) {
			return;
		}
		void import("@/lib/monaco-runtime").then(({ preWarmFileContents }) => {
			preWarmFileContents(prefetched);
		});
	}, [changesQuery.data]);

	const handleToggleTabs = useCallback(() => {
		beginPanelToggleAnimation();
		setTabsOpen((open) => !open);
	}, [beginPanelToggleAnimation]);

	useEffect(() => {
		if (!resizeState) {
			return;
		}

		let pendingMove: globalThis.MouseEvent | null = null;
		let animationFrameId: number | null = null;
		const flush = () => {
			animationFrameId = null;
			const event = pendingMove;
			pendingMove = null;
			if (!event) return;
			const deltaY = event.clientY - resizeState.pointerY;

			// Drag down → tabs shrinks, top section grows.
			const max = Math.max(
				MIN_TABS_BODY,
				resizeState.bodyBudget - MIN_TOP_BODY,
			);
			const next = clamp(
				resizeState.initialTabsBody - deltaY,
				MIN_TABS_BODY,
				max,
			);
			setStoredTabsBody(next);
		};

		const handleMouseMove = (event: globalThis.MouseEvent) => {
			pendingMove = event;
			if (animationFrameId === null) {
				animationFrameId = window.requestAnimationFrame(flush);
			}
		};

		const handleMouseUp = () => {
			if (animationFrameId !== null) {
				window.cancelAnimationFrame(animationFrameId);
				animationFrameId = null;
			}
			flush();
			setResizeState(null);
		};

		const previousCursor = document.body.style.cursor;
		const previousUserSelect = document.body.style.userSelect;
		document.body.style.cursor = "ns-resize";
		document.body.style.userSelect = "none";

		window.addEventListener("mousemove", handleMouseMove);
		window.addEventListener("mouseup", handleMouseUp);

		return () => {
			if (animationFrameId !== null) {
				window.cancelAnimationFrame(animationFrameId);
			}
			document.body.style.cursor = previousCursor;
			document.body.style.userSelect = previousUserSelect;
			window.removeEventListener("mousemove", handleMouseMove);
			window.removeEventListener("mouseup", handleMouseUp);
		};
	}, [resizeState]);

	const handleResizeStart = useCallback(
		(event: ReactMouseEvent<HTMLDivElement>) => {
			if (event.button !== 0) return;
			event.preventDefault();
			setResizeState({
				pointerY: event.clientY,
				initialTabsBody: storedTabsBody,
				bodyBudget,
			});
		},
		[storedTabsBody, bodyBudget],
	);

	return {
		activeTab,
		changes,
		topBodyHeight: topBody,
		containerRef,
		flashingPaths,
		handleResizeStart,
		handleToggleTabs,
		isPanelToggleAnimating,
		isResizing,
		isTabsResizing,
		repoScripts,
		scriptsLoaded,
		setActiveTab,
		tabsBodyHeight: tabsBody,
		tabsOpen,
		tabsWrapperRef,
	};
}
