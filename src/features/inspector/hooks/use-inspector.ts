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
	getInitialActionsOpen,
	getInitialActiveTab,
	getInitialChangesHeight,
	getInitialTabsHeight,
	getInitialTabsOpen,
	INSPECTOR_ACTIONS_OPEN_STORAGE_KEY,
	INSPECTOR_ACTIVE_TAB_STORAGE_KEY,
	INSPECTOR_CHANGES_HEIGHT_STORAGE_KEY,
	INSPECTOR_SECTION_HEADER_HEIGHT,
	INSPECTOR_TABS_HEIGHT_STORAGE_KEY,
	INSPECTOR_TABS_OPEN_STORAGE_KEY,
	TABS_ANIMATION_MS,
} from "../layout";
import { getScriptState, startScript, stopScript } from "../script-store";

// Inspector layout model
// ----------------------
// Three vertically-stacked sections (Changes, Actions, Tabs). Their bodies
// always sum to `bodyBudget = container - 3 * sectionHeader`. There is no
// CSS auto-fill — every body height is an explicit pixel value derived from:
//   - actionsOpen / tabsOpen
//   - containerHeight (observed)
//   - storedChangesBody / storedTabsBody (user-resized values)
//
// The "auto-fill" panel is whichever panel absorbs the slack:
//   - actions, when actions is open
//   - changes, when actions is collapsed
// We never store an explicit size for actions: it's always the slack absorber
// (or zero when collapsed). That keeps the toggle round-trip lossless and
// stops the section identities from competing for the same role.

const RESIZE_TARGET_ACTIONS = "actions";
const RESIZE_TARGET_TABS = "tabs";
type ResizeTarget = typeof RESIZE_TARGET_ACTIONS | typeof RESIZE_TARGET_TABS;

const MIN_CHANGES_BODY = 128;
const MIN_ACTIONS_BODY = 160;
const MIN_TABS_BODY = 160;
const DEFAULT_CHANGES_BODY = 240;
const DEFAULT_TABS_BODY = 160;

type ResizeState = {
	pointerY: number;
	target: ResizeTarget;
	initialChangesBody: number;
	initialTabsBody: number;
	bodyBudget: number;
	tabsBody: number;
	actionsOpen: boolean;
};

type UseWorkspaceInspectorSidebarArgs = {
	workspaceRootPath?: string | null;
	workspaceId: string | null;
	repoId: string | null;
};

type DerivedSizes = {
	changesBody: number;
	actionsBody: number;
	tabsBody: number;
};

function clamp(value: number, min: number, max: number): number {
	if (max < min) return min;
	if (value < min) return min;
	if (value > max) return max;
	return value;
}

/**
 * Pure layout derivation. Heights always sum to `bodyBudget`, except in the
 * pathological case where the container is smaller than the minimums — there
 * we surface the negative as `actionsBody` going below its minimum, which the
 * UI absorbs (the section just compresses).
 */
function deriveSizes({
	bodyBudget,
	actionsOpen,
	tabsOpen,
	storedChangesBody,
	storedTabsBody,
}: {
	bodyBudget: number;
	actionsOpen: boolean;
	tabsOpen: boolean;
	storedChangesBody: number;
	storedTabsBody: number;
}): DerivedSizes {
	const tabsBody = tabsOpen
		? clamp(storedTabsBody, MIN_TABS_BODY, Math.max(MIN_TABS_BODY, bodyBudget))
		: 0;

	if (actionsOpen) {
		const remaining = Math.max(0, bodyBudget - tabsBody);
		const changesBody = clamp(
			storedChangesBody,
			MIN_CHANGES_BODY,
			Math.max(MIN_CHANGES_BODY, remaining - MIN_ACTIONS_BODY),
		);
		const actionsBody = Math.max(MIN_ACTIONS_BODY, remaining - changesBody);
		return { changesBody, actionsBody, tabsBody };
	}

	const changesBody = Math.max(MIN_CHANGES_BODY, bodyBudget - tabsBody);
	return { changesBody, actionsBody: 0, tabsBody };
}

