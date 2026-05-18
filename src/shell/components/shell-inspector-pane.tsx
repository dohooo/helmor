// Right inspector pane — toggles between the workspace inspector tabs and
// the context-cards sidebar (which serves both the start and the workspace
// surface). Receives every piece of state it needs as props from AppShell.
import type {
	CommitButtonState,
	WorkspaceCommitButtonMode,
} from "@/features/commit/button";
import type { PendingPromptForSession } from "@/features/commit/hooks/use-commit-lifecycle";
import { WorkspaceInspectorSidebar } from "@/features/inspector";
import { WorkspaceStartContextSidebar } from "@/features/workspace-start/context-sidebar";
import type {
	ChangeRequestInfo,
	RepositoryCreateOption,
	WorkspaceDetail,
} from "@/lib/api";
import type { ActiveEditorTarget, DiffOpenOptions } from "@/lib/editor-session";
import type { WorkspaceRightSidebarMode } from "@/lib/settings";
import type { ContextCard } from "@/lib/sources/types";
import { cn } from "@/lib/utils";
import type { ShellViewMode } from "@/shell/controllers/use-selection-controller";

type Props = {
	collapsed: boolean;
	resizing: boolean;
	width: number;
	rightSidebarMode: WorkspaceRightSidebarMode;
	viewMode: ShellViewMode;

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
	selectedWorkspaceId: string | null;
	workspaceRootPath: string | null;
	selectedWorkspaceDetail: WorkspaceDetail | null;
	displayedSessionId: string | null;
	activeEditor: ActiveEditorTarget | null;
	onOpenEditorFile: (path: string, options?: DiffOpenOptions) => void;
	onCommitAction: (mode: WorkspaceCommitButtonMode) => Promise<void>;
	onReviewAction: () => Promise<void>;
	onQueuePendingPromptForSession: (request: PendingPromptForSession) => void;
	commitButtonMode: WorkspaceCommitButtonMode | undefined;
	commitButtonState: CommitButtonState | undefined;
	workspaceChangeRequest: ChangeRequestInfo | null;
	workspaceForgeIsRefreshing: boolean;
	onOpenSettings: () => void;
};

export function ShellInspectorPane({
	collapsed,
	resizing,
	width,
	rightSidebarMode,
	viewMode,
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
	selectedWorkspaceId,
	workspaceRootPath,
	selectedWorkspaceDetail,
	displayedSessionId,
	activeEditor,
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
	const editorMode = viewMode === "editor";
	const targetBranch = (() => {
		const target =
			selectedWorkspaceDetail?.intendedTargetBranch ??
			selectedWorkspaceDetail?.defaultBranch;
		if (!target) return null;
		const remote = selectedWorkspaceDetail?.remote ?? "origin";
		return `${remote}/${target}`;
	})();

	return (
		<aside
			aria-hidden={collapsed}
			aria-label="Inspector sidebar"
			className={cn(
				"relative h-full shrink-0 overflow-hidden bg-sidebar has-[[data-tabs-zoomed=true]]:z-50 has-[[data-tabs-zoomed=true]]:overflow-visible",
				resizing
					? "transition-none"
					: "transition-[width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
				collapsed ? "pointer-events-none" : "",
			)}
			style={{ width: collapsed ? 0 : `${width}px` }}
		>
			<div
				className={cn(
					"h-full shrink-0 transition-[opacity,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
					collapsed
						? "translate-x-full opacity-0"
						: "translate-x-0 opacity-100",
				)}
				style={{ width: `${width}px` }}
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
						repoId={selectedWorkspaceDetail?.repoId ?? null}
						workspaceBranch={selectedWorkspaceDetail?.branch ?? null}
						workspaceRemote={selectedWorkspaceDetail?.remote ?? null}
						workspaceRemoteUrl={selectedWorkspaceDetail?.remoteUrl ?? null}
						workspaceTargetBranch={targetBranch}
						editorMode={editorMode}
						activeEditor={activeEditor}
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
