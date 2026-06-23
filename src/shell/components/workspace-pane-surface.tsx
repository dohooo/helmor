// Center workspace panel: the editor surface (when in editor view-mode) plus
// the start ⇄ conversation switch underneath. Lifted verbatim out of AppShell's
// `<section aria-label="Workspace panel">`; it owns the `workspaceViewMode`
// branch and renders either <StartSurfacePane> (start) or
// <ShellWorkspaceConversation> (chat) below the editor. Selection-track reads
// stay inside ShellWorkspaceConversation; only the delivery channel moved.
import type {
	ComposerCreateContext,
	WorkspaceConversationContainerProps,
} from "@/features/conversation";
import { WorkspaceEditorSurface } from "@/features/editor";
import { getShortcut } from "@/features/shortcuts/registry";
import type { WorkspaceStartPage } from "@/features/workspace-start";
import type { ChangeRequestInfo, RepositoryCreateOption } from "@/lib/api";
import type { EditorSessionState } from "@/lib/editor-session";
import { useI18n } from "@/lib/i18n";
import type { AppSettings } from "@/lib/settings";
import type { ContextCard } from "@/lib/sources/types";
import type { ContextPanelActions } from "@/shell/controllers/use-context-panel-controller";
import type { EditorSessionActions } from "@/shell/controllers/use-editor-session-controller";
import type { PendingQueueActions } from "@/shell/controllers/use-pending-queue-controller";
import type { ReadStateActions } from "@/shell/controllers/use-read-state-controller";
import type {
	SelectionActions,
	ShellViewMode,
} from "@/shell/controllers/use-selection-controller";
import type { StartSurfaceActions } from "@/shell/controllers/use-start-surface-controller";
import { ShellWorkspaceConversation } from "./shell-workspace-conversation";
import { StartSurfacePane } from "./start-surface-pane";

type ConversationProps = WorkspaceConversationContainerProps;
type StartPageProps = Parameters<typeof WorkspaceStartPage>[0];

type Props = {
	workspaceViewMode: ShellViewMode;
	editorSession: EditorSessionState | null;
	workspaceRootPath: string | null;
	appShortcuts: AppSettings["shortcuts"];
	sidebarCollapsed: boolean;
	contextPanelOpen: boolean;
	// Editor surface
	handleEditorSessionChange: (session: EditorSessionState) => void;
	editorSessionActions: EditorSessionActions;
	// Shared between both surfaces
	repositories: RepositoryCreateOption[];
	selectionActions: SelectionActions;
	readStateActions: ReadStateActions;
	pendingQueueActions: PendingQueueActions;
	contextPanelActions: ContextPanelActions;
	startSurfaceActions: StartSurfaceActions;
	activeStreams: ConversationProps["activeStreams"];
	effectiveBusySessionIds: Set<string>;
	effectiveStoppableSessionIds: Set<string>;
	interactionRequiredSessionIds: Set<string>;
	pendingComposerInserts: ConversationProps["pendingInsertRequests"];
	onSelectSession: (sessionId: string | null) => void;
	onRequestCloseSession: ConversationProps["onRequestCloseSession"];
	handlePendingPromptConsumed: () => void;
	queuePendingPromptForSession: ConversationProps["onQueuePendingPromptForSession"];
	// Start-surface only
	startRepository: RepositoryCreateOption | null;
	startSourceBranch: string;
	startBranches: StartPageProps["branches"];
	startBranchesLoading: boolean;
	startMode: StartPageProps["mode"];
	startBranchIntent: StartPageProps["branchIntent"];
	startPreviewCard: ContextCard | null;
	startComposerInsertTarget: { contextKey: string };
	startComposerContextKey: string;
	startCreateContext: ComposerCreateContext | null;
	startLinkedDirectoriesController: ConversationProps["composerLinkedDirectoriesController"];
	/** Quick panel: composer pinned to the bottom of the start surface. */
	startComposerAtBottom?: boolean;
	// Conversation (chat) only
	repoId: string | null;
	sessionSelectionHistory: string[];
	workspaceChangeRequest: ChangeRequestInfo | null;
	pendingPromptForSession: ConversationProps["pendingPromptForSession"];
	pendingCreatedWorkspaceSubmit: ConversationProps["pendingCreatedWorkspaceSubmit"];
	handlePendingCreatedWorkspaceSubmitConsumed: (id: string) => void;
	contextPreviewCard: ConversationProps["contextPreviewCard"];
	contextPreviewActive: boolean;
	headerLeadingNode: React.ReactNode;
	headerActionsNode: React.ReactNode;
};

