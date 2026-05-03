import type { SerializedEditorState } from "lexical";
import { persistSessionDraft } from "@/features/composer/draft-storage";
import type { ComposerCreatePrepareOutcome } from "@/features/conversation";
import {
	type FinalizeWorkspaceResponse,
	finalizeWorkspaceFromRepo,
	prepareWorkspaceFromRepo,
	setWorkspaceStatus,
} from "@/lib/api";
import { getComposerContextKey } from "@/lib/workspace-helpers";

export type WorkspaceStartSubmitMode = "startNow" | "saveForLater";

export type WorkspaceStartCreateResult = {
	outcome: ComposerCreatePrepareOutcome;
	finalizePromise?: Promise<FinalizeWorkspaceResponse>;
};

export async function createWorkspaceFromStartComposer({
	repoId,
	sourceBranch,
	submitMode,
	editorStateSnapshot,
}: {
	repoId: string;
	sourceBranch: string;
	submitMode: WorkspaceStartSubmitMode;
	editorStateSnapshot?: SerializedEditorState;
}): Promise<WorkspaceStartCreateResult> {
	const prepared = await prepareWorkspaceFromRepo(repoId, sourceBranch);

	if (submitMode === "saveForLater") {
		await Promise.all([
			finalizeWorkspaceFromRepo(prepared.workspaceId),
			editorStateSnapshot
				? persistSessionDraft(prepared.initialSessionId, editorStateSnapshot)
				: Promise.resolve(),
		]);
		await setWorkspaceStatus(prepared.workspaceId, "backlog");
		return { outcome: { shouldStream: false } };
	}

	return {
		finalizePromise: finalizeWorkspaceFromRepo(prepared.workspaceId),
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
