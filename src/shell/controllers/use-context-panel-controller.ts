// Context-panel controller: owns the right-sidebar mode (inspector vs.
// context-cards), the inspector-collapsed flag, and the workspace/start
// preview-card slots. Settings hydration runs once when settings load and
// picks the initial right-sidebar layout based on `lastSurface`.
import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppSettings, WorkspaceRightSidebarMode } from "@/lib/settings";
import type { ContextCard } from "@/lib/sources/types";
import type { ShellViewMode } from "@/shell/controllers/use-selection-controller";
import { useShellEvent } from "@/shell/event-bus";
import {
	useLatestRef,
	useStableActions,
} from "@/shell/hooks/use-stable-actions";

export type ContextPanelState = {
	rightSidebarMode: WorkspaceRightSidebarMode;
	inspectorCollapsed: boolean;
	workspacePreviewCard: ContextCard | null;
	workspacePreviewActive: boolean;
	startPreviewCard: ContextCard | null;
	rightSidebarAvailable: boolean;
	contextPanelOpen: boolean;
};

export type ContextPanelActions = {
	setInspectorCollapsed: Dispatch<SetStateAction<boolean>>;
	toggleContextPanel(): void;
	openWorkspaceContextCard(card: ContextCard): void;
	selectWorkspaceContextPreview(): void;
	closeWorkspaceContextPreview(): void;
	// Deactivates the workspace preview without dropping the card — used
	// when the user switches sessions but might want to peek back at the
	// preview from the inspector.
	deactivateWorkspaceContextPreview(): void;
	clearWorkspacePreview(): void;
	openStartContextCard(card: ContextCard): void;
	closeStartContextPreview(): void;
	// Called by AppShell's `handleSelectWorkspace` wrapper on every workspace
	// click (including reselect) so the right sidebar follows the user's
	// persisted preference.
	syncToWorkspaceMode(): void;
	// Called by selection's `onStartOpened` to align the right sidebar with
	// `startContextPanelOpen` and reveal the panel if it was collapsed.
	syncToStartMode(): void;
};

export type ContextPanelController = {
	state: ContextPanelState;
	actions: ContextPanelActions;
};

export type ContextPanelControllerDeps = {
	appSettings: AppSettings;
	areSettingsLoaded: boolean;
	updateSettings: (patch: Partial<AppSettings>) => void | Promise<void>;
	getViewMode(): ShellViewMode;
};

export function useContextPanelController(
	deps: ContextPanelControllerDeps,
): ContextPanelController {
	const { appSettings, areSettingsLoaded, updateSettings } = deps;

	const [rightSidebarMode, setRightSidebarMode] =
		useState<WorkspaceRightSidebarMode>("inspector");
	const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
	const [workspacePreviewCard, setWorkspacePreviewCard] =
		useState<ContextCard | null>(null);
	const [workspacePreviewActive, setWorkspacePreviewActive] = useState(false);
	const [startPreviewCard, setStartPreviewCard] = useState<ContextCard | null>(
		null,
	);

	const getViewModeRef = useLatestRef(deps.getViewMode);

	// One-shot hydration when settings load. Restores the right-sidebar
	// layout the user last saw, gated by which surface (workspace vs.
	// workspace-start) the app is about to render.
	const hydratedRef = useRef(false);
	useEffect(() => {
		if (!areSettingsLoaded || hydratedRef.current) return;
		hydratedRef.current = true;

		if (appSettings.lastSurface === "workspace-start") {
			setRightSidebarMode(
				appSettings.startContextPanelOpen ? "context" : "inspector",
			);
			if (appSettings.startContextPanelOpen) {
				setInspectorCollapsed(false);
			}
			return;
		}

		setRightSidebarMode(appSettings.workspaceRightSidebarMode);
		if (appSettings.workspaceRightSidebarMode === "context") {
			setInspectorCollapsed(false);
		}
	}, [
		appSettings.lastSurface,
		appSettings.startContextPanelOpen,
		appSettings.workspaceRightSidebarMode,
		areSettingsLoaded,
	]);

	const toggleContextPanel = useCallback(() => {
		const viewMode = getViewModeRef.current();
		if (rightSidebarMode === "context" && !inspectorCollapsed) {
			if (viewMode === "start") {
				setInspectorCollapsed(true);
				void updateSettings({ startContextPanelOpen: false });
			} else {
				setRightSidebarMode("inspector");
				void updateSettings({ workspaceRightSidebarMode: "inspector" });
			}
			return;
		}

		setRightSidebarMode("context");
		setInspectorCollapsed(false);
		if (viewMode === "start") {
			void updateSettings({ startContextPanelOpen: true });
		} else {
			void updateSettings({ workspaceRightSidebarMode: "context" });
		}
	}, [inspectorCollapsed, rightSidebarMode, updateSettings]);

	useShellEvent("toggle-context-panel", toggleContextPanel);

	const openWorkspaceContextCard = useCallback((card: ContextCard) => {
		setWorkspacePreviewCard(card);
		setWorkspacePreviewActive(true);
	}, []);

	const selectWorkspaceContextPreview = useCallback(() => {
		setWorkspacePreviewActive(true);
	}, []);

	const closeWorkspaceContextPreview = useCallback(() => {
		setWorkspacePreviewCard(null);
		setWorkspacePreviewActive(false);
	}, []);

	const deactivateWorkspaceContextPreview = useCallback(() => {
		setWorkspacePreviewActive(false);
	}, []);

	const clearWorkspacePreview = useCallback(() => {
		setWorkspacePreviewCard(null);
		setWorkspacePreviewActive(false);
	}, []);

	const openStartContextCard = useCallback((card: ContextCard) => {
		setStartPreviewCard(card);
	}, []);

	const closeStartContextPreview = useCallback(() => {
		setStartPreviewCard(null);
	}, []);

	const syncToWorkspaceMode = useCallback(() => {
		setRightSidebarMode(appSettings.workspaceRightSidebarMode);
		if (appSettings.workspaceRightSidebarMode === "context") {
			setInspectorCollapsed(false);
		}
	}, [appSettings.workspaceRightSidebarMode]);

	const syncToStartMode = useCallback(() => {
		setRightSidebarMode(
			appSettings.startContextPanelOpen ? "context" : "inspector",
		);
		if (appSettings.startContextPanelOpen) {
			setInspectorCollapsed(false);
		}
	}, [appSettings.startContextPanelOpen]);

	const viewModeForDerived = deps.getViewMode();
	const rightSidebarAvailable =
		viewModeForDerived !== "start" || rightSidebarMode === "context";
	const contextPanelOpen =
		rightSidebarAvailable &&
		rightSidebarMode === "context" &&
		!inspectorCollapsed;

	const actions = useStableActions<ContextPanelActions>({
		setInspectorCollapsed,
		toggleContextPanel,
		openWorkspaceContextCard,
		selectWorkspaceContextPreview,
		closeWorkspaceContextPreview,
		deactivateWorkspaceContextPreview,
		clearWorkspacePreview,
		openStartContextCard,
		closeStartContextPreview,
		syncToWorkspaceMode,
		syncToStartMode,
	});

	const state = useMemo<ContextPanelState>(
		() => ({
			rightSidebarMode,
			inspectorCollapsed,
			workspacePreviewCard,
			workspacePreviewActive,
			startPreviewCard,
			rightSidebarAvailable,
			contextPanelOpen,
		}),
		[
			rightSidebarMode,
			inspectorCollapsed,
			workspacePreviewCard,
			workspacePreviewActive,
			startPreviewCard,
			rightSidebarAvailable,
			contextPanelOpen,
		],
	);

	return { state, actions };
}
