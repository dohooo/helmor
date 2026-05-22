import { useQuery, useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useMemo } from "react";
import type {
	CommitButtonState,
	WorkspaceCommitButtonMode,
} from "@/features/commit/button";
import {
	type ChangeRequestInfo,
	type DetectedEditor,
	type ForgeDetection,
	openFileInEditor,
} from "@/lib/api";
import { getMergeBlockedReason } from "@/lib/commit-button-logic";
import type {
	ActiveEditorTarget,
	DiffOpenOptions,
	InspectorFileItem,
} from "@/lib/editor-session";
import {
	helmorQueryKeys,
	workspaceForgeActionStatusQueryOptions,
	workspaceForgeQueryOptions,
} from "@/lib/query-client";
import { cn } from "@/lib/utils";
import { useWorkspaceToast } from "@/lib/workspace-toast-context";
import {
	INSPECTOR_CHANGES_BODY_VAR,
	INSPECTOR_SECTION_HEADER_HEIGHT,
	INSPECTOR_SECTION_HEIGHT_TRANSITION_CLASS,
} from "../layout";
import {
	projectCommittedChanges,
	projectStagedChanges,
	projectUnstagedChanges,
} from "./changes/project-change-rows";
import { useBranchSwitching } from "./changes/use-branch-switching";
import { useChangeGroups } from "./changes/use-change-groups";
import { useChangesState } from "./changes/use-changes-state";
import { useGitMutations } from "./changes/use-git-mutations";
import { VirtualizedChangesList } from "./changes/virtualized-changes-list";
import { GitSectionHeader } from "./git-section-header";

type ChangesSectionProps = {
	workspaceId: string | null;
	workspaceRootPath: string | null;
	workspaceBranch: string | null;
	workspaceRemoteUrl: string | null;
	workspaceTargetBranch: string | null;
	changes: InspectorFileItem[];
	editorMode: boolean;
	activeEditor?: ActiveEditorTarget | null;
	preferredEditor?: DetectedEditor | null;
	onOpenEditorFile: (path: string, options?: DiffOpenOptions) => void;
	flashingPaths: Set<string>;
	onCommitAction?: (mode: WorkspaceCommitButtonMode) => Promise<void>;
	commitButtonMode?: WorkspaceCommitButtonMode;
	commitButtonState?: CommitButtonState;
	changeRequest: ChangeRequestInfo | null;
	/** Cold-fetch indicator owned by App; drives the git-header shimmer. */
	forgeIsRefreshing?: boolean;
	/** Height of the changes body (excluding the section header). */
	bodyHeight: number;
	resizing?: boolean;
};

