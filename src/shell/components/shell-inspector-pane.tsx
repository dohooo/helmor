// Right inspector pane — toggles between the workspace inspector tabs and
// the context-cards sidebar (which serves both the start and the workspace
// surface). Reads its selection fields straight off the selection store;
// everything else still arrives as props from AppShell.
import { useLayoutEffect, useRef } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type {
	CommitButtonState,
	WorkspaceCommitButtonMode,
} from "@/features/commit/button";
import type { PendingPromptForSession } from "@/features/commit/hooks/use-commit-lifecycle";
import { WorkspaceInspectorSidebar } from "@/features/inspector";
import type { SettingsSection } from "@/features/settings";
import { WorkspaceStartContextSidebar } from "@/features/workspace-start/context-sidebar";
import type {
	ChangeRequestInfo,
	DetectedEditor,
	RepositoryCreateOption,
	WorkspaceDetail,
} from "@/lib/api";
import type { ActiveEditorTarget, DiffOpenOptions } from "@/lib/editor-session";
import type { WorkspaceRightSidebarMode } from "@/lib/settings";
import type { ContextCard } from "@/lib/sources/types";
import { cn } from "@/lib/utils";
import { useSelectionStore } from "@/shell/controllers/selection-store-context";

type Props = {
	collapsed: boolean;
	resizing: boolean;
	width: number;
	rightSidebarMode: WorkspaceRightSidebarMode;

	// Context-sidebar props
	startRepository: RepositoryCreateOption | null;
	selectedWorkspaceRepository: RepositoryCreateOption | null;
	startInboxProviderTab: string;
	onStartInboxProviderTabChange: (tab: string) => void;
	startInboxProviderSourceTab: string;
	onStartInboxProviderSourceTabChange: (tab: string) => void;
	startInboxStateFilterBySource: Record<string, string>;
	onStartInboxStateFilterBySourceChange: (
		value: Record<string, string>,
	) => void;
	startComposerInsertTarget: { contextKey: string };
	startPreviewCardId: string | null;
	workspacePreviewCardId: string | null;
	onOpenStartContextCard: (card: ContextCard) => void;
	onOpenWorkspaceContextCard: (card: ContextCard) => void;

	// Inspector-sidebar props
	workspaceRootPath: string | null;
	selectedWorkspaceDetail: WorkspaceDetail | null;
	activeEditor: ActiveEditorTarget | null;
	preferredEditor: DetectedEditor | null;
	onOpenEditorFile: (path: string, options?: DiffOpenOptions) => void;
	onCommitAction: (mode: WorkspaceCommitButtonMode) => Promise<void>;
	onReviewAction: () => Promise<void>;
	onQueuePendingPromptForSession: (request: PendingPromptForSession) => void;
	commitButtonMode: WorkspaceCommitButtonMode | undefined;
	commitButtonState: CommitButtonState | undefined;
	workspaceChangeRequest: ChangeRequestInfo | null;
	workspaceForgeIsRefreshing: boolean;
	onOpenSettings: (initialSection?: SettingsSection) => void;
};

