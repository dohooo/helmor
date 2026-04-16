import type {
	CommitButtonState,
	WorkspaceCommitButtonMode,
} from "@/features/commit/button";
import type { PullRequestInfo } from "@/lib/api";
import type { DiffOpenOptions } from "@/lib/editor-session";
import { cn } from "@/lib/utils";
import { useWorkspaceInspectorSidebar } from "./hooks/use-inspector";
import { HorizontalResizeHandle, InspectorTabsSection } from "./layout";
import { ActionsSection } from "./sections/actions";
import { ChangesSection } from "./sections/changes";
import { RunTab } from "./sections/run";
import { SetupTab } from "./sections/setup";

type WorkspaceInspectorSidebarProps = {
	workspaceId?: string | null;
	workspaceRootPath?: string | null;
	workspaceBranch?: string | null;
	workspaceTargetBranch?: string | null;
	workspaceRemote?: string | null;
	workspaceState?: string | null;
	repoId?: string | null;
	editorMode: boolean;
	activeEditorPath?: string | null;
	onOpenEditorFile(path: string, options?: DiffOpenOptions): void;
	onOpenMockReview?: (path: string) => void;
	onCommitAction?: (mode: WorkspaceCommitButtonMode) => Promise<void>;
	commitButtonMode?: WorkspaceCommitButtonMode;
	commitButtonState?: CommitButtonState;
	prInfo?: PullRequestInfo | null;
	onOpenSettings?: () => void;
};

export function WorkspaceInspectorSidebar({
	workspaceId,
	workspaceRootPath,
	workspaceBranch,
	workspaceTargetBranch,
	workspaceRemote,
	workspaceState,
	repoId,
	editorMode,
	activeEditorPath,
	onOpenEditorFile,
	onCommitAction,
	commitButtonMode,
	commitButtonState,
	prInfo,
	onOpenSettings,
}: WorkspaceInspectorSidebarProps) {
	const {
		actionsHeight,
		actionsRef,
		activeTab,
		changes,
		changesHeight,
		clearPendingRunScript,
		containerRef,
		flashingPaths,
		handleResizeStart,
		handleToggleTabs,
		isActionsResizing,
		isResizing,
		isTabsResizing,
		pendingRunScript,
		repoScripts,
		scriptsLoaded,
		setActiveTab,
		tabsOpen,
		tabsWrapperRef,
	} = useWorkspaceInspectorSidebar({
		workspaceRootPath,
		workspaceId: workspaceId ?? null,
		repoId: repoId ?? null,
		workspaceState,
	});

	const handleOpenSettings = onOpenSettings ?? (() => {});

	return (
		<div
			ref={containerRef}
			className={cn(
				"flex h-full min-h-0 flex-col bg-sidebar",
				isResizing && "select-none",
			)}
		>
			<ChangesSection
				bodyHeight={changesHeight}
				workspaceId={workspaceId ?? null}
				workspaceRootPath={workspaceRootPath ?? null}
				workspaceBranch={workspaceBranch ?? null}
				workspaceTargetBranch={workspaceTargetBranch ?? null}
				changes={changes}
				editorMode={editorMode}
				activeEditorPath={activeEditorPath}
				onOpenEditorFile={onOpenEditorFile}
				flashingPaths={flashingPaths}
				onCommitAction={onCommitAction}
				commitButtonMode={commitButtonMode}
				commitButtonState={commitButtonState}
				prInfo={prInfo ?? null}
			/>

			<HorizontalResizeHandle
				onMouseDown={handleResizeStart("actions")}
				isActive={isActionsResizing}
			/>

			<ActionsSection
				workspaceId={workspaceId ?? null}
				workspaceRemote={workspaceRemote ?? null}
				sectionRef={actionsRef}
				bodyHeight={actionsHeight}
				expanded={!tabsOpen}
				onCommitAction={onCommitAction}
				commitButtonState={commitButtonState}
				prInfo={prInfo ?? null}
			/>

			{tabsOpen && (
				<HorizontalResizeHandle
					onMouseDown={handleResizeStart("tabs")}
					isActive={isTabsResizing}
				/>
			)}

			<InspectorTabsSection
				wrapperRef={tabsWrapperRef}
				open={tabsOpen}
				onToggle={handleToggleTabs}
				activeTab={activeTab}
				onTabChange={setActiveTab}
			>
				<SetupTab
					repoId={repoId ?? null}
					workspaceId={workspaceId ?? null}
					workspaceState={workspaceState ?? null}
					setupScript={repoScripts?.setupScript ?? null}
					scriptsLoaded={scriptsLoaded}
					isActive={activeTab === "setup"}
					onOpenSettings={handleOpenSettings}
				/>
				<RunTab
					repoId={repoId ?? null}
					workspaceId={workspaceId ?? null}
					runScript={repoScripts?.runScript ?? null}
					isActive={activeTab === "run"}
					pendingRun={pendingRunScript}
					onPendingRunHandled={clearPendingRunScript}
					onOpenSettings={handleOpenSettings}
				/>
			</InspectorTabsSection>
		</div>
	);
}
