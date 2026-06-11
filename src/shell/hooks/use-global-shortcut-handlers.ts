import { type Dispatch, type SetStateAction, useMemo } from "react";
import type { WorkspaceCommitButtonMode } from "@/features/commit/button";
import type { QuickSwitchControls } from "@/features/quick-switch";
import {
	type ShortcutHandler,
	useAppShortcuts,
} from "@/features/shortcuts/use-app-shortcuts";
import { closeMainWindow, hideQuickPanel } from "@/lib/api";
import type { AppSettings } from "@/lib/settings";
import { isQuickPanelWindow } from "@/lib/window-role";
import type { ContextPanelActions } from "@/shell/controllers/use-context-panel-controller";
import { publishShellEvent } from "@/shell/event-bus";
import { clampZoom, ZOOM_STEP } from "@/shell/use-zoom";

/**
 * Assembles the full `ShortcutHandler[]` table AppShell feeds to
 * `useAppShortcuts`, then registers the global keydown listener. Extracted
 * verbatim from AppShell. The memo body and its dependency array are preserved
 * exactly (including the deliberate omission of the stable `contextPanelActions`
 * identity from deps); every `enabled` predicate and callback is unchanged.
 */
export function useGlobalShortcutHandlers({
	appSettings,
	updateSettings,
	contextPanelActions,
	canEditEditorSession,
	getCloseableCurrentSession,
	handleCloseSelectedSession,
	handleCopyWorkspacePath,
	handleCreateSession,
	handleCommitAction,
	handleInspectorCommitAction,
	handleNavigateSessions,
	handleNavigateWorkspaces,
	handleOpenModelPicker,
	handleOpenPreferredEditor,
	handleOpenPullRequest,
	handleOpenSettings,
	handleEnterEditorEditMode,
	handlePullLatest,
	handleReopenClosedSession,
	handleToggleMiniMode,
	handleToggleTheme,
	handleToggleZenMode,
	preferredEditor,
	pullRequestUrl,
	quickSwitch,
	selectedWorkspaceId,
	setInspectorCollapsed,
	setSidebarCollapsed,
	workspaceRootPath,
	workspacePreviewActive,
	workspacePreviewCard,
	workspaceViewMode,
}: {
	appSettings: AppSettings;
	updateSettings: (patch: Partial<AppSettings>) => void | Promise<void>;
	contextPanelActions: ContextPanelActions;
	canEditEditorSession: boolean;
	getCloseableCurrentSession: () => unknown;
	handleCloseSelectedSession: () => Promise<void>;
	handleCopyWorkspacePath: () => void;
	handleCreateSession: () => Promise<string | null | undefined>;
	handleCommitAction: (mode: WorkspaceCommitButtonMode) => Promise<void>;
	handleInspectorCommitAction: (
		mode: WorkspaceCommitButtonMode,
		overrides?: {
			modelId?: string | null;
			effort?: string | null;
			fastMode?: boolean | null;
		},
	) => Promise<void>;
	handleNavigateSessions: (offset: -1 | 1) => void;
	handleNavigateWorkspaces: (offset: -1 | 1) => void;
	handleOpenModelPicker: () => void;
	handleOpenPreferredEditor: () => void;
	handleOpenPullRequest: () => void;
	handleOpenSettings: () => void;
	handleEnterEditorEditMode: () => void;
	handlePullLatest: () => Promise<void>;
	handleReopenClosedSession: () => Promise<void> | void;
	handleToggleMiniMode: () => void;
	handleToggleTheme: () => void;
	handleToggleZenMode: () => void;
	preferredEditor: { id: string; name: string } | null;
	pullRequestUrl: string | null;
	quickSwitch: QuickSwitchControls;
	selectedWorkspaceId: string | null;
	setInspectorCollapsed: Dispatch<SetStateAction<boolean>>;
	setSidebarCollapsed: Dispatch<SetStateAction<boolean>>;
	workspaceRootPath: string | null;
	workspacePreviewActive: boolean;
	workspacePreviewCard: unknown;
	workspaceViewMode: string;
}): void {
	const globalShortcutHandlers = useMemo<ShortcutHandler[]>(
		() => [
			{
				id: "settings.open" as const,
				callback: handleOpenSettings,
			},
			{
				id: "workspace.copyPath" as const,
				callback: handleCopyWorkspacePath,
				enabled: Boolean(workspaceRootPath),
			},
			{
				id: "workspace.openInEditor" as const,
				callback: handleOpenPreferredEditor,
				enabled: Boolean(selectedWorkspaceId && preferredEditor),
			},
			{
				id: "workspace.new" as const,
				callback: () => publishShellEvent({ type: "open-new-workspace" }),
			},
			{
				id: "workspace.justChat" as const,
				callback: () =>
					publishShellEvent({ type: "open-new-workspace", mode: "chat" }),
			},
			{
				id: "workspace.addRepository" as const,
				callback: () => publishShellEvent({ type: "open-add-repository" }),
			},
			{
				id: "workspace.filterSidebar" as const,
				callback: () => publishShellEvent({ type: "open-sidebar-filter" }),
			},
			{
				id: "workspace.previous" as const,
				callback: () => handleNavigateWorkspaces(-1),
				repeatable: true,
			},
			{
				id: "workspace.next" as const,
				callback: () => handleNavigateWorkspaces(1),
				repeatable: true,
			},
			{
				id: "workspace.quickSwitchNext" as const,
				callback: () => quickSwitch.open("next"),
				// The quick-switch overlay lives in AppOverlays, which the quick
				// panel doesn't mount — opening it there would set invisible state.
				enabled: !isQuickPanelWindow,
			},
			{
				id: "workspace.quickSwitchPrevious" as const,
				callback: () => quickSwitch.open("previous"),
				enabled: !isQuickPanelWindow,
			},
			{
				id: "session.previous" as const,
				callback: () => handleNavigateSessions(-1),
				enabled: workspaceViewMode === "conversation",
				repeatable: true,
			},
			{
				id: "session.next" as const,
				callback: () => handleNavigateSessions(1),
				enabled: workspaceViewMode === "conversation",
				repeatable: true,
			},
			{
				id: "session.close" as const,
				callback: () => {
					if (workspacePreviewActive && workspacePreviewCard) {
						contextPanelActions.closeWorkspaceContextPreview();
						return;
					}
					if (!getCloseableCurrentSession()) return;
					void handleCloseSelectedSession();
				},
				enabled:
					workspaceViewMode === "conversation" &&
					(Boolean(workspacePreviewCard) ||
						Boolean(getCloseableCurrentSession())),
			},
			{
				id: "session.new" as const,
				callback: (): void => void handleCreateSession(),
				enabled: workspaceViewMode === "conversation",
			},
			{
				id: "session.reopenClosed" as const,
				callback: () => void handleReopenClosedSession(),
			},
			{
				id: "window.close" as const,
				// In the quick panel "close window" dismisses the panel itself —
				// it must never close the (possibly hidden) main window.
				callback: () =>
					void (isQuickPanelWindow ? hideQuickPanel() : closeMainWindow()),
			},
			{
				id: "script.run" as const,
				callback: () => publishShellEvent({ type: "run-script" }),
			},
			{
				id: "theme.toggle" as const,
				callback: handleToggleTheme,
			},
			{
				id: "window.miniMode.toggle" as const,
				callback: handleToggleMiniMode,
				// Mini mode resizes the INVOKING window; meaningless for the panel.
				enabled: !isQuickPanelWindow,
			},
			{
				id: "sidebar.left.toggle" as const,
				callback: () => setSidebarCollapsed((collapsed) => !collapsed),
			},
			{
				id: "sidebar.right.toggle" as const,
				callback: () => setInspectorCollapsed((collapsed) => !collapsed),
			},
			{
				id: "zen.toggle" as const,
				callback: handleToggleZenMode,
			},
			{
				id: "action.createPr" as const,
				callback: () => void handleCommitAction("create-pr"),
			},
			{
				id: "action.commitAndPush" as const,
				callback: () => void handleCommitAction("commit-and-push"),
			},
			{
				id: "action.pullLatest" as const,
				callback: () => void handlePullLatest(),
				enabled: Boolean(selectedWorkspaceId),
			},
			{
				id: "action.mergePr" as const,
				callback: () => void handleInspectorCommitAction("merge"),
			},
			{
				id: "action.fixErrors" as const,
				callback: () => void handleInspectorCommitAction("fix"),
			},
			{
				id: "action.openPullRequest" as const,
				callback: handleOpenPullRequest,
				enabled: Boolean(pullRequestUrl),
			},
			{
				id: "composer.focus" as const,
				callback: () => publishShellEvent({ type: "focus-composer" }),
				enabled:
					workspaceViewMode === "conversation" || workspaceViewMode === "start",
			},
			{
				id: "composer.openModelPicker" as const,
				callback: handleOpenModelPicker,
				enabled: workspaceViewMode === "conversation",
			},
			{
				id: "editor.edit" as const,
				callback: handleEnterEditorEditMode,
				enabled: workspaceViewMode === "editor" && canEditEditorSession,
			},
			{
				id: "composer.toggleContextPanel" as const,
				callback: () => publishShellEvent({ type: "toggle-context-panel" }),
				enabled:
					workspaceViewMode === "conversation" || workspaceViewMode === "start",
			},
			{
				id: "zoom.in" as const,
				callback: () =>
					updateSettings({
						zoomLevel: clampZoom(appSettings.zoomLevel + ZOOM_STEP),
					}),
			},
			{
				id: "zoom.out" as const,
				callback: () =>
					updateSettings({
						zoomLevel: clampZoom(appSettings.zoomLevel - ZOOM_STEP),
					}),
			},
			{
				id: "zoom.reset" as const,
				callback: () => updateSettings({ zoomLevel: 1.0 }),
			},
		],
		[
			appSettings.zoomLevel,
			getCloseableCurrentSession,
			handleCloseSelectedSession,
			handleCopyWorkspacePath,
			handleCreateSession,
			handleCommitAction,
			handleInspectorCommitAction,
			handleNavigateSessions,
			handleNavigateWorkspaces,
			handleOpenModelPicker,
			handleOpenPreferredEditor,
			handleOpenPullRequest,
			handleOpenSettings,
			handleEnterEditorEditMode,
			handlePullLatest,
			handleReopenClosedSession,
			handleToggleMiniMode,
			handleToggleTheme,
			handleToggleZenMode,
			preferredEditor,
			pullRequestUrl,
			quickSwitch,
			selectedWorkspaceId,
			setInspectorCollapsed,
			setSidebarCollapsed,
			updateSettings,
			workspaceRootPath,
			workspacePreviewActive,
			workspacePreviewCard,
			workspaceViewMode,
			canEditEditorSession,
		],
	);
	useAppShortcuts({
		overrides: appSettings.shortcuts,
		handlers: globalShortcutHandlers,
	});
}
