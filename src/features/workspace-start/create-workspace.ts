import type { SerializedEditorState } from "lexical";
import { persistSessionDraft } from "@/features/composer/draft-storage";
import type { StartSubmitMode } from "@/features/composer/start-submit-mode";
import type { ComposerCreatePrepareOutcome } from "@/features/conversation";
import {
	type FinalizeWorkspaceResponse,
	finalizeWorkspaceFromRepo,
	prepareWorkspaceFromRepo,
	setWorkspaceLinkedDirectories,
	updateSessionSettings,
	type WorkspaceMode,
} from "@/lib/api";
import { getComposerContextKey } from "@/lib/workspace-helpers";

export type WorkspaceStartCreateResult = {
	outcome: ComposerCreatePrepareOutcome;
	workspaceId: string;
	sessionId: string;
	finalizePromise?: Promise<FinalizeWorkspaceResponse>;
	/** CWD already known after Phase 1 (local mode populates it from repo
	 *  root_path; worktree mode is null until finalize completes). The
	 *  caller pins this onto the pending-submit payload so the very first
	 *  agent turn never races the workspaceDetail React Query. */
	preparedWorkingDirectory: string | null;
};

export async function createWorkspaceFromStartComposer({
	repoId,
	sourceBranch,
	mode,
	submitMode,
	editorStateSnapshot,
	composerConfig,
	linkedDirectories,
}: {
	repoId: string;
	sourceBranch: string;
	mode: WorkspaceMode;
	submitMode: StartSubmitMode;
	editorStateSnapshot?: SerializedEditorState;
	/** StartPage composer picks. Only persisted to the session row on
	 *  saveForLater; startNow consumes them via the submit payload. */
	composerConfig?: {
		modelId?: string;
		effortLevel?: string;
		permissionMode?: string;
		fastMode?: boolean;
	};
	/** Pre-workspace `/add-dir` picks. Written onto the freshly-prepared
	 *  workspace row immediately so the conversation-mode composer (which
	 *  reads the workspace-scoped query) sees them on first mount. */
	linkedDirectories?: readonly string[];
}): Promise<WorkspaceStartCreateResult> {
	// "Save for later" creates the workspace directly in `backlog` status
	// — passing it through to Phase 1 means the DB row is born in the
	// right group and the sidebar never flashes through "In progress"
	// while finalize runs. Other submit modes default to in-progress.
	const initialStatus = submitMode === "saveForLater" ? "backlog" : null;
	const prepared = await prepareWorkspaceFromRepo(
		repoId,
		sourceBranch,
		mode,
		initialStatus,
	);

	// Persist pending /add-dir picks before kicking off finalize. The DB
	// write is fast and the column is just a property of the existing
	// workspace row — no need to wait for materialise.
	if (linkedDirectories && linkedDirectories.length > 0) {
		await setWorkspaceLinkedDirectories(prepared.workspaceId, [
			...linkedDirectories,
		]);
	}

	if (submitMode === "saveForLater") {
		await Promise.all([
			finalizeWorkspaceFromRepo(prepared.workspaceId),
			editorStateSnapshot
				? persistSessionDraft(prepared.initialSessionId, editorStateSnapshot)
				: Promise.resolve(),
			composerConfig
				? updateSessionSettings(prepared.initialSessionId, {
						model: composerConfig.modelId,
						effortLevel: composerConfig.effortLevel,
						permissionMode: composerConfig.permissionMode,
						fastMode: composerConfig.fastMode,
					})
				: Promise.resolve(),
		]);
		return {
			outcome: { shouldStream: false },
			workspaceId: prepared.workspaceId,
			sessionId: prepared.initialSessionId,
			preparedWorkingDirectory: prepared.workingDirectory,
		};
	}

	if (submitMode === "createOnly") {
		await finalizeWorkspaceFromRepo(prepared.workspaceId);
		return {
			outcome: { shouldStream: false },
			workspaceId: prepared.workspaceId,
			sessionId: prepared.initialSessionId,
			preparedWorkingDirectory: prepared.workingDirectory,
		};
	}

	return {
		finalizePromise: finalizeWorkspaceFromRepo(prepared.workspaceId),
		workspaceId: prepared.workspaceId,
		sessionId: prepared.initialSessionId,
		preparedWorkingDirectory: prepared.workingDirectory,
		outcome: {
			shouldStream: true,
			workspaceId: prepared.workspaceId,
			sessionId: prepared.initialSessionId,
			contextKey: getComposerContextKey(
				prepared.workspaceId,
				prepared.initialSessionId,
			),
		},
	};
}
