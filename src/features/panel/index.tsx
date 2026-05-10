import { memo, type ReactNode, useEffect } from "react";
import { WorkspaceEditorSurface } from "@/features/editor";
import { SourceDetailView } from "@/features/source-detail";
import type { FileTab, TabId } from "@/features/tabs/types";
import type {
	AgentProvider,
	ChangeRequestInfo,
	WorkspaceDetail,
	WorkspaceSessionSummary,
} from "@/lib/api";
import { HelmorProfiler } from "@/lib/dev-react-profiler";
import type { EditorSessionState } from "@/lib/editor-session";
import type { ContextCard } from "@/lib/sources/types";
import type { WorkspaceScriptType } from "@/lib/workspace-script-actions";
import { WorkspacePanelHeader } from "./header";
import { EmptyState, preloadStreamdown } from "./message-components";
import { WorkspaceSessionSurfaceHeader } from "./session-header";
import {
	ActiveThreadViewport,
	ConversationColdPlaceholder,
	type PresentedSessionPane,
} from "./thread-viewport";
import type { SessionCloseRequest } from "./use-confirm-session-close";

export {
	AssistantToolCall,
	agentChildrenBlockPropsEqual,
	assistantToolCallPropsEqual,
} from "./message-components";

type WorkspacePanelProps = {
	workspace: WorkspaceDetail | null;
	changeRequest?: ChangeRequestInfo | null;
	sessions: WorkspaceSessionSummary[];
	selectedSessionId: string | null;
	sessionDisplayProviders?: Record<string, AgentProvider>;
	sessionPanes: PresentedSessionPane[];
	loadingWorkspace?: boolean;
	loadingSession?: boolean;
	refreshingWorkspace?: boolean;
	refreshingSession?: boolean;
	sending?: boolean;
	busySessionIds?: Set<string>;
	interactionRequiredSessionIds?: Set<string>;
	contextPreviewCard?: ContextCard | null;
	contextPreviewActive?: boolean;
	fileTabs?: FileTab[];
	activeTabId?: TabId | null;
	/**
	 * Sticky file editor session — equals the active file's session when a
	 * file tab is active, otherwise the most recent file tab's session. Used
	 * to keep `WorkspaceEditorSurface` mounted across non-file tab switches
	 * so Monaco models survive instead of being disposed and recreated.
	 */
	displayedFileEditorSession?: EditorSessionState | null;
	fileEditorVisible?: boolean;
	activeFileHasChanges?: boolean;
	workspaceRootPath?: string | null;
	onSelectSession?: (sessionId: string) => void;
	onSelectContextPreview?: () => void;
	onCloseContextPreview?: () => void;
	onSelectFileTab?: (id: TabId) => void;
	onCloseFileTab?: (id: TabId) => void;
	onChangeFileEditorSession?: (session: EditorSessionState) => void;
	onExitFileEditor?: () => void;
	onFileEditorError?: (description: string, title?: string) => void;
	onPrefetchSession?: (sessionId: string) => void;
	onSessionsChanged?: () => void;
	onSessionRenamed?: (sessionId: string, title: string) => void;
	onWorkspaceChanged?: () => void;
	onRequestCloseSession?: (request: SessionCloseRequest) => void;
	headerActions?: ReactNode;
	headerLeading?: ReactNode;
	newSessionShortcut?: string | null;
	missingScriptTypes?: WorkspaceScriptType[];
	onInitializeScript?: (scriptType: WorkspaceScriptType) => void;
};

