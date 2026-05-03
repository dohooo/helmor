import { useCallback, useEffect, useMemo, useState } from "react";
import { VerticalSplitPanelGroup } from "@/components/ui/vertical-split-panel-group";
import type {
	CommitButtonState,
	WorkspaceCommitButtonMode,
} from "@/features/commit/button";
import {
	type ShortcutHandler,
	useAppShortcuts,
} from "@/features/shortcuts/use-app-shortcuts";
import type { ChangeRequestInfo } from "@/lib/api";
import type { DiffOpenOptions } from "@/lib/editor-session";
import { useSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { useWorkspaceInspectorSidebar } from "./hooks/use-inspector";
import { useScriptStatus } from "./hooks/use-script-status";
import { useSetupAutoRun } from "./hooks/use-setup-auto-run";
import { HorizontalResizeHandle, InspectorTabsSection } from "./layout";
import type { ScriptStatus } from "./script-store";
import { ActionsSection } from "./sections/actions";
import { ChangesSection } from "./sections/changes";
import { OpenDevServerButton, RunTab } from "./sections/run";
import { SetupTab } from "./sections/setup";
import { TerminalInstancePanel } from "./sections/terminal";
import {
	closeTerminal,
	createTerminal,
	setTerminalHoverZoomDisabled,
	subscribeToWorkspaceList,
	TERMINAL_INSTANCE_LIMIT,
	type TerminalInstance,
} from "./terminal-store";

type WorkspaceInspectorSidebarProps = {
	workspaceId?: string | null;
	repoId?: string | null;
	workspaceRootPath?: string | null;
	workspaceBranch?: string | null;
	workspaceTargetBranch?: string | null;
	workspaceRemote?: string | null;
	workspaceState?: string | null;
	editorMode: boolean;
	activeEditorPath?: string | null;
	onOpenEditorFile(path: string, options?: DiffOpenOptions): void;
	onOpenMockReview?: (path: string) => void;
	onCommitAction?: (mode: WorkspaceCommitButtonMode) => Promise<void>;
	onReviewAction?: () => Promise<void>;
	currentSessionId?: string | null;
	onQueuePendingPromptForSession?: (request: {
		sessionId: string;
		prompt: string;
		modelId?: string | null;
		permissionMode?: string | null;
		forceQueue?: boolean;
	}) => void;
	commitButtonMode?: WorkspaceCommitButtonMode;
	commitButtonState?: CommitButtonState;
	changeRequest?: ChangeRequestInfo | null;
	/**
	 * True only on the first cold fetch of either the PR change request or
	 * the forge action status — drives the git-header shimmer. Owned by App.
	 */
	forgeIsRefreshing?: boolean;
	onOpenSettings?: () => void;
};

export function WorkspaceInspectorSidebar({
	workspaceId,
	workspaceRootPath,
	workspaceTargetBranch,
	workspaceRemote,
	workspaceState,
	repoId,
	editorMode,
	activeEditorPath,
	onOpenEditorFile,
	onCommitAction,
	onReviewAction,
	currentSessionId,
	onQueuePendingPromptForSession,
	commitButtonMode,
	commitButtonState,
	changeRequest,
	forgeIsRefreshing = false,
	onOpenSettings,
}: WorkspaceInspectorSidebarProps) {
	const {
		actionsHeight,
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
		tabsBodyHeight,
		tabsOpen,
		tabsWrapperRef,
	} = useWorkspaceInspectorSidebar({
		workspaceRootPath,
		workspaceId: workspaceId ?? null,
		repoId: repoId ?? null,
	});

	// Fire setup auto-run / auto-complete at the sidebar level so it runs even
	// when the Setup tab isn't mounted (tabsOpen=false).
	useSetupAutoRun({
		repoId: repoId ?? null,
		workspaceId: workspaceId ?? null,
		workspaceState: workspaceState ?? null,
		setupScript: repoScripts?.setupScript ?? null,
		scriptsLoaded,
	});

	// Run-script state lifted to the sidebar so the tab header can render
	// the "Open dev server" shortcut. The button only appears while the
	// run script is actually running (a "resident" dev server). Once it's
	// visible it self-tunes: disabled "Open" until a URL is detected in
	// stdout, "Open:PORT" for a single URL, or a hover picker for 2+.
	const [runStatus, setRunStatus] = useState<ScriptStatus>("idle");
	const [runUrls, setRunUrls] = useState<string[]>([]);

	const runTabActions =
		runStatus === "running" ? <OpenDevServerButton urls={runUrls} /> : null;

	// Per-tab status for the small indicator rendered next to each tab label.
	// Subscribes at the sidebar level so the icons stay live even when the
	// tab body itself is collapsed / not mounted.
	const setupScriptState = useScriptStatus(
		workspaceId ?? null,
		"setup",
		!!repoScripts?.setupScript?.trim(),
	);
	const runScriptState = useScriptStatus(
		workspaceId ?? null,
		"run",
		!!repoScripts?.runScript?.trim(),
	);

	// Live list of Terminal sub-tabs for the current workspace, observed at
	// the sidebar level so each terminal can be rendered as its own tab in
	// the unified Setup / Run / Terminals row.
	const [terminalInstances, setTerminalInstances] = useState<
		TerminalInstance[]
	>([]);
	useEffect(() => {
		if (!workspaceId) {
			setTerminalInstances([]);
			return;
		}
		return subscribeToWorkspaceList(workspaceId, (list) => {
			setTerminalInstances(list);
		});
	}, [workspaceId]);

	const canSpawnTerminal =
		!!repoId &&
		!!workspaceId &&
		terminalInstances.length < TERMINAL_INSTANCE_LIMIT;

	const handleAddTerminal = useCallback(() => {
		if (!repoId || !workspaceId) return;
		const next = createTerminal(repoId, workspaceId);
		if (next) setActiveTab(next.id);
	}, [repoId, workspaceId, setActiveTab]);

	const handleToggleTerminalHoverZoom = useCallback(
		(instanceId: string, disabled: boolean) => {
			if (!workspaceId) return;
			setTerminalHoverZoomDisabled(workspaceId, instanceId, disabled);
		},
		[workspaceId],
	);

	const handleCloseTerminal = useCallback(
		(instanceId: string) => {
			if (!repoId || !workspaceId) return;
			// If the closing tab is active, fall back to the neighbour terminal
			// (right preferred, else left). Else fall back to "setup".
			if (activeTab === instanceId) {
				const idx = terminalInstances.findIndex((t) => t.id === instanceId);
				const fallback =
					terminalInstances[idx + 1] ?? terminalInstances[idx - 1];
				setActiveTab(fallback ? fallback.id : "setup");
			}
			closeTerminal(repoId, workspaceId, instanceId);
		},
		[repoId, workspaceId, activeTab, terminalInstances, setActiveTab],
	);

	const isTerminalTabActive = terminalInstances.some((t) => t.id === activeTab);

	// Terminal-scope shortcuts. Fire while focus is anywhere in the inspector
	// tabs section (Setup / Run / Terminal) — the `data-focus-scope="terminal"`
	// tag on the section root resolves to "terminal" via getActiveScopes — so
	// they don't compete with chat's Mod+T / Mod+W.
	const navigateTerminal = useCallback(
		(offset: -1 | 1) => {
			if (terminalInstances.length === 0) return;
			const idx = terminalInstances.findIndex((t) => t.id === activeTab);
			if (idx === -1) return;
			const nextIdx =
				(idx + offset + terminalInstances.length) % terminalInstances.length;
			const next = terminalInstances[nextIdx];
			if (next) setActiveTab(next.id);
		},
		[terminalInstances, activeTab, setActiveTab],
	);
	const { settings: appSettings } = useSettings();
	// App-scoped smart toggle for the terminal panel.
	//
	// Target selection: if the user is already on a terminal tab (either
	// just viewing it or actively typing in it), stay on that one — don't
	// hop to the rightmost. Only fall back to the rightmost terminal when
	// the panel is collapsed (so we don't know which terminal the user
	// "meant") or when the active tab is Setup/Run (the user wasn't on a
	// terminal at all). This preserves the current working terminal across
	// repeated presses.
	//
	// Behaviour ladder:
	//   1. No terminals yet → spawn one, expand the panel, focus it.
	//   2. Panel collapsed → expand + ensure target is active. Mount path
	//      will auto-focus the xterm.
	//   3. Panel open + Setup/Run active → switch to rightmost terminal +
	//      focus (mount path auto-focuses on isActive flip).
	//   4. Panel open + a terminal active but focus is elsewhere → pull
	//      focus into that already-mounted xterm.
	//   5. Panel open + a terminal active + focus already inside the
	//      xterm → collapse the panel (acts like the toggle-scripts
	//      shortcut). Second press of Mod+Shift+J hides the panel.
	const handleFocusTerminal = useCallback(() => {
		// 1. Empty state — bootstrap a new terminal.
		if (terminalInstances.length === 0) {
			if (!canSpawnTerminal) return;
			if (!tabsOpen) handleToggleTabs();
			handleAddTerminal();
			return;
		}

		const currentTerminal = terminalInstances.find((t) => t.id === activeTab);
		const target =
			currentTerminal ?? terminalInstances[terminalInstances.length - 1];

		// 2. Collapsed → expand. If activeTab already matches target (user
		//    was on this terminal before collapsing) setActiveTab is a
		//    no-op; either way the mount path auto-focuses.
		if (!tabsOpen) {
			handleToggleTabs();
			if (activeTab !== target.id) setActiveTab(target.id);
			return;
		}

		// 3. Open but Setup/Run active → switch to rightmost.
		if (activeTab !== target.id) {
			setActiveTab(target.id);
			return;
		}

		// 4 & 5. Open + a terminal already active. Distinguish by where
		// keyboard focus is right now.
		const targetPanel = document.getElementById(
			`inspector-panel-terminal-${target.id}`,
		);
		const focusInsideTarget =
			targetPanel?.contains(document.activeElement) ?? false;

		if (focusInsideTarget) {
			// 5. Already focused in this terminal — second press collapses.
			handleToggleTabs();
		} else {
			// 4. Pull focus into the existing, already-mounted xterm.
			window.dispatchEvent(new Event("helmor:focus-active-terminal"));
		}
	}, [
		terminalInstances,
		canSpawnTerminal,
		tabsOpen,
		handleToggleTabs,
		handleAddTerminal,
		activeTab,
		setActiveTab,
	]);

	const terminalShortcutHandlers = useMemo<ShortcutHandler[]>(
		() => [
			{
				id: "terminal.new",
				callback: handleAddTerminal,
				enabled: canSpawnTerminal,
			},
			{
				id: "terminal.close",
				callback: () => {
					if (!isTerminalTabActive) return;
					handleCloseTerminal(activeTab);
				},
				enabled: isTerminalTabActive,
			},
			{
				id: "terminal.previous",
				callback: () => navigateTerminal(-1),
				enabled: terminalInstances.length > 1,
			},
			{
				id: "terminal.next",
				callback: () => navigateTerminal(1),
				enabled: terminalInstances.length > 1,
			},
			{
				id: "inspector.toggleScripts",
				callback: handleToggleTabs,
			},
			{
				id: "inspector.focusTerminal",
				callback: handleFocusTerminal,
				// Always enabled — handler bootstraps a terminal if none
				// exist, expands when collapsed, focuses when not focused,
				// and collapses when focus is already in the active xterm.
				enabled: canSpawnTerminal || terminalInstances.length > 0,
			},
		],
		[
			activeTab,
			canSpawnTerminal,
			handleAddTerminal,
			handleCloseTerminal,
			handleFocusTerminal,
			handleToggleTabs,
			isTerminalTabActive,
			navigateTerminal,
			terminalInstances.length,
		],
	);
	useAppShortcuts({
		overrides: appSettings.shortcuts,
		handlers: terminalShortcutHandlers,
	});

	// Reset to "setup" when the active tab is a terminal id that no longer
	// matches any current instance — happens when switching workspaces while
	// a terminal tab was active in the previous one.
	useEffect(() => {
		if (activeTab === "setup" || activeTab === "run") return;
		if (terminalInstances.some((t) => t.id === activeTab)) return;
		setActiveTab("setup");
	}, [activeTab, terminalInstances, setActiveTab]);

	// Only allow hover-to-zoom when the active tab has real terminal output.
	// "idle" = script configured but never run; "no-script" = nothing to run.
	// In both cases the body is a placeholder (Run / Open-settings button)
	// that doesn't benefit from — and shouldn't trigger — the enlargement.
	const scriptTabState =
		activeTab === "setup" ? setupScriptState : runScriptState;
	const activeTerminalInstance = isTerminalTabActive
		? terminalInstances.find((t) => t.id === activeTab)
		: undefined;
	const canHoverExpand = isTerminalTabActive
		? !activeTerminalInstance?.hoverZoomDisabled
		: scriptTabState === "running" ||
			scriptTabState === "success" ||
			scriptTabState === "failure";

	const handleOpenSettings = onOpenSettings ?? (() => {});

	return (
		<VerticalSplitPanelGroup
			ref={containerRef}
			className={cn("bg-sidebar", isResizing && "select-none")}
			panels={[
				{
					id: "changes",
					open: true,
					node: (
						<ChangesSection
							workspaceId={workspaceId ?? null}
							workspaceRootPath={workspaceRootPath ?? null}
							workspaceTargetBranch={workspaceTargetBranch ?? null}
							changes={changes}
							editorMode={editorMode}
							activeEditorPath={activeEditorPath}
							onOpenEditorFile={onOpenEditorFile}
							flashingPaths={flashingPaths}
							onCommitAction={onCommitAction}
							commitButtonMode={commitButtonMode}
							commitButtonState={commitButtonState}
							changeRequest={changeRequest ?? null}
							forgeIsRefreshing={forgeIsRefreshing}
						/>
					),
				},
				{
					id: "actions",
					open: actionsOpen,
					resizable: true,
					node: (
						<ActionsSection
							workspaceId={workspaceId ?? null}
							workspaceState={workspaceState ?? null}
							repoId={repoId ?? null}
							workspaceRemote={workspaceRemote ?? null}
							sectionRef={actionsRef}
							open={actionsOpen}
							onToggle={handleToggleActions}
							bodyHeight={actionsHeight}
							isResizing={isResizing}
							onCommitAction={onCommitAction}
							onReviewAction={onReviewAction}
							currentSessionId={currentSessionId ?? null}
							onQueuePendingPromptForSession={onQueuePendingPromptForSession}
							commitButtonMode={commitButtonMode}
							commitButtonState={commitButtonState}
							changeRequest={changeRequest ?? null}
						/>
					),
				},
				{
					id: "terminal",
					open: tabsOpen,
					resizable: true,
					node: (
						<InspectorTabsSection
							wrapperRef={tabsWrapperRef}
							open={tabsOpen}
							onToggle={handleToggleTabs}
							activeTab={activeTab}
							onTabChange={setActiveTab}
							tabActions={runTabActions}
							setupScriptState={setupScriptState}
							runScriptState={runScriptState}
							terminalInstances={terminalInstances}
							onAddTerminal={handleAddTerminal}
							onCloseTerminal={handleCloseTerminal}
							onToggleTerminalHoverZoom={handleToggleTerminalHoverZoom}
							canSpawnTerminal={canSpawnTerminal}
							canHoverExpand={canHoverExpand}
							bodyHeight={tabsBodyHeight}
							isResizing={isResizing}
						>
							<SetupTab
								repoId={repoId ?? null}
								workspaceId={workspaceId ?? null}
								setupScript={repoScripts?.setupScript ?? null}
								isActive={activeTab === "setup"}
								onOpenSettings={handleOpenSettings}
							/>
							<RunTab
								repoId={repoId ?? null}
								workspaceId={workspaceId ?? null}
								runScript={repoScripts?.runScript ?? null}
								isActive={activeTab === "run"}
								onOpenSettings={handleOpenSettings}
								onStatusChange={setRunStatus}
								onUrlsChange={setRunUrls}
							/>
							{terminalInstances.map((instance) => (
								<TerminalInstancePanel
									key={instance.id}
									repoId={repoId ?? null}
									workspaceId={workspaceId ?? null}
									instance={instance}
									isActive={activeTab === instance.id}
								/>
							))}
						</InspectorTabsSection>
					),
				},
			]}
			renderResizeHandle={(panelId) => (
				<HorizontalResizeHandle
					onMouseDown={handleResizeStart(panelId)}
					isActive={panelId === "actions" ? isActionsResizing : isTabsResizing}
				/>
			)}
		/>
	);
}