export function ShellInspectorPane({
	collapsed,
	resizing,
	width,
	rightSidebarMode,
	startRepository,
	selectedWorkspaceRepository,
	startInboxProviderTab,
	onStartInboxProviderTabChange,
	startInboxProviderSourceTab,
	onStartInboxProviderSourceTabChange,
	startInboxStateFilterBySource,
	onStartInboxStateFilterBySourceChange,
	startComposerInsertTarget,
	startPreviewCardId,
	workspacePreviewCardId,
	onOpenStartContextCard,
	onOpenWorkspaceContextCard,
	workspaceRootPath,
	selectedWorkspaceDetail,
	activeEditor,
	preferredEditor,
	onOpenEditorFile,
	onCommitAction,
	onReviewAction,
	onQueuePendingPromptForSession,
	commitButtonMode,
	commitButtonState,
	workspaceChangeRequest,
	workspaceForgeIsRefreshing,
	onOpenSettings,
}: Props) {
	// Subscribe to the selection store directly instead of receiving these
	// three as flattened props from AppShell. They're the same store fields
	// AppShell read; moving the delivery channel keeps an unrelated
	// selection-field change from re-rendering this pane via prop churn.
	// `useShallow` keeps the multi-field selector stable across renders.
	const { selectedWorkspaceId, displayedSessionId, viewMode } = useStore(
		useSelectionStore(),
		useShallow((s) => ({
			selectedWorkspaceId: s.selectedWorkspaceId,
			displayedSessionId: s.displayedSessionId,
			viewMode: s.viewMode,
		})),
	);
	const editorMode = viewMode === "editor";
	const targetBranch = (() => {
		const target =
			selectedWorkspaceDetail?.intendedTargetBranch ??
			selectedWorkspaceDetail?.defaultBranch;
		if (!target) return null;
		const remote = selectedWorkspaceDetail?.remote ?? "origin";
		return `${remote}/${target}`;
	})();

	// Inline width written via ref so each remount re-applies it.
	const asideRef = useRef<HTMLElement>(null);
	const innerRef = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		if (asideRef.current) {
			asideRef.current.style.width = collapsed ? "0px" : `${width}px`;
		}
		if (innerRef.current) {
			innerRef.current.style.width = `${width}px`;
		}
	}, [width, collapsed]);

	return (
		<aside
			ref={asideRef}
			aria-hidden={collapsed}
			aria-label="Inspector sidebar"
			data-shell-pane="inspector"
			className={cn(
				"relative h-full shrink-0 overflow-hidden bg-inspector has-[[data-tabs-zoomed=true]]:z-50 has-[[data-tabs-zoomed=true]]:overflow-visible",
				resizing
					? "transition-none"
					: "transition-[width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
				collapsed ? "pointer-events-none" : "",
			)}
			// `paint` omitted so the tabs hover-zoom can overflow.
			style={{ contain: "layout style" }}
		>
			<div
				ref={innerRef}
				data-shell-pane-inner="inspector"
				className={cn(
					"h-full shrink-0 transition-[opacity,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
					collapsed
						? "translate-x-full opacity-0"
						: "translate-x-0 opacity-100",
				)}
			>
				{rightSidebarMode === "context" ? (
					<WorkspaceStartContextSidebar
						repository={
							viewMode === "start"
								? startRepository
								: selectedWorkspaceRepository
						}
						inboxProviderTab={startInboxProviderTab}
						onInboxProviderTabChange={onStartInboxProviderTabChange}
						inboxProviderSourceTab={startInboxProviderSourceTab}
						onInboxProviderSourceTabChange={onStartInboxProviderSourceTabChange}
						inboxStateFilterBySource={startInboxStateFilterBySource}
						onInboxStateFilterBySourceChange={
							onStartInboxStateFilterBySourceChange
						}
						composerInsertTarget={
							viewMode === "start" ? startComposerInsertTarget : undefined
						}
						selectedCardId={
							viewMode === "start" ? startPreviewCardId : workspacePreviewCardId
						}
						onOpenCard={
							viewMode === "start"
								? onOpenStartContextCard
								: onOpenWorkspaceContextCard
						}
					/>
				) : (
					<WorkspaceInspectorSidebar
						workspaceId={selectedWorkspaceId}
						workspaceRootPath={workspaceRootPath}
						workspaceState={selectedWorkspaceDetail?.state ?? null}
						workspaceSetupCompletedAt={
							selectedWorkspaceDetail?.setupCompletedAt ?? null
						}
						workspaceActiveRunActionId={
							selectedWorkspaceDetail?.activeRunActionId ?? null
						}
						repoId={selectedWorkspaceDetail?.repoId ?? null}
						workspaceBranch={selectedWorkspaceDetail?.branch ?? null}
						workspaceRemote={selectedWorkspaceDetail?.remote ?? null}
						workspaceRemoteUrl={selectedWorkspaceDetail?.remoteUrl ?? null}
						workspaceTargetBranch={targetBranch}
						editorMode={editorMode}
						activeEditor={activeEditor}
						preferredEditor={preferredEditor}
						onOpenEditorFile={onOpenEditorFile}
						onCommitAction={onCommitAction}
						onReviewAction={onReviewAction}
						currentSessionId={displayedSessionId}
						onQueuePendingPromptForSession={onQueuePendingPromptForSession}
						commitButtonMode={commitButtonMode}
						commitButtonState={commitButtonState}
						changeRequest={workspaceChangeRequest}
						forgeIsRefreshing={workspaceForgeIsRefreshing}
						onOpenSettings={onOpenSettings}
					/>
				)}
			</div>
		</aside>
	);
}