export function ChangesSection({
	workspaceId,
	workspaceRootPath,
	workspaceBranch,
	workspaceRemoteUrl,
	workspaceTargetBranch,
	changes,
	editorMode,
	activeEditor,
	preferredEditor = null,
	onOpenEditorFile,
	flashingPaths,
	onCommitAction,
	commitButtonMode = "create-pr",
	commitButtonState,
	changeRequest,
	forgeIsRefreshing = false,
	bodyHeight,
	resizing = false,
}: ChangesSectionProps) {
	const queryClient = useQueryClient();
	const {
		changesOpen,
		stagedOpen,
		branchDiffOpen,
		changesTreeView,
		branchDiffTreeView,
		toggleChangesOpen,
		toggleStagedOpen,
		toggleBranchDiffOpen,
		toggleChangesTreeView,
		toggleBranchDiffTreeView,
	} = useChangesState();
	const forgeQuery = useQuery({
		...workspaceForgeQueryOptions(workspaceId ?? "__none__"),
		enabled: workspaceId !== null,
	});
	const forgeStatusQuery = useQuery({
		...workspaceForgeActionStatusQueryOptions(workspaceId ?? "__none__"),
		enabled: workspaceId !== null,
	});
	const cachedForgeDetection = workspaceId
		? queryClient.getQueryData<ForgeDetection>(
				helmorQueryKeys.workspaceForge(workspaceId),
			)
		: null;
	const forgeDetection = forgeQuery.data ?? cachedForgeDetection ?? null;
	const changeRequestName = forgeDetection?.labels.changeRequestName ?? "PR";

	const branchSwitching = useBranchSwitching({
		workspaceId,
		workspaceTargetBranch,
		changes,
	});
	const stagedChanges = useMemo(() => projectStagedChanges(changes), [changes]);
	const unstagedChanges = useMemo(
		() => projectUnstagedChanges(changes),
		[changes],
	);
	const committedChanges = useMemo(
		() => projectCommittedChanges(changes),
		[changes],
	);
	const hasUncommittedChanges =
		stagedChanges.length > 0 || unstagedChanges.length > 0;
	const hasChanges = hasUncommittedChanges || committedChanges.length > 0;

	const pushToast = useWorkspaceToast();
	const {
		isContinuingWorkspace,
		stageFile,
		unstageFile,
		stageAll,
		unstageAll,
		discardFile,
		continueWorkspace: handleContinueWorkspace,
	} = useGitMutations({
		workspaceId,
		workspaceRootPath,
		stagedChanges,
		unstagedChanges,
		queryClient,
		pushToast,
	});

	const handleCommitButtonClick = useCallback(async () => {
		if (!onCommitAction) {
			return;
		}
		await onCommitAction(commitButtonMode);
	}, [commitButtonMode, onCommitAction]);

	const handleOpenExternalEditor = useCallback(
		(path: string) => {
			if (!preferredEditor) {
				pushToast("Select a default editor before opening files.", "No editor");
				return;
			}
			void openFileInEditor(path, preferredEditor.id).catch((error) => {
				pushToast(
					error instanceof Error ? error.message : String(error),
					`Failed to open ${preferredEditor.name}`,
				);
			});
		},
		[preferredEditor, pushToast],
	);

	const changeGroups = useChangeGroups({
		stagedChanges,
		unstagedChanges,
		committedChanges,
		branchSwitching,
		stagedOpen,
		changesOpen,
		branchDiffOpen,
		changesTreeView,
		toggleBranchDiffTreeView,
		branchDiffTreeView,
		toggleStagedOpen,
		toggleChangesOpen,
		toggleBranchDiffOpen,
		toggleChangesTreeView,
		stageFile,
		unstageFile,
		stageAll,
		unstageAll,
		discardFile,
		workspaceTargetBranch,
	});

	// Header shimmer is owned by App: it knows when the change-request and
	// forge-action-status queries are on their *first* cold fetch (vs. just a
	// background refresh or a placeholder render).
	const isForgeRefreshing = workspaceId !== null && forgeIsRefreshing;

	return (
		<section
			aria-label="Inspector section Git"
			className={cn(
				"flex min-h-0 shrink-0 flex-col overflow-hidden border-b border-border/60 bg-sidebar",
				resizing
					? "transition-none"
					: INSPECTOR_SECTION_HEIGHT_TRANSITION_CLASS,
			)}
			style={{
				// Height var written by mousemove directly; fallback covers the first
				// mount frame before the layout effect runs.
				height: `calc(${INSPECTOR_SECTION_HEADER_HEIGHT}px + var(${INSPECTOR_CHANGES_BODY_VAR}, ${bodyHeight}px))`,
				// Full containment isolates the file-list reflow (rows + Radix triggers
				// + truncate spans) from the rest of the page during inspector drag.
				// Section already has overflow-hidden, so `paint` doesn't change clipping.
				contain: "layout style paint",
			}}
		>
			<GitSectionHeader
				commitButtonMode={commitButtonMode}
				commitButtonState={commitButtonState}
				changeRequest={changeRequest}
				mergeBlockedReason={getMergeBlockedReason(forgeStatusQuery.data)}
				changeRequestName={changeRequestName}
				forgeRemoteState={forgeStatusQuery.data?.remoteState ?? null}
				forgeDetection={forgeDetection}
				workspaceId={workspaceId}
				hasChanges={hasChanges}
				isRefreshing={isForgeRefreshing}
				isContinuingWorkspace={isContinuingWorkspace}
				onChangeRequestClick={
					changeRequest ? () => void openUrl(changeRequest.url) : undefined
				}
				onCommit={handleCommitButtonClick}
				onContinueWorkspace={handleContinueWorkspace}
			/>

			<VirtualizedChangesList
				groups={changeGroups}
				editorMode={editorMode}
				activeEditor={activeEditor}
				onOpenEditorFile={onOpenEditorFile}
				onOpenExternalEditor={handleOpenExternalEditor}
				flashingPaths={flashingPaths}
				workspaceBranch={workspaceBranch}
				workspaceRemoteUrl={workspaceRemoteUrl}
			/>
		</section>
	);
}
