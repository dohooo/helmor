import { useQuery } from "@tanstack/react-query";
import {
	type MouseEvent as ReactMouseEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { flushSync } from "react-dom";
import { loadRepoScripts, type RepoScripts } from "@/lib/api";
import type { InspectorFileItem } from "@/lib/editor-session";
import { workspaceChangesQueryOptions } from "@/lib/query-client";
import {
	DEFAULT_TABS_BODY_HEIGHT,
	MIN_SECTION_HEIGHT,
	TABS_ANIMATION_MS,
	TABS_EASING,
} from "../layout";

const DEFAULT_CHANGES_RATIO = 0.6;
const DEFAULT_ACTIONS_RATIO = 0.4;

type ResizeTarget = "actions" | "tabs";

type ResizeState = {
	pointerY: number;
	initialChangesHeight: number;
	initialActionsHeight: number;
	target: ResizeTarget;
};

type UseWorkspaceInspectorSidebarArgs = {
	workspaceRootPath?: string | null;
	workspaceId: string | null;
	repoId: string | null;
};

export function useWorkspaceInspectorSidebar({
	workspaceRootPath,
	workspaceId,
	repoId,
}: UseWorkspaceInspectorSidebarArgs) {
	const [tabsOpen, setTabsOpen] = useState(false);
	const [activeTab, setActiveTab] = useState("setup");
	const [pendingRunScript, setPendingRunScript] = useState(false);

	// Listen for Cmd+R "run script" shortcut event.
	useEffect(() => {
		const handler = () => {
			setTabsOpen(true);
			setActiveTab("run");
			setPendingRunScript(true);
		};
		window.addEventListener("helmor:run-script", handler);
		return () => window.removeEventListener("helmor:run-script", handler);
	}, []);
	const [changesHeight, setChangesHeight] = useState(0);
	const [actionsHeight, setActionsHeight] = useState(0);
	const [resizeState, setResizeState] = useState<ResizeState | null>(null);

	const containerRef = useRef<HTMLDivElement>(null);
	const tabsWrapperRef = useRef<HTMLDivElement>(null);
	const actionsRef = useRef<HTMLElement>(null);

	useEffect(() => {
		const element = containerRef.current;
		if (!element || changesHeight > 0) {
			return;
		}

		const overhead = 36 * 3 + 8 * 2;
		const available = Math.max(0, element.clientHeight - overhead);
		const resizableAvailable = Math.max(
			MIN_SECTION_HEIGHT * 2,
			available - DEFAULT_TABS_BODY_HEIGHT,
		);
		setChangesHeight(Math.round(resizableAvailable * DEFAULT_CHANGES_RATIO));
		setActionsHeight(Math.round(resizableAvailable * DEFAULT_ACTIONS_RATIO));
	}, [changesHeight]);

	const repoScriptsQuery = useQuery({
		queryKey: ["repoScripts", repoId, workspaceId],
		queryFn: () => loadRepoScripts(repoId!, workspaceId),
		enabled: !!repoId,
		staleTime: 0,
	});
	const repoScripts: RepoScripts | null = repoScriptsQuery.data ?? null;
	const scriptsLoaded = repoScriptsQuery.isFetched;

	const isResizing = resizeState !== null;
	const isActionsResizing = resizeState?.target === "actions";
	const isTabsResizing = resizeState?.target === "tabs";

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
		const tabsElement = tabsWrapperRef.current;
		const actionsElement = actionsRef.current;
		if (!tabsElement) {
			setTabsOpen((current) => !current);
			return;
		}

		const tabsFrom = tabsElement.offsetHeight;
		const actionsFrom = actionsElement?.offsetHeight ?? 0;

		flushSync(() => setTabsOpen((current) => !current));

		const tabsTo = tabsElement.offsetHeight;
		const actionsTo = actionsElement?.offsetHeight ?? 0;
		if (tabsFrom === tabsTo) {
			return;
		}

		const isExpanding = tabsTo > tabsFrom;
		const options = { duration: TABS_ANIMATION_MS, easing: TABS_EASING };

		const animateSection = (
			element: HTMLElement,
			from: number,
			to: number,
			needsFlexOverride: boolean,
		) => {
			element.style.overflow = "hidden";
			if (needsFlexOverride) {
				element.style.flex = "none";
			}
			const animation = element.animate(
				[{ height: `${from}px` }, { height: `${to}px` }],
				options,
			);
			animation.onfinish = animation.oncancel = () => {
				element.style.overflow = "";
				if (needsFlexOverride) {
					element.style.flex = "";
				}
			};
		};

		animateSection(tabsElement, tabsFrom, tabsTo, isExpanding);
		if (actionsElement && actionsFrom !== actionsTo) {
			animateSection(actionsElement, actionsFrom, actionsTo, !isExpanding);
		}
	}, []);

	useEffect(() => {
		if (!resizeState) {
			return;
		}

		let pendingChanges: number | null = null;
		let pendingActions: number | null = null;
		let animationFrameId: number | null = null;
		const flush = () => {
			animationFrameId = null;
			if (pendingChanges !== null) {
				const next = pendingChanges;
				pendingChanges = null;
				setChangesHeight(next);
			}
			if (pendingActions !== null) {
				const next = pendingActions;
				pendingActions = null;
				setActionsHeight(next);
			}
		};

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
				pendingChanges = nextChanges;
				pendingActions = nextActions;
			} else {
				pendingActions = Math.max(
					MIN_SECTION_HEIGHT,
					resizeState.initialActionsHeight + deltaY,
				);
			}

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
			event.preventDefault();
			setResizeState({
				pointerY: event.clientY,
				initialChangesHeight: changesHeight,
				initialActionsHeight: actionsHeight,
				target,
			});
		},
		[actionsHeight, changesHeight],
	);

	const clearPendingRunScript = useCallback(
		() => setPendingRunScript(false),
		[],
	);

	return {
		actionsHeight,
		actionsRef,
		activeTab,
		changes,
		changesHeight,
		clearPendingRunScript,
		containerRef,
		flashingPaths,
		handleResizeStart,
		handleToggleTabs,
		isActionsResizing,
		isResizing,
		isTabsResizing,
		pendingRunScript,
		repoScripts,
		scriptsLoaded,
		setActiveTab,
		tabsOpen,
		tabsWrapperRef,
	};
}
