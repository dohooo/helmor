import { useQuery } from "@tanstack/react-query";
import {
	type MouseEvent as ReactMouseEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	clampVerticalSplitSizes,
	getInitialVerticalSplitSizes,
	openVerticalSplitPanel,
	resizeVerticalSplitPanel,
	type VerticalSplitPanelConfig,
	type VerticalSplitPanelId,
	type VerticalSplitPanelSizeState,
} from "@/components/ui/vertical-split-layout";
import { loadRepoScripts, type RepoScripts } from "@/lib/api";
import type { InspectorFileItem } from "@/lib/editor-session";
import { workspaceChangesQueryOptions } from "@/lib/query-client";
import { INSPECTOR_SECTION_HEADER_HEIGHT } from "../layout";
import { getScriptState, startScript, stopScript } from "../script-store";

type ResizeState = {
	pointerY: number;
	initialSizes: VerticalSplitPanelSizeState;
	target: VerticalSplitPanelId;
};

const INSPECTOR_PRIMARY_PANEL_ID = "changes";
const INSPECTOR_ACTIONS_PANEL_ID = "actions";
const INSPECTOR_TERMINAL_PANEL_ID = "terminal";
const MIN_INSPECTOR_PRIMARY_HEIGHT = 128;
const MIN_INSPECTOR_ACTIONS_HEIGHT = 112;
const MIN_INSPECTOR_TERMINAL_HEIGHT = 160;

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
	const [actionsOpen, setActionsOpen] = useState(true);
	const [tabsOpen, setTabsOpen] = useState(false);
	const [activeTab, setActiveTab] = useState("setup");
	const inspectorPanels = useMemo<VerticalSplitPanelConfig[]>(
		() => [
			{
				id: INSPECTOR_PRIMARY_PANEL_ID,
				open: true,
				minSize: MIN_INSPECTOR_PRIMARY_HEIGHT,
				defaultSize: 240,
			},
			{
				id: INSPECTOR_ACTIONS_PANEL_ID,
				open: actionsOpen,
				minSize: MIN_INSPECTOR_ACTIONS_HEIGHT,
				// First open uses minSize. Resizing then "remembers" the user's
				// last height so subsequent toggles restore it.
				defaultSize: MIN_INSPECTOR_ACTIONS_HEIGHT,
			},
			{
				id: INSPECTOR_TERMINAL_PANEL_ID,
				open: tabsOpen,
				minSize: MIN_INSPECTOR_TERMINAL_HEIGHT,
				defaultSize: MIN_INSPECTOR_TERMINAL_HEIGHT,
			},
		],
		[actionsOpen, tabsOpen],
	);
	const [panelSizes, setPanelSizes] = useState<VerticalSplitPanelSizeState>(
		() => getInitialVerticalSplitSizes(inspectorPanels),
	);
	const [resizeState, setResizeState] = useState<ResizeState | null>(null);

	const containerRef = useRef<HTMLDivElement>(null);
	const tabsWrapperRef = useRef<HTMLDivElement>(null);
	const actionsRef = useRef<HTMLElement>(null);

	useEffect(() => {
		const element = containerRef.current;
		if (!element) return;

		let frameId: number | null = null;
		const resizeObserver = new ResizeObserver((entries) => {
			const entry = entries[0];
			if (!entry) return;
			if (frameId !== null) {
				cancelAnimationFrame(frameId);
			}
			frameId = requestAnimationFrame(() => {
				frameId = null;
				const containerSize = entry.contentRect.height;
				setPanelSizes((current) =>
					clampVerticalSplitSizes({
						containerSize,
						headerSize: INSPECTOR_SECTION_HEADER_HEIGHT,
						minPrimarySize: MIN_INSPECTOR_PRIMARY_HEIGHT,
						primaryPanelId: INSPECTOR_PRIMARY_PANEL_ID,
						panels: inspectorPanels,
						sizes: current,
					}),
				);
			});
		});

		resizeObserver.observe(element);
		return () => {
			if (frameId !== null) {
				cancelAnimationFrame(frameId);
			}
			resizeObserver.disconnect();
		};
	}, [inspectorPanels]);

	const repoScriptsQuery = useQuery({
		queryKey: ["repoScripts", repoId, workspaceId],
		queryFn: () => loadRepoScripts(repoId!, workspaceId),
		enabled: !!repoId,
		staleTime: 0,
	});
	const repoScripts: RepoScripts | null = repoScriptsQuery.data ?? null;
	const scriptsLoaded = repoScriptsQuery.isFetched;

	// Listen for Cmd+R "run script" shortcut event. Toggles run/stop:
	// idle/exited → start; running → stop. Tab visibility is unchanged —
	// the user can open the Run tab later to see output; it's replayed
	// from buffer.
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
	const isActionsResizing = resizeState?.target === INSPECTOR_ACTIONS_PANEL_ID;
	const isTabsResizing = resizeState?.target === INSPECTOR_TERMINAL_PANEL_ID;

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

	// Closing only flips `open`; sizes stay in `panelSizes` so reopening
	// restores the panel's last height. The primary panel auto-grows via
	// `getPrimaryPanelSize`, which only sums open secondary panels.
	const handleToggleTabs = useCallback(() => {
		if (tabsOpen) {
			setTabsOpen(false);
			return;
		}
		setPanelSizes((current) =>
			openVerticalSplitPanel({
				containerSize: containerRef.current?.clientHeight ?? 0,
				headerSize: INSPECTOR_SECTION_HEADER_HEIGHT,
				minPrimarySize: MIN_INSPECTOR_PRIMARY_HEIGHT,
				primaryPanelId: INSPECTOR_PRIMARY_PANEL_ID,
				panels: inspectorPanels,
				sizes: current,
				panelId: INSPECTOR_TERMINAL_PANEL_ID,
			}),
		);
		setTabsOpen(true);
	}, [inspectorPanels, tabsOpen]);

	const handleToggleActions = useCallback(() => {
		if (actionsOpen) {
			setActionsOpen(false);
			return;
		}
		setPanelSizes((current) =>
			openVerticalSplitPanel({
				containerSize: containerRef.current?.clientHeight ?? 0,
				headerSize: INSPECTOR_SECTION_HEADER_HEIGHT,
				minPrimarySize: MIN_INSPECTOR_PRIMARY_HEIGHT,
				primaryPanelId: INSPECTOR_PRIMARY_PANEL_ID,
				panels: inspectorPanels,
				sizes: current,
				panelId: INSPECTOR_ACTIONS_PANEL_ID,
			}),
		);
		setActionsOpen(true);
	}, [actionsOpen, inspectorPanels]);

	useEffect(() => {
		if (!resizeState) {
			return;
		}

		let pendingSizes: VerticalSplitPanelSizeState | null = null;
		let animationFrameId: number | null = null;
		const flush = () => {
			animationFrameId = null;
			if (pendingSizes !== null) {
				const next = pendingSizes;
				pendingSizes = null;
				setPanelSizes(next);
			}
		};

		const handleMouseMove = (event: globalThis.MouseEvent) => {
			const deltaY = event.clientY - resizeState.pointerY;
			pendingSizes = resizeVerticalSplitPanel({
				containerSize: containerRef.current?.clientHeight ?? 0,
				headerSize: INSPECTOR_SECTION_HEADER_HEIGHT,
				minPrimarySize: MIN_INSPECTOR_PRIMARY_HEIGHT,
				primaryPanelId: INSPECTOR_PRIMARY_PANEL_ID,
				panels: inspectorPanels,
				sizes: resizeState.initialSizes,
				panelId: resizeState.target,
				deltaY,
			});

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
	}, [inspectorPanels, resizeState]);

	const handleResizeStart = useCallback(
		(target: VerticalSplitPanelId) =>
			(event: ReactMouseEvent<HTMLDivElement>) => {
				if (event.button !== 0) return;
				event.preventDefault();
				setResizeState({
					pointerY: event.clientY,
					initialSizes: panelSizes,
					target,
				});
			},
		[panelSizes],
	);

	return {
		actionsHeight:
			panelSizes[INSPECTOR_ACTIONS_PANEL_ID] ?? MIN_INSPECTOR_ACTIONS_HEIGHT,
		actionsOpen,
		actionsRef,
		activeTab,
		changes,
		containerRef,
		flashingPaths,
		handleResizeStart,
		handleToggleActions,
		handleToggleTabs,
		isActionsResizing,
		isResizing,
		isTabsResizing,
		repoScripts,
		scriptsLoaded,
		setActiveTab,
		tabsBodyHeight:
			panelSizes[INSPECTOR_TERMINAL_PANEL_ID] ?? MIN_INSPECTOR_TERMINAL_HEIGHT,
		tabsOpen,
		tabsWrapperRef,
	};
}
