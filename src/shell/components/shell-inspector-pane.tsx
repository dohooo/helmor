// Right inspector pane — toggles between the workspace inspector tabs and
// the context-cards sidebar (which serves both the start and the workspace
// surface). Receives every piece of state it needs as props from AppShell.
import { useLayoutEffect, useRef } from "react";
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
import type { ShellViewMode } from "@/shell/controllers/use-selection-controller";
import { useEdgePeek } from "@/shell/hooks/use-edge-peek";

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
	const { open: peekOpen, peekHandlers } = useEdgePeek();
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
				"group/inspector relative h-full shrink-0 overflow-hidden bg-inspector has-[[data-tabs-zoomed=true]]:z-50 has-[[data-tabs-zoomed=true]]:overflow-visible max-[960px]:absolute max-[960px]:bottom-[18px] max-[960px]:right-0 max-[960px]:top-9 max-[960px]:z-50 max-[960px]:h-auto max-[960px]:!w-6 max-[960px]:!max-w-[calc(100vw-12px)] max-[960px]:overflow-visible max-[960px]:rounded-xl max-[960px]:border max-[960px]:border-transparent max-[960px]:bg-transparent max-[960px]:shadow-none max-[960px]:ring-0",
				resizing
					? "transition-none"
					: "transition-[width] duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none",
				collapsed ? "pointer-events-none max-[960px]:pointer-events-auto" : "",
			)}
			// `paint` omitted so the tabs hover-zoom can overflow.
			style={{ contain: "layout style" }}
		>
			<div
				data-shell-pane-hover="inspector"
				{...peekHandlers}
				className={cn(
					"contents max-[960px]:absolute max-[960px]:inset-y-0 max-[960px]:right-0 max-[960px]:block max-[960px]:overflow-visible max-[960px]:pointer-events-auto",
					peekOpen ? "max-[960px]:!w-[332px]" : "max-[960px]:!w-6",
				)}
			>
				<div
					ref={innerRef}
					data-shell-pane-inner="inspector"
					className={cn(
						"h-full shrink-0 transition-[opacity,translate] duration-[280ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none max-[960px]:ml-auto max-[960px]:mr-3 max-[960px]:!w-[320px] max-[960px]:!max-w-[calc(100vw-24px)] max-[960px]:rounded-xl max-[960px]:border max-[960px]:border-border/70 max-[960px]:bg-inspector max-[960px]:shadow-[0_24px_70px_rgba(0,0,0,0.22)] max-[960px]:ring-1 max-[960px]:ring-background/55 max-[960px]:will-change-transform dark:max-[960px]:shadow-[0_24px_70px_rgba(0,0,0,0.55)]",
						peekOpen
							? "max-[960px]:translate-x-0 max-[960px]:opacity-100"
							: "max-[960px]:translate-x-full max-[960px]:opacity-0",
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
							onInboxProviderSourceTabChange={
								onStartInboxProviderSourceTabChange
							}
							inboxStateFilterBySource={startInboxStateFilterBySource}
							onInboxStateFilterBySourceChange={
								onStartInboxStateFilterBySourceChange
							}
							composerInsertTarget={
								viewMode === "start" ? startComposerInsertTarget : undefined
							}
							selectedCardId={
								viewMode === "start"
									? startPreviewCardId
									: workspacePreviewCardId
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
			</div>
		</aside>
	);
}
