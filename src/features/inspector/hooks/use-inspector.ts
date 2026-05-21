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
import {
	suspendTerminalFit,
	suspendTerminalWrites,
} from "@/components/terminal-output";
import { loadRepoScripts, type RepoScripts } from "@/lib/api";
import type { InspectorFileItem } from "@/lib/editor-session";
import { workspaceChangesQueryOptions } from "@/lib/query-client";
import {
	getInitialActionsOpen,
	getInitialActiveTab,
	getInitialChangesHeight,
	getInitialTabsHeight,
	getInitialTabsOpen,
	INSPECTOR_ACTIONS_BODY_VAR,
	INSPECTOR_ACTIONS_OPEN_STORAGE_KEY,
	INSPECTOR_ACTIVE_TAB_STORAGE_KEY,
	INSPECTOR_CHANGES_BODY_VAR,
	INSPECTOR_CHANGES_HEIGHT_STORAGE_KEY,
	INSPECTOR_SECTION_HEADER_HEIGHT,
	INSPECTOR_TABS_BODY_VAR,
	INSPECTOR_TABS_HEIGHT_STORAGE_KEY,
	INSPECTOR_TABS_OPEN_STORAGE_KEY,
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
	tabsOpen: boolean;
};

function writeBodyVars(container: HTMLElement | null, sizes: DerivedSizes) {
	if (!container) return;
	container.style.setProperty(
		INSPECTOR_CHANGES_BODY_VAR,
		`${sizes.changesBody}px`,
	);
	container.style.setProperty(
		INSPECTOR_ACTIONS_BODY_VAR,
		`${sizes.actionsBody}px`,
	);
	container.style.setProperty(INSPECTOR_TABS_BODY_VAR, `${sizes.tabsBody}px`);
}

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
	workspaceState,
}: UseWorkspaceInspectorSidebarArgs) {
	const [actionsOpen, setActionsOpen] = useState(getInitialActionsOpen);
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
	const [storedChangesBody, setStoredChangesBody] = useState(() =>
		getInitialChangesHeight(DEFAULT_CHANGES_BODY),
	);
	const [storedTabsBody, setStoredTabsBody] = useState(() =>
		getInitialTabsHeight(DEFAULT_TABS_BODY),
	);
	const [resizeState, setResizeState] = useState<ResizeState | null>(null);

	const containerRef = useRef<HTMLDivElement>(null);
	const tabsWrapperRef = useRef<HTMLDivElement>(null);
	const actionsRef = useRef<HTMLElement>(null);

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

	// During drag, mousemove writes the CSS vars directly and React state
	// stays stale until mouseup commits. This effect only handles non-drag
	// cases (toggle, keyboard step, initial mount); the isResizingRef gate
	// prevents stale state from clobbering the live mousemove values mid-drag.
	const isResizingRef = useRef(false);
	useLayoutEffect(() => {
		if (isResizingRef.current) return;
		writeBodyVars(containerRef.current, {
			changesBody,
			actionsBody,
			tabsBody,
		});
	}, [changesBody, actionsBody, tabsBody]);

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

	const handleToggleTabs = useCallback(() => {
		setTabsOpen((open) => !open);
	}, []);

	const handleToggleActions = useCallback(() => {
		setActionsOpen((open) => !open);
	}, []);

	useEffect(() => {
		if (!resizeState) {
			return;
		}

		isResizingRef.current = true;
		// Vertical section resize can pause terminal work; horizontal shell
		// resize stays live so the sidebar never appears frozen.
		const releaseFitSuspend = suspendTerminalFit();
		const releaseWriteSuspend = suspendTerminalWrites();

		const captured = resizeState;
		const container = containerRef.current;

		let pendingMove: globalThis.MouseEvent | null = null;
		let animationFrameId: number | null = null;
		let lastStoredChanges: number = captured.initialChangesBody;
		let lastStoredTabs: number = captured.initialTabsBody;

		const flush = () => {
			animationFrameId = null;
			const event = pendingMove;
			pendingMove = null;
			if (!event) return;
			const deltaY = event.clientY - captured.pointerY;

			if (captured.target === RESIZE_TARGET_ACTIONS) {
				// Drag down → changes grows, actions auto-shrinks.
				const max = Math.max(
					MIN_CHANGES_BODY,
					captured.bodyBudget - captured.tabsBody - MIN_ACTIONS_BODY,
				);
				lastStoredChanges = clamp(
					captured.initialChangesBody + deltaY,
					MIN_CHANGES_BODY,
					max,
				);
			} else {
				// Drag down → tabs shrinks, upper region (actions or changes) grows.
				const upperMin =
					MIN_CHANGES_BODY + (captured.actionsOpen ? MIN_ACTIONS_BODY : 0);
				const max = Math.max(MIN_TABS_BODY, captured.bodyBudget - upperMin);
				lastStoredTabs = clamp(
					captured.initialTabsBody - deltaY,
					MIN_TABS_BODY,
					max,
				);
			}

			// Derive sizes and write CSS vars directly — no setState, no React
			// render. The three sections read via var(--inspector-X-body-height).
			const sizes = deriveSizes({
				bodyBudget: captured.bodyBudget,
				actionsOpen: captured.actionsOpen,
				tabsOpen: captured.tabsOpen,
				storedChangesBody: lastStoredChanges,
				storedTabsBody: lastStoredTabs,
			});
			writeBodyVars(container, sizes);
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
			// Commit the final value back to React state for localStorage
			// persistence and any external consumers. Same-value setState is a no-op.
			isResizingRef.current = false;
			if (captured.target === RESIZE_TARGET_ACTIONS) {
				if (lastStoredChanges !== captured.initialChangesBody) {
					setStoredChangesBody(lastStoredChanges);
				}
			} else {
				if (lastStoredTabs !== captured.initialTabsBody) {
					setStoredTabsBody(lastStoredTabs);
				}
			}
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
			isResizingRef.current = false;
			releaseFitSuspend();
			releaseWriteSuspend();
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
				tabsOpen,
			});
		},
		[
			storedChangesBody,
			storedTabsBody,
			bodyBudget,
			tabsBody,
			actionsOpen,
			tabsOpen,
		],
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