export function useWorkspaceInspectorSidebar({
	workspaceRootPath,
	workspaceId,
	repoId,
}: UseWorkspaceInspectorSidebarArgs) {
	const [actionsOpen, setActionsOpen] = useState(getInitialActionsOpen);
	const [tabsOpen, setTabsOpen] = useState(getInitialTabsOpen);
	const [activeTab, setActiveTab] = useState(getInitialActiveTab);

	const [containerHeight, setContainerHeight] = useState(0);
	const [storedChangesBody, setStoredChangesBody] = useState(() =>
		getInitialChangesHeight(DEFAULT_CHANGES_BODY),
	);
	const [storedTabsBody, setStoredTabsBody] = useState(() =>
		getInitialTabsHeight(DEFAULT_TABS_BODY),
	);
	const [resizeState, setResizeState] = useState<ResizeState | null>(null);
	const [isPanelToggleAnimating, setIsPanelToggleAnimating] = useState(false);

	const containerRef = useRef<HTMLDivElement>(null);
	const tabsWrapperRef = useRef<HTMLDivElement>(null);
	const actionsRef = useRef<HTMLElement>(null);
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
		containerHeight - 3 * INSPECTOR_SECTION_HEADER_HEIGHT,
	);

	const { changesBody, actionsBody, tabsBody } = useMemo(
		() =>
			deriveSizes({
				bodyBudget,
				actionsOpen,
				tabsOpen,
				storedChangesBody,
				storedTabsBody,
			}),
		[bodyBudget, actionsOpen, tabsOpen, storedChangesBody, storedTabsBody],
	);

	useEffect(() => {
		try {
			window.localStorage.setItem(
				INSPECTOR_ACTIONS_OPEN_STORAGE_KEY,
				String(actionsOpen),
			);
		} catch (error) {
			console.error(
				`[helmor] actions open save failed for "${INSPECTOR_ACTIONS_OPEN_STORAGE_KEY}"`,
				error,
			);
		}
	}, [actionsOpen]);

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
				INSPECTOR_CHANGES_HEIGHT_STORAGE_KEY,
				String(storedChangesBody),
			);
		} catch (error) {
			console.error(
				`[helmor] changes height save failed for "${INSPECTOR_CHANGES_HEIGHT_STORAGE_KEY}"`,
				error,
			);
		}
	}, [storedChangesBody]);

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
	const isActionsResizing = resizeState?.target === RESIZE_TARGET_ACTIONS;
	const isTabsResizing = resizeState?.target === RESIZE_TARGET_TABS;

	const changesQuery = useQuery({
		...workspaceChangesQueryOptions(workspaceRootPath ?? ""),
		enabled: !!workspaceRootPath,
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
			snapshot.set(
				item.path,
				`${item.insertions}:${item.deletions}:${item.status}`,
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

	const handleToggleActions = useCallback(() => {
		beginPanelToggleAnimation();
		setActionsOpen((open) => !open);
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

			if (resizeState.target === RESIZE_TARGET_ACTIONS) {
				// Drag down → changes grows, actions auto-shrinks.
				const max = Math.max(
					MIN_CHANGES_BODY,
					resizeState.bodyBudget - resizeState.tabsBody - MIN_ACTIONS_BODY,
				);
				const next = clamp(
					resizeState.initialChangesBody + deltaY,
					MIN_CHANGES_BODY,
					max,
				);
				setStoredChangesBody(next);
				return;
			}

			// Drag down → tabs shrinks, upper region (actions or changes) grows.
			const upperMin =
				MIN_CHANGES_BODY + (resizeState.actionsOpen ? MIN_ACTIONS_BODY : 0);
			const max = Math.max(MIN_TABS_BODY, resizeState.bodyBudget - upperMin);
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
		(target: ResizeTarget) => (event: ReactMouseEvent<HTMLDivElement>) => {
			if (event.button !== 0) return;
			event.preventDefault();
			setResizeState({
				pointerY: event.clientY,
				target,
				initialChangesBody: storedChangesBody,
				initialTabsBody: storedTabsBody,
				bodyBudget,
				tabsBody,
				actionsOpen,
			});
		},
		[storedChangesBody, storedTabsBody, bodyBudget, tabsBody, actionsOpen],
	);

	return {
		actionsHeight: actionsBody,
		actionsOpen,
		actionsRef,
		activeTab,
		changes,
		changesHeight: changesBody,
		containerRef,
		flashingPaths,
		handleResizeStart,
		handleToggleActions,
		handleToggleTabs,
		isActionsResizing,
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
