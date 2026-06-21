import type { QueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import type {
	ComposerSubmitPayload,
	PendingCreatedWorkspaceSubmit,
} from "@/features/conversation";
import { createWorkspaceFromStartComposer } from "@/features/workspace-start/create-workspace";
import type { AgentModelOption, AgentModelSection } from "@/lib/api";
import { translateSource } from "@/lib/i18n";
import { helmorQueryKeys } from "@/lib/query-client";
import type { AppSettings } from "@/lib/settings";
import { requestSidebarReconcile } from "@/lib/sidebar-mutation-gate";
import { describeUnknownError } from "@/lib/workspace-helpers";

type Deps = {
	queryClient: QueryClient;
	appSettings: AppSettings;
	selectWorkspace: (workspaceId: string | null) => void;
	selectSession: (sessionId: string | null) => void;
	setViewMode: (mode: "conversation" | "start" | "editor") => void;
	setPendingCreatedWorkspaceSubmit: (
		updater:
			| PendingCreatedWorkspaceSubmit
			| null
			| ((
					prev: PendingCreatedWorkspaceSubmit | null,
			  ) => PendingCreatedWorkspaceSubmit | null),
	) => void;
	pushToast: (message: string, title: string) => void;
};

/**
 * Submits the feedback dialog's "Send to agent" through the SAME pipeline
 * as the start page: prepare → queue pending submit → switch view → await
 * finalize → flip finalized. The conversation effect picks the pending
 * submit up once the surface mounts and dispatches it via
 * `handleComposerSubmit` — that gives the first turn a frontend-owned
 * `Channel` so live token streaming works, and ties selection to the same
 * optimistic marker the start page uses (so selection isn't clobbered by
 * sidebar reconciles or `ActiveStreamsChanged` interleaves).
 */
export function useFeedbackSubmit(deps: Deps) {
	const {
		queryClient,
		appSettings,
		selectWorkspace,
		selectSession,
		setViewMode,
		setPendingCreatedWorkspaceSubmit,
		pushToast,
	} = deps;

	return useCallback(
		async (input: { repoId: string; prompt: string }) => {
			const sections =
				queryClient.getQueryData<AgentModelSection[]>(
					helmorQueryKeys.agentModelSections,
				) ?? [];
			const allModels = sections.flatMap((section) => section.options);
			const preferredId = appSettings.defaultModel?.modelId;
			const preferred = preferredId
				? allModels.find((m) => m.id === preferredId)
				: undefined;
			const model: AgentModelOption | undefined = preferred ?? allModels[0];
			if (!model) {
				pushToast(
					translateSource("feedbackPickDefaultModelFirst"),
					translateSource("feedbackCantSendFeedback"),
				);
				return;
			}

			const payload: ComposerSubmitPayload = {
				prompt: input.prompt,
				imagePaths: [],
				filePaths: [],
				customTags: [],
				model,
				workingDirectory: null,
				effortLevel: appSettings.defaultEffort ?? "high",
				permissionMode: "default",
				fastMode: appSettings.defaultFastMode ?? false,
			};

			try {
				// Empty sourceBranch → backend falls back to repo default
				// branch. Feedback flow doesn't surface a branch picker.
				const created = await createWorkspaceFromStartComposer({
					repoId: input.repoId,
					sourceBranch: "",
					mode: "worktree",
					branchIntent: "from_branch",
					submitMode: "startNow",
					composerConfig: {
						modelId: model.id,
						effortLevel: payload.effortLevel,
						permissionMode: payload.permissionMode,
						fastMode: payload.fastMode,
					},
				});

				// Invalidate the sidebar list BEFORE switching selection.
				// Navigation's auto-select effect uses `groupsQuery.isFetching`
				// as the signal to wait for the new workspace to land — if
				// we skip this, the fresh workspace isn't in `groups`,
				// isFetching is false, and the effect falls back to
				// `findInitialWorkspaceId(groups)` which returns the
				// pinned workspace, clobbering our selection. Matches
				// startSurface controller ordering.
				requestSidebarReconcile(queryClient);

				const pendingId = crypto.randomUUID();
				setPendingCreatedWorkspaceSubmit({
					id: pendingId,
					workspaceId: created.workspaceId,
					sessionId: created.sessionId,
					payload: {
						...payload,
						workingDirectory:
							created.preparedWorkingDirectory ?? payload.workingDirectory,
					},
					finalized: false,
				});
				// Defer the view switch to the next frame so the dialog
				// tear-down doesn't compete with the conversation commit.
				requestAnimationFrame(() => {
					selectWorkspace(created.workspaceId);
					selectSession(created.sessionId);
					setViewMode("conversation");
				});

				let finalizedWorkingDirectory = created.preparedWorkingDirectory;
				if (created.finalizePromise) {
					try {
						const finalized = await created.finalizePromise;
						finalizedWorkingDirectory = finalized.workingDirectory;
					} catch (error) {
						setPendingCreatedWorkspaceSubmit((current) =>
							current?.id === pendingId ? null : current,
						);
						pushToast(
							describeUnknownError(
								error,
								translateSource("feedbackWorkspaceSetupFailed"),
							),
							translateSource("feedbackWorkspaceSetupFailed"),
						);
						requestSidebarReconcile(queryClient);
						return;
					}
				}

				// Flip finalized → conversation effect dispatches the queued
				// submit through `handleComposerSubmit`, opening a
				// frontend-owned channel for live token streaming.
				setPendingCreatedWorkspaceSubmit((current) =>
					current?.id === pendingId
						? {
								...current,
								payload: {
									...current.payload,
									workingDirectory:
										finalizedWorkingDirectory ??
										current.payload.workingDirectory,
								},
								finalized: true,
							}
						: current,
				);
				requestSidebarReconcile(queryClient);
			} catch (error) {
				pushToast(
					describeUnknownError(
						error,
						translateSource("feedbackFailedSendToAgent"),
					),
					translateSource("feedbackCouldntOpenWorkspace"),
				);
			}
		},
		[
			appSettings.defaultEffort,
			appSettings.defaultFastMode,
			appSettings.defaultModel?.modelId,
			queryClient,
			pushToast,
			selectSession,
			selectWorkspace,
			setViewMode,
			setPendingCreatedWorkspaceSubmit,
		],
	);
}
