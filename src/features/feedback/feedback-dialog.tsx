import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	createHelmorIssue,
	type ExistingHelmorRepo,
	findExistingHelmorRepo,
} from "@/lib/api";
import { useForgeAccountsAll } from "@/lib/use-forge-accounts";
import { describeUnknownError } from "@/lib/workspace-helpers";

import { splitIssueTitleAndBody } from "./helpers";
import { StepClone } from "./step-clone";
import { StepInput } from "./step-input";
import { StepPrompt } from "./step-prompt";
import { useFeedbackState } from "./use-feedback-state";

type FeedbackDialogProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onOpenSettings: () => void;
	/** Creates a new workspace on `repoId`, queues `prompt` as the first
	 *  message, selects the workspace, and switches to conversation view.
	 *  The conversation hook auto-fires the prompt once finalize completes. */
	onSubmitPrompt: (input: { repoId: string; prompt: string }) => Promise<void>;
};

export function FeedbackDialog({
	open,
	onOpenChange,
	onOpenSettings,
	onSubmitPrompt,
}: FeedbackDialogProps) {
	const [state, dispatch] = useFeedbackState();
	// Existing-repo hint: local-only (SQLite + package.json), so a fresh
	// re-fetch on every open is fine. GitHub connection state comes from
	// the shared `useForgeAccountsAll` cache so we don't pay the
	// `gh api /user` round-trip every time the dialog opens.
	const [existing, setExisting] = useState<ExistingHelmorRepo | null>(null);
	// `existingLoaded` gates Quick fix: clicking it before the lookup
	// settles would force the fork+clone path even when a local helmor
	// repo already exists. The lookup hits local SQLite + package.json,
	// usually ~50ms, but a fast typer can outrun it.
	const [existingLoaded, setExistingLoaded] = useState(false);
	const accountsQuery = useForgeAccountsAll();
	const githubConnected =
		accountsQuery.data?.some(
			(account) =>
				account.provider === "github" && account.host === "github.com",
		) ?? false;
	// Two-click confirmation for issue creation.
	const [confirming, setConfirming] = useState(false);
	const [sending, setSending] = useState(false);

	useEffect(() => {
		let cancelled = false;
		void (async () => {
			const e = await findExistingHelmorRepo().catch(() => null);
			if (cancelled) return;
			setExisting(e);
			setExistingLoaded(true);
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	// First click → arm confirm UI. Second click → send via API.
	const handleCreateIssue = useCallback(async () => {
		if (state.step.kind !== "input") return;
		if (!confirming) {
			setConfirming(true);
			return;
		}
		const { title, body } = splitIssueTitleAndBody(state.step.input);
		setSending(true);
		try {
			const result = await createHelmorIssue(title, body);
			dispatch({ type: "reset" });
			setConfirming(false);
			toast.success(`Issue #${result.number} created`, {
				description: result.url,
				action: {
					label: "View",
					onClick: () => {
						void openUrl(result.url);
					},
				},
			});
		} catch (error) {
			toast.error("Failed to create issue", {
				description: describeUnknownError(error, "Please try again."),
			});
		} finally {
			setSending(false);
		}
	}, [confirming, dispatch, state.step]);

	const handleCancelConfirm = useCallback(() => setConfirming(false), []);

	const handleQuickFix = useCallback(() => {
		setConfirming(false);
		dispatch({ type: "start-quick-fix", existing });
	}, [dispatch, existing]);

	// "Send to agent": close the dialog FIRST (the parent conditionally
	// mounts this tree, so close immediately tears it down), then kick off
	// the async workspace switch. Order matters — if we awaited the switch
	// before closing, the heavy AppShell re-render fires while the dialog is
	// still mounted, dropping focus events and risking visual artifacts on
	// top of the new conversation.
	const handleSendPrompt = useCallback(() => {
		if (state.step.kind !== "prompt" || !state.step.repoId) return;
		const { repoId, draftPrompt } = state.step;
		onOpenChange(false);
		void onSubmitPrompt({ repoId, prompt: draftPrompt });
	}, [onOpenChange, onSubmitPrompt, state.step]);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="flex flex-col gap-5 p-4 sm:max-w-md">
				<DialogHeader>
					<DialogTitle className="text-[13px] font-medium tracking-[-0.01em]">
						{state.step.kind === "input"
							? "Send feedback"
							: "Contribute to Helmor"}
					</DialogTitle>
				</DialogHeader>

				{state.step.kind === "input" ? (
					<StepInput
						input={state.step.input}
						existing={existing}
						existingLoaded={existingLoaded}
						githubConnected={githubConnected}
						confirming={confirming}
						sending={sending}
						onInputChange={(input) => {
							setConfirming(false);
							dispatch({ type: "set-input", input });
						}}
						onCreateIssue={() => {
							void handleCreateIssue();
						}}
						onCancelConfirm={handleCancelConfirm}
						onQuickFix={handleQuickFix}
						onOpenSettings={onOpenSettings}
					/>
				) : null}

				{state.step.kind === "clone" ? (
					<StepClone
						phase={state.step.phase}
						forkedCloneUrl={state.step.forkedCloneUrl}
						cloneDirectory={state.step.cloneDirectory}
						error={state.step.error}
						onPhaseChange={(phase) => dispatch({ type: "clone-phase", phase })}
						onForkSucceeded={(cloneUrl) =>
							dispatch({ type: "clone-fork-succeeded", cloneUrl })
						}
						onDirectorySelected={(directory) =>
							dispatch({ type: "clone-directory-selected", directory })
						}
						onFailed={(message) => dispatch({ type: "clone-failed", message })}
						onCloneSucceeded={(repoId) =>
							dispatch({ type: "clone-succeeded", repoId })
						}
					/>
				) : null}

				{state.step.kind === "prompt" ? (
					<StepPrompt
						input={state.step.input}
						draftPrompt={state.step.draftPrompt}
						existing={state.step.existing}
						onEditPrompt={(prompt) => dispatch({ type: "edit-prompt", prompt })}
						onSubmit={handleSendPrompt}
					/>
				) : null}
			</DialogContent>
		</Dialog>
	);
}
