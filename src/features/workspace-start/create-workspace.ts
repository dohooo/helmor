import type { SerializedEditorState } from "lexical";
import { persistSessionDraft } from "@/features/composer/draft-storage";
import type { ComposerCreatePrepareOutcome } from "@/features/conversation";
import {
	type FinalizeWorkspaceResponse,
	finalizeWorkspaceFromRepo,
	prepareWorkspaceFromRepo,
	setWorkspaceLinkedDirectories,
	setWorkspaceStatus,
	updateSessionSettings,
	type WorkspaceMode,
} from "@/lib/api";
import { getComposerContextKey } from "@/lib/workspace-helpers";

export type WorkspaceStartSubmitMode = "startNow" | "saveForLater";

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
	submitMode: WorkspaceStartSubmitMode;
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
	const prepared = await prepareWorkspaceFromRepo(repoId, sourceBranch, mode);

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
		await setWorkspaceStatus(prepared.workspaceId, "backlog");
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
