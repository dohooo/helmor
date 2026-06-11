import { memo, type ReactNode, useEffect, useState } from "react";
import { SourceDetailView } from "@/features/source-detail";
import { TerminalSessionPanel } from "@/features/terminal/terminal-session-panel";
import type {
	AgentProvider,
	ChangeRequestInfo,
	WorkspaceDetail,
	WorkspaceSessionSummary,
} from "@/lib/api";
import { HelmorProfiler } from "@/lib/dev-react-profiler";
import type { ContextCard } from "@/lib/sources/types";
import { cn } from "@/lib/utils";
import type { WorkspaceScriptType } from "@/lib/workspace-script-actions";
import { WorkspacePanelHeader } from "./header";
import { EmptyState, preloadStreamdown } from "./message-components";
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
	onSelectSession?: (sessionId: string) => void;
	onSelectWorkspace?: (workspaceId: string) => void;
	onSelectContextPreview?: () => void;
	onCloseContextPreview?: () => void;
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
	onSelectSession,
	onSelectWorkspace,
	onSelectContextPreview,
	onCloseContextPreview,
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

	// Terminal panels stay MOUNTED across session switches (CSS-hidden, like
	// the inspector terminals). Unmount + chunk-replay cannot reproduce a TUI's
	// incremental ANSI rendering — cursor-relative sequences replayed against a
	// fresh screen / different size corrupt the layout. Track every terminal
	// session the user has visited; it unmounts only when its session closes.
	const visibleTerminalId =
		!contextPreviewActive && selectedSession?.sessionKind === "terminal"
			? selectedSession.id
			: null;
	const [visitedTerminalIds, setVisitedTerminalIds] = useState<
		ReadonlySet<string>
	>(new Set());
	useEffect(() => {
		if (!visibleTerminalId) return;
		setVisitedTerminalIds((prev) =>
			prev.has(visibleTerminalId) ? prev : new Set(prev).add(visibleTerminalId),
		);
	}, [visibleTerminalId]);
	const terminalSessions = sessions.filter(
		(session) =>
			session.sessionKind === "terminal" &&
			(visitedTerminalIds.has(session.id) || session.id === visibleTerminalId),
	);

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
			<div className="flex min-h-0 flex-1 flex-col bg-panel">
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
					headerActions={headerActions}
					headerLeading={headerLeading}
					onSelectSession={onSelectSession}
					onSelectWorkspace={onSelectWorkspace}
					onSelectContextPreview={onSelectContextPreview}
					onCloseContextPreview={onCloseContextPreview}
					onPrefetchSession={onPrefetchSession}
					onSessionsChanged={onSessionsChanged}
					onSessionRenamed={onSessionRenamed}
					onWorkspaceChanged={onWorkspaceChanged}
					onRequestCloseSession={onRequestCloseSession}
					newSessionShortcut={newSessionShortcut}
				/>

				<div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
					{terminalSessions.map((session) => (
						<div
							key={session.id}
							className={cn(
								"min-h-0 flex-1 flex-col",
								session.id === visibleTerminalId ? "flex" : "hidden",
							)}
						>
							<TerminalSessionPanel
								repoId={workspace?.repoId ?? null}
								workspaceId={session.workspaceId}
								sessionId={session.id}
								agentKind={session.agentType}
								providerSessionId={session.providerSessionId}
								isActive={session.id === visibleTerminalId}
								workspaceReady={Boolean(
									workspace && workspace.state !== "initializing",
								)}
							/>
						</div>
					))}
					{contextPreviewActive && contextPreviewCard ? (
						<div className="min-h-0 flex-1 overflow-hidden px-0 pt-4 pb-3">
							<SourceDetailView card={contextPreviewCard} />
						</div>
					) : visibleTerminalId ? null : activePane?.hasLoaded ? (
						<ActiveThreadViewport
							hasSession={!!selectedSession}
							pane={activePane}
							missingScriptTypes={missingScriptTypes}
							onInitializeScript={onInitializeScript}
						/>
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
					)}
				</div>
			</div>
		</HelmorProfiler>
	);
});
