import { memo, type ReactNode, useEffect } from "react";
import type {
	PullRequestInfo,
	SessionAttachmentRecord,
	WorkspaceDetail,
	WorkspaceSessionSummary,
} from "@/lib/api";
import { HelmorProfiler } from "@/lib/dev-react-profiler";
import { WorkspacePanelHeader } from "./header";
import { EmptyState, preloadStreamdown } from "./message-components";
import {
	ActiveThreadViewport,
	ConversationColdPlaceholder,
	type PresentedSessionPane,
} from "./thread-viewport";

export {
	AssistantToolCall,
	agentChildrenBlockPropsEqual,
	assistantToolCallPropsEqual,
} from "./message-components";

type WorkspacePanelProps = {
	workspace: WorkspaceDetail | null;
	prInfo?: PullRequestInfo | null;
	sessions: WorkspaceSessionSummary[];
	selectedSessionId: string | null;
	selectedProvider?: string | null;
	sessionPanes: PresentedSessionPane[];
	attachments?: SessionAttachmentRecord[];
	loadingWorkspace?: boolean;
	loadingSession?: boolean;
	refreshingWorkspace?: boolean;
	refreshingSession?: boolean;
	sending?: boolean;
	sendingSessionIds?: Set<string>;
	completedSessionIds?: Set<string>;
	interactionRequiredSessionIds?: Set<string>;
	onSelectSession?: (sessionId: string) => void;
	onPrefetchSession?: (sessionId: string) => void;
	onSessionsChanged?: () => void;
	onSessionRenamed?: (sessionId: string, title: string) => void;
	onWorkspaceChanged?: () => void;
	headerActions?: ReactNode;
	headerLeading?: ReactNode;
};

export const WorkspacePanel = memo(function WorkspacePanel({
	workspace,
	prInfo = null,
	sessions,
	selectedSessionId,
	selectedProvider,
	sessionPanes,
	attachments: _attachments,
	loadingWorkspace = false,
	loadingSession = false,
	refreshingWorkspace: _refreshingWorkspace = false,
	refreshingSession: _refreshingSession = false,
	sending = false,
	sendingSessionIds,
	completedSessionIds,
	interactionRequiredSessionIds,
	onSelectSession,
	onPrefetchSession,
	onSessionsChanged,
	onSessionRenamed,
	onWorkspaceChanged,
	headerActions,
	headerLeading,
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
					prInfo={prInfo}
					sessions={sessions}
					selectedSessionId={selectedSessionId}
					selectedProvider={selectedProvider}
					sending={sending}
					sendingSessionIds={sendingSessionIds}
					completedSessionIds={completedSessionIds}
					interactionRequiredSessionIds={interactionRequiredSessionIds}
					loadingWorkspace={loadingWorkspace}
					headerActions={headerActions}
					headerLeading={headerLeading}
					onSelectSession={onSelectSession}
					onPrefetchSession={onPrefetchSession}
					onSessionsChanged={onSessionsChanged}
					onSessionRenamed={onSessionRenamed}
					onWorkspaceChanged={onWorkspaceChanged}
				/>

				<div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
					{activePane?.hasLoaded ? (
						<ActiveThreadViewport
							hasSession={!!selectedSession}
							pane={activePane}
						/>
					) : loadingWorkspace || loadingSession ? (
						<ConversationColdPlaceholder />
					) : (
						<div className="flex min-h-full flex-1 items-center justify-center px-8">
							<EmptyState hasSession={!!selectedSession} />
						</div>
					)}
				</div>
			</div>
		</HelmorProfiler>
	);
});