export const WorkspacePanel = memo(function WorkspacePanel({
	workspace,
	changeRequest = null,
	sessions,
	selectedSessionId,
	sessionDisplayProviders,
	sessionPanes,
	loadingWorkspace = false,
	loadingSession = false,
	refreshingWorkspace: _refreshingWorkspace = false,
	refreshingSession: _refreshingSession = false,
	sending = false,
	busySessionIds,
	interactionRequiredSessionIds,
	contextPreviewCard = null,
	contextPreviewActive = false,
	fileTabs,
	activeTabId = null,
	displayedFileEditorSession = null,
	fileEditorVisible = false,
	activeFileHasChanges = false,
	workspaceRootPath = null,
	onSelectSession,
	onSelectContextPreview,
	onCloseContextPreview,
	onSelectFileTab,
	onCloseFileTab,
	onChangeFileEditorSession,
	onExitFileEditor,
	onFileEditorError,
	onPrefetchSession,
	onSessionsChanged,
	onSessionRenamed,
	onWorkspaceChanged,
	onRequestCloseSession,
	headerActions,
	headerLeading,
	newSessionShortcut,
	missingScriptTypes = [],
	onInitializeScript,
}: WorkspacePanelProps) {
	const selectedSession =
		sessions.find((session) => session.id === selectedSessionId) ?? null;
	const activePane =
		sessionPanes.find((pane) => pane.presentationState === "presented") ??
		sessionPanes[0] ??
		null;

	useEffect(() => {
		if (typeof window === "undefined") {
			return;
		}

		const idleCallbackId =
			"requestIdleCallback" in window
				? window.requestIdleCallback(() => preloadStreamdown(), {
						timeout: 1200,
					})
				: null;
		const timeoutId =
			idleCallbackId === null
				? window.setTimeout(() => preloadStreamdown(), 180)
				: null;

		return () => {
			if (idleCallbackId !== null && "cancelIdleCallback" in window) {
				window.cancelIdleCallback(idleCallbackId);
			}
			if (timeoutId !== null) {
				window.clearTimeout(timeoutId);
			}
		};
	}, []);

	return (
		<HelmorProfiler id="WorkspacePanel">
			<div className="flex min-h-0 flex-1 flex-col bg-transparent">
				<WorkspacePanelHeader
					workspace={workspace}
					changeRequest={changeRequest}
					sessions={sessions}
					selectedSessionId={selectedSessionId}
					sessionDisplayProviders={sessionDisplayProviders}
					sending={sending}
					busySessionIds={busySessionIds}
					interactionRequiredSessionIds={interactionRequiredSessionIds}
					loadingWorkspace={loadingWorkspace}
					contextPreviewCard={contextPreviewCard}
					contextPreviewActive={contextPreviewActive}
					fileTabs={fileTabs}
					activeTabId={activeTabId}
					headerActions={headerActions}
					headerLeading={headerLeading}
					onSelectSession={onSelectSession}
					onSelectContextPreview={onSelectContextPreview}
					onCloseContextPreview={onCloseContextPreview}
					onSelectFileTab={onSelectFileTab}
					onCloseFileTab={onCloseFileTab}
					onPrefetchSession={onPrefetchSession}
					onSessionsChanged={onSessionsChanged}
					onSessionRenamed={onSessionRenamed}
					onWorkspaceChanged={onWorkspaceChanged}
					onRequestCloseSession={onRequestCloseSession}
					newSessionShortcut={newSessionShortcut}
				/>

				<div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
					{/*
					 * Editor surface stays mounted whenever there is any open file
					 * tab so Monaco models survive switching to a session/preview
					 * tab. Hidden via `display: none` instead of unmounting —
					 * unmount/remount was racy and left the canvas blank on
					 * re-select.
					 */}
					{displayedFileEditorSession ? (
						<div
							className={
								fileEditorVisible ? "flex min-h-0 flex-1 flex-col" : "hidden"
							}
						>
							<WorkspaceEditorSurface
								editorSession={displayedFileEditorSession}
								workspaceRootPath={workspaceRootPath}
								fileHasChanges={activeFileHasChanges}
								onChangeSession={onChangeFileEditorSession ?? (() => {})}
								onExit={onExitFileEditor ?? (() => {})}
								onError={onFileEditorError}
							/>
						</div>
					) : null}

					{!fileEditorVisible &&
						(contextPreviewActive && contextPreviewCard ? (
							<div className="min-h-0 flex-1 overflow-hidden px-0 pt-4 pb-3">
								<SourceDetailView card={contextPreviewCard} />
							</div>
						) : activePane?.hasLoaded ? (
							<div className="flex min-h-0 flex-1 flex-col">
								<WorkspaceSessionSurfaceHeader
									session={
										sessions.find(
											(session) => session.id === activePane.sessionId,
										) ?? null
									}
								/>
								<ActiveThreadViewport
									hasSession={!!selectedSession}
									pane={activePane}
									missingScriptTypes={missingScriptTypes}
									onInitializeScript={onInitializeScript}
								/>
							</div>
						) : loadingWorkspace || loadingSession ? (
							<ConversationColdPlaceholder />
						) : (
							<div className="flex min-h-full flex-1 items-center justify-center px-8">
								<EmptyState
									workspaceState={workspace?.state ?? null}
									hasSession={!!selectedSession}
									missingScriptTypes={missingScriptTypes}
									onInitializeScript={onInitializeScript}
								/>
							</div>
						))}
				</div>
			</div>
		</HelmorProfiler>
	);
});