export function WorkspacePaneSurface({
	workspaceViewMode,
	editorSession,
	workspaceRootPath,
	appShortcuts,
	sidebarCollapsed,
	contextPanelOpen,
	handleEditorSessionChange,
	editorSessionActions,
	repositories,
	selectionActions,
	readStateActions,
	pendingQueueActions,
	contextPanelActions,
	startSurfaceActions,
	activeStreams,
	effectiveBusySessionIds,
	effectiveStoppableSessionIds,
	interactionRequiredSessionIds,
	pendingComposerInserts,
	onSelectSession,
	onRequestCloseSession,
	handlePendingPromptConsumed,
	queuePendingPromptForSession,
	startRepository,
	startSourceBranch,
	startBranches,
	startBranchesLoading,
	startMode,
	startBranchIntent,
	startPreviewCard,
	startComposerInsertTarget,
	startComposerContextKey,
	startCreateContext,
	startLinkedDirectoriesController,
	startComposerAtBottom,
	repoId,
	sessionSelectionHistory,
	workspaceChangeRequest,
	pendingPromptForSession,
	pendingCreatedWorkspaceSubmit,
	handlePendingCreatedWorkspaceSubmitConsumed,
	contextPreviewCard,
	contextPreviewActive,
	headerLeadingNode,
	headerActionsNode,
}: Props) {
	const { t } = useI18n();
	return (
		<section
			aria-label={t("workspacePanel")}
			className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background"
			// Mirror the inspector's containment: keep style/layout invalidation
			// from sidebar/inspector resize out of the workspace subtree (which
			// owns Monaco's ~2900 cached CSS rules after the editor opens once).
			style={{ contain: "layout style" }}
		>
			{workspaceViewMode !== "editor" && (
				<div
					aria-label={t("workspacePanelDragRegion")}
					className="absolute inset-x-0 top-0 z-10 h-9 bg-transparent"
					data-tauri-drag-region
				/>
			)}

			<div
				aria-label={t("workspaceViewport")}
				className="flex min-h-0 flex-1 flex-col bg-background"
			>
				{workspaceViewMode === "editor" && editorSession && (
					<WorkspaceEditorSurface
						editorSession={editorSession}
						editShortcut={getShortcut(appShortcuts, "editor.edit")}
						shortcutOverrides={appShortcuts}
						workspaceRootPath={workspaceRootPath}
						onChangeSession={handleEditorSessionChange}
						onExit={editorSessionActions.exit}
						onError={editorSessionActions.reportError}
					/>
				)}
				<div
					data-focus-scope="chat"
					className={
						workspaceViewMode === "editor"
							? "hidden"
							: "flex min-h-0 flex-1 flex-col"
					}
				>
					{workspaceViewMode === "start" ? (
						<StartSurfacePane
							repositories={repositories}
							startRepository={startRepository}
							startSourceBranch={startSourceBranch}
							startBranches={startBranches}
							startBranchesLoading={startBranchesLoading}
							startMode={startMode}
							startBranchIntent={startBranchIntent}
							startPreviewCard={startPreviewCard}
							startComposerInsertTarget={startComposerInsertTarget}
							startComposerContextKey={startComposerContextKey}
							startCreateContext={startCreateContext}
							startLinkedDirectoriesController={
								startLinkedDirectoriesController
							}
							sidebarCollapsed={sidebarCollapsed}
							contextPanelOpen={contextPanelOpen}
							startSurfaceActions={startSurfaceActions}
							selectionActions={selectionActions}
							readStateActions={readStateActions}
							editorSessionActions={editorSessionActions}
							pendingQueueActions={pendingQueueActions}
							contextPanelActions={contextPanelActions}
							activeStreams={activeStreams}
							effectiveBusySessionIds={effectiveBusySessionIds}
							effectiveStoppableSessionIds={effectiveStoppableSessionIds}
							interactionRequiredSessionIds={interactionRequiredSessionIds}
							pendingComposerInserts={pendingComposerInserts}
							onSelectSession={onSelectSession}
							onRequestCloseSession={onRequestCloseSession}
							onPendingPromptConsumed={handlePendingPromptConsumed}
							queuePendingPromptForSession={queuePendingPromptForSession}
							headerLeading={headerLeadingNode}
							composerAtBottom={startComposerAtBottom}
						/>
					) : (
						<ShellWorkspaceConversation
							repoId={repoId}
							sessionSelectionHistory={sessionSelectionHistory}
							onSelectSession={onSelectSession}
							onSelectWorkspace={selectionActions.selectWorkspace}
							onResolveDisplayedSession={
								selectionActions.resolveDisplayedSession
							}
							onInteractionSessionsChange={
								readStateActions.onInteractionSessionsChange
							}
							activeStreams={activeStreams}
							busySessionIds={effectiveBusySessionIds}
							stoppableSessionIds={effectiveStoppableSessionIds}
							interactionRequiredSessionIds={interactionRequiredSessionIds}
							onSessionCompleted={readStateActions.onSessionCompleted}
							workspaceChangeRequest={workspaceChangeRequest}
							onSessionAborted={readStateActions.onSessionAborted}
							pendingPromptForSession={pendingPromptForSession}
							pendingCreatedWorkspaceSubmit={pendingCreatedWorkspaceSubmit}
							onPendingCreatedWorkspaceSubmitConsumed={
								handlePendingCreatedWorkspaceSubmitConsumed
							}
							onPendingPromptConsumed={handlePendingPromptConsumed}
							pendingInsertRequests={pendingComposerInserts}
							onPendingInsertRequestsConsumed={
								pendingQueueActions.consumeComposerInserts
							}
							onQueuePendingPromptForSession={queuePendingPromptForSession}
							onRequestCloseSession={onRequestCloseSession}
							workspaceRootPath={workspaceRootPath}
							onOpenFileReference={editorSessionActions.openFileReference}
							contextPanelOpen={contextPanelOpen}
							onToggleContextPanel={contextPanelActions.toggleContextPanel}
							contextPreviewCard={contextPreviewCard}
							contextPreviewActive={contextPreviewActive}
							onSelectContextPreview={
								contextPanelActions.selectWorkspaceContextPreview
							}
							onCloseContextPreview={
								contextPanelActions.closeWorkspaceContextPreview
							}
							headerLeading={headerLeadingNode}
							headerActions={headerActionsNode}
						/>
					)}
				</div>
			</div>
		</section>
	);
}
