import { useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Maximize2, PanelRightClose } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import type {
	CommitButtonState,
	WorkspaceCommitButtonMode,
} from "@/features/commit/button";
import { InlineShortcutDisplay } from "@/features/shortcuts/shortcut-display";
import {
	type ShortcutHandler,
	useAppShortcuts,
} from "@/features/shortcuts/use-app-shortcuts";
import type { FileTabOpener } from "@/features/tabs/types";
import type { ChangeRequestInfo } from "@/lib/api";
import type { DiffOpenOptions } from "@/lib/editor-session";
import { helmorQueryKeys } from "@/lib/query-client";
import { useSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import {
	type ChangesSubView,
	type ReviewIndicator,
	SubSectionTabs,
} from "./components/sub-section-tabs";
import {
	TopSectionTabs,
	type TopSectionView,
} from "./components/top-section-tabs";
import { useWorkspaceInspectorSidebar } from "./hooks/use-inspector";
import { useScriptStatus } from "./hooks/use-script-status";
import { useSetupAutoRun } from "./hooks/use-setup-auto-run";
import {
	getInitialTopView,
	HorizontalResizeHandle,
	INSPECTOR_CHANGES_SUBVIEW_STORAGE_KEY,
	INSPECTOR_TOP_VIEW_STORAGE_KEY,
	InspectorTabsSection,
} from "./layout";
import type { ScriptStatus } from "./script-store";
import { AllFilesSection } from "./sections/all-files";
import { ChangesSection } from "./sections/changes";
import { ChecksSection, useChecksIndicator } from "./sections/checks";
import { DiffActionToolbar } from "./sections/diff/action-toolbar";
import { DiffCommitFooter } from "./sections/diff/commit-footer";
import { PrCommentsSection } from "./sections/review/pr-comments";
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

interface OpenFileInput {
	absolutePath: string;
	relativePath: string;
	fileName: string;
	diffOptions?: DiffOpenOptions;
}

type WorkspaceInspectorSidebarProps = {
	workspaceId?: string | null;
	repoId?: string | null;
	workspaceRootPath?: string | null;
	workspaceBranch?: string | null;
	workspaceTargetBranch?: string | null;
	workspaceRemote?: string | null;
	workspaceRemoteUrl?: string | null;
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
	/**
	 * Absolute path of the file currently focused in the editor (if any).
	 * Used by the All-files browser to highlight the active file. Defaults to
	 * `null` — Task 13 wires this to the file-tab store.
	 */
	activeFileAbsolutePath?: string | null;
	/**
	 * Sibling-style callback invoked when the user wants to open a file in
	 * the new tab system — either by clicking a file in the All-files panel
	 * (`opener.kind === "browser"`) or a row in the Changes panel
	 * (`opener.kind === "changes"`). Defaults to a no-op until Task 13 wires
	 * the file-tab store.
	 */
	onOpenFileTab?: (input: OpenFileInput, opener: FileTabOpener) => void;
	/** Collapse the right (inspector) sidebar. The inspector is by
	 *  definition visible while this component is mounted, so the button
	 *  always closes — there's no in-inspector "expand right" affordance. */
	onCollapseRightSidebar?: () => void;
	/** Resolved hotkey string for `sidebar.right.toggle`. */
	rightSidebarToggleShortcut?: string | null;
	/** Open the Diff view as a full surface on the main canvas. Stub for
	 *  now — the button renders disabled until this is wired. */
	onExpandDiffsOnCanvas?: () => void;
};

export function WorkspaceInspectorSidebar({
	workspaceId,
	workspaceRootPath,
	workspaceBranch,
	workspaceTargetBranch,
	workspaceRemote,
	workspaceRemoteUrl,
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
	activeFileAbsolutePath = null,
	onOpenFileTab,
	onCollapseRightSidebar,
	rightSidebarToggleShortcut = null,
	onExpandDiffsOnCanvas,
}: WorkspaceInspectorSidebarProps) {
	const [topSectionView, setTopSectionView] = useState<TopSectionView>(() =>
		getInitialTopView<TopSectionView>(["files", "changes"] as const, "changes"),
	);
	useEffect(() => {
		try {
			window.localStorage.setItem(
				INSPECTOR_TOP_VIEW_STORAGE_KEY,
				topSectionView,
			);
		} catch {
			// non-fatal
		}
	}, [topSectionView]);
	const queryClient = useQueryClient();
	const [diffTreeView, setDiffTreeView] = useState(false);
	const [changesSubView, setChangesSubView] = useState<ChangesSubView>(() => {
		if (typeof window === "undefined") return "diff";
		try {
			const stored = window.localStorage.getItem(
				INSPECTOR_CHANGES_SUBVIEW_STORAGE_KEY,
			);
			if (stored === "diff" || stored === "review") return stored;
		} catch {
			// fall through
		}
		return "diff";
	});
	useEffect(() => {
		try {
			window.localStorage.setItem(
				INSPECTOR_CHANGES_SUBVIEW_STORAGE_KEY,
				changesSubView,
			);
		} catch {
			// non-fatal
		}
	}, [changesSubView]);
	const handleOpenFileTab = useMemo<
		(input: OpenFileInput, opener: FileTabOpener) => void
	>(() => onOpenFileTab ?? (() => {}), [onOpenFileTab]);
	const {
		activeTab,
		changes,
		topBodyHeight,
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
		tabsBodyHeight,
		tabsOpen,
		tabsWrapperRef,
	} = useWorkspaceInspectorSidebar({
		workspaceRootPath,
		workspaceId: workspaceId ?? null,
		repoId: repoId ?? null,
	});
	const checksIndicator = useChecksIndicator(
		workspaceId ?? null,
		workspaceState ?? null,
		changeRequest ?? null,
	);
	// Translate the existing tri-state checks indicator into the sub-tab's
	// four-state pip. `none` upgrades to `success` once we have any change
	// request to look at — the green tick communicates "review surface is
	// clean / nothing demanding attention." Pre-PR (no change request) we
	// stay at `none` to avoid false positives.
	const reviewIndicator: ReviewIndicator =
		checksIndicator === "failure"
			? "failure"
			: checksIndicator === "pending"
				? "pending"
				: changeRequest
					? "success"
					: "none";

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
		<div
			ref={containerRef}
			className={cn(
				"flex h-full min-h-0 flex-col bg-sidebar",
				isResizing && "select-none",
			)}
		>
			<section className="flex min-h-0 shrink-0 flex-col overflow-hidden bg-sidebar">
				<div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border/60 bg-muted/25 px-2">
					<div className="flex min-w-0 flex-1 items-center">
						<TopSectionTabs
							value={topSectionView}
							onChange={setTopSectionView}
						/>
					</div>
					<div className="flex shrink-0 items-center gap-0.5">
						<SidebarHeaderButton
							label="Expand diffs on main canvas"
							shortcut={null}
							onClick={onExpandDiffsOnCanvas}
							disabled={!onExpandDiffsOnCanvas}
							icon={<Maximize2 className="size-4" strokeWidth={1.8} />}
						/>
						{onCollapseRightSidebar ? (
							<SidebarHeaderButton
								label="Close right sidebar"
								shortcut={rightSidebarToggleShortcut}
								onClick={onCollapseRightSidebar}
								icon={<PanelRightClose className="size-4" strokeWidth={1.8} />}
							/>
						) : null}
					</div>
				</div>
				{topSectionView === "files" ? (
					<div
						className="flex min-h-0 shrink-0 flex-col border-b border-border/60"
						style={{ height: topBodyHeight }}
					>
						<AllFilesSection
							workspaceRootPath={workspaceRootPath ?? null}
							workspaceId={workspaceId ?? null}
							activeAbsolutePath={activeFileAbsolutePath}
							onOpenFile={(input) =>
								handleOpenFileTab(input, { kind: "browser" })
							}
						/>
					</div>
				) : (
					<div
						className="flex min-h-0 shrink-0 flex-col border-b border-border/60"
						style={{ height: topBodyHeight }}
					>
						<SubSectionTabs
							value={changesSubView}
							onChange={setChangesSubView}
							diffCount={changes.length}
							reviewIndicator={reviewIndicator}
						/>
						{changesSubView === "review" ? (
							<div className="flex min-h-0 flex-1 flex-col">
								<ChecksSection
									workspaceId={workspaceId ?? null}
									workspaceState={workspaceState ?? null}
									repoId={repoId ?? null}
									workspaceRemote={workspaceRemote ?? null}
									// Cap the checks rail at ~65% of the sub-tab body
									// (min 160) so a long check list keeps scrolling
									// without crowding the comments rail out below.
									bodyHeight={Math.max(
										Math.round((topBodyHeight - 28) * 0.65),
										160,
									)}
									onCommitAction={onCommitAction}
									onReviewAction={onReviewAction}
									currentSessionId={currentSessionId ?? null}
									onQueuePendingPromptForSession={
										onQueuePendingPromptForSession
									}
									commitButtonMode={commitButtonMode}
									commitButtonState={commitButtonState}
									changeRequest={changeRequest ?? null}
								/>
								<PrCommentsSection
									workspaceId={workspaceId ?? null}
									hasChangeRequest={!!changeRequest}
								/>
							</div>
						) : (
							<>
								<DiffActionToolbar
									changeRequest={changeRequest ?? null}
									workspaceBranch={workspaceBranch ?? null}
									treeView={diffTreeView}
									onToggleTreeView={() => setDiffTreeView((value) => !value)}
									onRefreshChanges={() => {
										if (workspaceRootPath) {
											void queryClient.invalidateQueries({
												queryKey:
													helmorQueryKeys.workspaceChanges(workspaceRootPath),
											});
										}
									}}
									onOpenChangeRequest={
										changeRequest
											? () => void openUrl(changeRequest.url)
											: undefined
									}
								/>
								<DiffCommitFooter
									workspaceId={workspaceId ?? null}
									commitButtonMode={commitButtonMode ?? "create-pr"}
									commitButtonState={commitButtonState ?? "idle"}
									changeRequest={changeRequest ?? null}
									hasUncommittedChanges={changes.length > 0}
									changeRequestName="PR"
									onCommitAction={onCommitAction}
								/>
								<ChangesSection
									workspaceId={workspaceId ?? null}
									workspaceRootPath={workspaceRootPath ?? null}
									workspaceBranch={workspaceBranch ?? null}
									workspaceRemoteUrl={workspaceRemoteUrl ?? null}
									workspaceTargetBranch={workspaceTargetBranch ?? null}
									changes={changes}
									editorMode={editorMode}
									activeEditorPath={activeEditorPath}
									onOpenEditorFile={onOpenEditorFile}
									onOpenChangedFile={(file, side, options) =>
										handleOpenFileTab(
											{
												absolutePath: file.absolutePath,
												relativePath: file.path,
												fileName: file.name,
												diffOptions: options,
											},
											{ kind: "changes", side },
										)
									}
									flashingPaths={flashingPaths}
									onCommitAction={onCommitAction}
									commitButtonMode={commitButtonMode}
									commitButtonState={commitButtonState}
									changeRequest={changeRequest ?? null}
									forgeIsRefreshing={forgeIsRefreshing}
									// Sub-tab strip (28) + toolbar (36) + commit area
									// (~150) trimmed off the sub-section's body budget;
									// the file list now sits BELOW the commit area and
									// scrolls in the remaining space.
									bodyHeight={Math.max(topBodyHeight - 28 - 36 - 150, 0)}
									animatePanelToggle={isPanelToggleAnimating}
									isResizing={isResizing}
									hideGitSectionHeader
								/>
							</>
						)}
					</div>
				)}
			</section>
			{tabsOpen ? (
				<HorizontalResizeHandle
					onMouseDown={handleResizeStart}
					isActive={isTabsResizing}
				/>
			) : null}
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
				animatePanelToggle={isPanelToggleAnimating}
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
		</div>
	);
}

function SidebarHeaderButton({
	label,
	shortcut,
	onClick,
	icon,
	disabled = false,
}: {
	label: string;
	shortcut: string | null;
	onClick?: () => void;
	icon: React.ReactNode;
	disabled?: boolean;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					aria-label={label}
					onClick={onClick}
					disabled={disabled}
					variant="ghost"
					size="icon-xs"
					className="text-muted-foreground hover:text-foreground disabled:opacity-50"
				>
					{icon}
				</Button>
			</TooltipTrigger>
			<TooltipContent
				side="bottom"
				className="flex h-[24px] items-center gap-2 rounded-md px-2 text-[12px] leading-none"
			>
				<span>{label}</span>
				{shortcut ? (
					<InlineShortcutDisplay
						hotkey={shortcut}
						className="text-background/60"
					/>
				) : null}
			</TooltipContent>
		</Tooltip>
	);
}
