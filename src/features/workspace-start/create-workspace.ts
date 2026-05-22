import type { SerializedEditorState } from "lexical";
import { persistSessionDraft } from "@/features/composer/draft-storage";
import type { StartSubmitMode } from "@/features/composer/start-submit-mode";
import type { ComposerCreatePrepareOutcome } from "@/features/conversation";
import {
	type FinalizeWorkspaceResponse,
	finalizeWorkspaceFromRepo,
	prepareChatWorkspace,
	prepareWorkspaceFromRepo,
	setWorkspaceLinkedDirectories,
	updateSessionSettings,
	type WorkspaceBranchIntent,
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
	runtimeName,
	branchIntent,
	submitMode,
	editorStateSnapshot,
	composerConfig,
	linkedDirectories,
	seedSessionId,
}: {
	/** Ignored in `chat` mode. */
	repoId: string;
	/** Ignored in `chat` mode. */
	sourceBranch: string;
	mode: WorkspaceMode;
	/**
	 * Phase 22c: registered runtime to bind the new workspace to.
	 * `null` (or omit) means "use the local runtime" — the backend
	 * leaves `workspaces.runtime_name` NULL in that case.
	 */
	runtimeName?: string | null;
	/** Defaults to `from_branch` when omitted. */
	branchIntent?: WorkspaceBranchIntent;
	submitMode: StartSubmitMode;
	editorStateSnapshot?: SerializedEditorState;
	/** StartPage composer picks. Persisted to the session row in all submit
	 *  modes so the row reflects the user's choice from the moment the
	 *  workspace exists — independent of whether/when the first turn runs.
	 *  Without this, switching away to start-page (which unmounts the
	 *  conversation container and drops its in-memory composer caches) and
	 *  coming back snaps the chips back to settings defaults on any session
	 *  whose first turn hasn't yet finalised. */
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
	/** Pre-allocated session UUID; forwarded to the prepare IPC so the
	 *  new `sessions.id` matches the paste-cache bucket already on disk. */
	seedSessionId?: string;
}): Promise<WorkspaceStartCreateResult> {
	// "Save for later" creates the workspace directly in `backlog` status
	// — passing it through to Phase 1 means the DB row is born in the
	// right group and the sidebar never flashes through "In progress"
	// while finalize runs. Other submit modes default to in-progress.
	const initialStatus = submitMode === "saveForLater" ? "backlog" : null;
	// Chat mode has no repo/branch — single-phase create.
	const prepared =
		mode === "chat"
			? await prepareChatWorkspace(initialStatus, seedSessionId)
			: await prepareWorkspaceFromRepo(
					repoId,
					sourceBranch,
					mode,
					branchIntent ?? null,
					initialStatus,
					runtimeName ?? null,
					seedSessionId,
				);

	// Persist pending /add-dir picks before kicking off finalize. The DB
	// write is fast and the column is just a property of the existing
	// workspace row — no need to wait for materialise.
	if (linkedDirectories && linkedDirectories.length > 0) {
		await setWorkspaceLinkedDirectories(prepared.workspaceId, [
			...linkedDirectories,
		]);
	}

	// Chat workspaces are single-phase — prepare returns a `ready` row, no
	// finalize needed. Worktree/local workspaces still need finalize.
	const finalize =
		mode === "chat"
			? null
			: () => finalizeWorkspaceFromRepo(prepared.workspaceId);

	// Single source of truth for the composer-pick persist. Awaited in every
	// submit mode — the write is one UPDATE and finishes long before the
	// user can switch surfaces, so it's not worth the complexity of racing
	// it against finalize.
	const persistComposerConfig = composerConfig
		? updateSessionSettings(prepared.initialSessionId, {
				model: composerConfig.modelId,
				effortLevel: composerConfig.effortLevel,
				permissionMode: composerConfig.permissionMode,
				fastMode: composerConfig.fastMode,
			})
		: Promise.resolve();

	if (submitMode === "saveForLater") {
		await Promise.all([
			finalize?.() ?? Promise.resolve(),
			editorStateSnapshot
				? persistSessionDraft(prepared.initialSessionId, editorStateSnapshot)
				: Promise.resolve(),
			persistComposerConfig,
		]);
		return {
			outcome: { shouldStream: false },
			workspaceId: prepared.workspaceId,
			sessionId: prepared.initialSessionId,
			preparedWorkingDirectory: prepared.workingDirectory,
		};
	}

	if (submitMode === "createOnly") {
		await Promise.all([
			finalize?.() ?? Promise.resolve(),
			persistComposerConfig,
		]);
		return {
			outcome: { shouldStream: false },
			workspaceId: prepared.workspaceId,
			sessionId: prepared.initialSessionId,
			preparedWorkingDirectory: prepared.workingDirectory,
		};
	}

	// startNow: don't block the surface swap on finalize, but do await the
	// (very fast) settings write so by the time conversation mounts and
	// reads `sessions.effort_level / model / permission_mode / fast_mode`
	// the row already reflects the user's pick.
	await persistComposerConfig;
	return {
		finalizePromise: finalize?.(),
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
