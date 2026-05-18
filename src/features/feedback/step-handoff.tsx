import { LoaderCircle } from "lucide-react";
import { useEffect } from "react";

import { Button } from "@/components/ui/button";
import { savePersistedDraft } from "@/features/composer/draft-storage";
import {
	createSession,
	finalizeWorkspaceFromRepo,
	prepareWorkspaceFromRepo,
} from "@/lib/api";
import { describeUnknownError } from "@/lib/workspace-helpers";
import { buildPlainTextEditorState } from "./helpers";

type StepHandoffProps = {
	draftPrompt: string;
	repoId: string;
	error: string | null;
	onFailed: (message: string) => void;
	onSucceeded: (workspaceId: string, sessionId: string) => void;
	onClose: () => void;
};

export function StepHandoff({
	draftPrompt,
	repoId,
	error,
	onFailed,
	onSucceeded,
	onClose,
}: StepHandoffProps) {
	useEffect(() => {
		// Skip auto-run if we're already showing a terminal error.
		if (error) return;

		let cancelled = false;
		void (async () => {
			try {
				const prepared = await prepareWorkspaceFromRepo(repoId);
				if (cancelled) return;

				// Pre-fill the composer draft for the workspace's initial session
				// so when the user lands on the workspace the prompt is waiting
				// for a single keystroke to send. localStorage is the supported
				// seam the composer's DraftPersistencePlugin reads on mount.
				savePersistedDraft(
					`session:${prepared.initialSessionId}`,
					buildPlainTextEditorState(draftPrompt),
				);

				await finalizeWorkspaceFromRepo(prepared.workspaceId);
				if (cancelled) return;

				// Ensure the session row exists for the composer to render against.
				// `prepareWorkspaceFromRepo` already creates one, but calling
				// `createSession` here is cheap and future-proofs the flow if that
				// changes.
				await createSession(prepared.workspaceId).catch(() => {
					// Ignore — the initial session from prepare is enough.
				});
				if (cancelled) return;

				onSucceeded(prepared.workspaceId, prepared.initialSessionId);
			} catch (err) {
				if (cancelled) return;
				onFailed(
					describeUnknownError(err, "Failed to open a workspace for the fix."),
				);
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [draftPrompt, error, onFailed, onSucceeded, repoId]);

	return (
		<div className="flex flex-col gap-3">
			<h2 className="text-[13px] font-medium tracking-[-0.01em]">
				Step 3 · Opening your workspace
			</h2>

			{error ? (
				<>
					<p role="alert" className="text-[12px] leading-snug text-destructive">
						{error}. If this keeps failing, you can create an issue directly.
					</p>
					<div className="flex items-center justify-end gap-2">
						<Button type="button" variant="outline" size="sm" onClick={onClose}>
							Close
						</Button>
					</div>
				</>
			) : (
				<div className="flex items-center gap-2 text-[12px] leading-snug text-muted-foreground">
					<LoaderCircle className="size-3.5 animate-spin" strokeWidth={2.1} />
					<span>Creating a workspace and seeding your prompt…</span>
				</div>
			)}
		</div>
	);
}
