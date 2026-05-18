import { getVersion } from "@tauri-apps/api/app";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	createHelmorIssue,
	findExistingHelmorWorkspace,
	loadGithubIdentitySession,
} from "@/lib/api";
import { describeUnknownError } from "@/lib/workspace-helpers";

import {
	buildIssueBody,
	buildIssueTitle,
	detectOsLabel,
	type EnvironmentInfo,
} from "./helpers";
import { StepClone } from "./step-clone";
import { StepHandoff } from "./step-handoff";
import { StepInput } from "./step-input";
import { StepIssueDone } from "./step-issue-done";
import { StepIssueSending } from "./step-issue-sending";
import { StepPrHint } from "./step-pr-hint";
import { StepPrompt } from "./step-prompt";
import { useFeedbackState } from "./use-feedback-state";

type FeedbackDialogProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onOpenSettings: () => void;
	onSelectWorkspace: (workspaceId: string) => void;
};

export function FeedbackDialog({
	open,
	onOpenChange,
	onOpenSettings,
	onSelectWorkspace,
}: FeedbackDialogProps) {
	const [state, dispatch] = useFeedbackState();
	const [githubConnected, setGithubConnected] = useState(false);
	const [appVersion, setAppVersion] = useState("unknown");
	const inFlightIssueRef = useRef(false);

	const env: EnvironmentInfo = useMemo(
		() => ({ os: detectOsLabel(), appVersion }),
		[appVersion],
	);

	// Reset when closed so re-opening starts from a clean slate.
	useEffect(() => {
		if (!open) {
			dispatch({ type: "reset" });
			inFlightIssueRef.current = false;
		}
	}, [open, dispatch]);

	// Detect existing local helmor workspace + current GitHub identity when the
	// dialog opens. Both are local/cached lookups (no network) so there's no
	// loading UI.
	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		void (async () => {
			try {
				const [existing, session, version] = await Promise.all([
					findExistingHelmorWorkspace().catch(() => null),
					loadGithubIdentitySession().catch(() => null),
					getVersion().catch(() => "unknown"),
				]);
				if (cancelled) return;
				dispatch({ type: "set-existing", existing });
				setGithubConnected(session?.status === "connected");
				setAppVersion(version);
			} catch {
				// Swallow — surface via the step-specific UI when the user acts.
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [open, dispatch]);

	const handleCreateIssue = useCallback(async () => {
		if (inFlightIssueRef.current) return;
		if (state.step.kind !== "input") return;
		const { input } = state.step;
		const title = buildIssueTitle(input);
		const body = buildIssueBody(input, env);
		inFlightIssueRef.current = true;
		dispatch({ type: "start-create-issue" });
		try {
			const result = await createHelmorIssue(title, body);
			dispatch({
				type: "issue-succeeded",
				url: result.url,
				number: result.number,
			});
		} catch (error) {
			dispatch({
				type: "issue-failed",
				message: describeUnknownError(error, "Failed to create issue"),
			});
		} finally {
			inFlightIssueRef.current = false;
		}
	}, [dispatch, env, state.step]);

	const handleOpenWorkspace = useCallback(() => {
		if (state.step.kind !== "pr-hint") return;
		onSelectWorkspace(state.step.workspaceId);
		onOpenChange(false);
	}, [onOpenChange, onSelectWorkspace, state.step]);

	const handleClose = useCallback(() => {
		onOpenChange(false);
	}, [onOpenChange]);

	const title = titleForStep(state.step.kind);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="flex flex-col gap-3 p-4 sm:max-w-md">
				<DialogHeader>
					<DialogTitle className="text-[13px] font-medium tracking-[-0.01em]">
						{title}
					</DialogTitle>
				</DialogHeader>

				{state.step.kind === "input" ? (
					<StepInput
						input={state.step.input}
						error={state.step.error}
						existing={state.existing}
						githubConnected={githubConnected}
						onInputChange={(input) => dispatch({ type: "set-input", input })}
						onCreateIssue={() => {
							void handleCreateIssue();
						}}
						onQuickFix={() => dispatch({ type: "start-quick-fix" })}
						onOpenSettings={onOpenSettings}
					/>
				) : null}

				{state.step.kind === "issue-sending" ? <StepIssueSending /> : null}

				{state.step.kind === "issue-done" ? (
					<StepIssueDone
						issueUrl={state.step.issueUrl}
						issueNumber={state.step.issueNumber}
						onClose={handleClose}
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
						env={env}
						onEditPrompt={(prompt) => dispatch({ type: "edit-prompt", prompt })}
						onSubmit={() => dispatch({ type: "start-handoff" })}
					/>
				) : null}

				{state.step.kind === "handoff" ? (
					<StepHandoff
						draftPrompt={state.step.draftPrompt}
						repoId={state.step.repoId}
						error={state.step.error}
						onFailed={(message) =>
							dispatch({ type: "handoff-failed", message })
						}
						onSucceeded={(workspaceId, sessionId) =>
							dispatch({
								type: "handoff-succeeded",
								workspaceId,
								sessionId,
							})
						}
						onClose={handleClose}
					/>
				) : null}

				{state.step.kind === "pr-hint" ? (
					<StepPrHint onOpenWorkspace={handleOpenWorkspace} />
				) : null}
			</DialogContent>
		</Dialog>
	);
}

function titleForStep(kind: string): string {
	switch (kind) {
		case "input":
			return "Send feedback";
		case "issue-sending":
			return "Creating issue";
		case "issue-done":
			return "Thanks for the feedback!";
		case "clone":
			return "Contribute to Helmor";
		case "prompt":
			return "Contribute to Helmor";
		case "handoff":
			return "Contribute to Helmor";
		case "pr-hint":
			return "Nearly there";
		default:
			return "Feedback";
	}
}
