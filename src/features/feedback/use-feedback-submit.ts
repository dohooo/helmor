import type { QueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import {
	type AgentModelSection,
	submitFeedbackWorkspaceAndPrompt,
} from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import type { AppSettings } from "@/lib/settings";
import { describeUnknownError } from "@/lib/workspace-helpers";

type Deps = {
	queryClient: QueryClient;
	appSettings: AppSettings;
	selectWorkspace: (workspaceId: string | null) => void;
	selectSession: (sessionId: string | null) => void;
	setViewMode: (mode: "conversation" | "start" | "editor") => void;
	pushToast: (message: string, title: string) => void;
};

/**
 * Returns a function that hands off the feedback dialog's "Send to agent"
 * click to a single backend IPC. The Rust command
 * `submit_feedback_workspace_and_prompt` prepares the workspace, finalises
 * the worktree, and spawns the agent stream — all atomically — then
 * returns the workspace + session IDs. The frontend just selects them and
 * switches view; there's no `pendingCreatedWorkspaceSubmit` queue or
 * race between selection and finalize.
 *
 * Trade-off: the first turn doesn't render live token deltas (no
 * frontend-owned `Channel` exists yet — the conversation surface hasn't
 * mounted). Once the surface mounts on the new workspace it re-fetches
 * from DB and listens to `ActiveStreamsChanged` for refetches. Subsequent
 * turns use the normal composer flow with full live streaming.
 */
export function useFeedbackSubmit(deps: Deps) {
	const {
		queryClient,
		appSettings,
		selectWorkspace,
		selectSession,
		setViewMode,
		pushToast,
	} = deps;

	return useCallback(
		async (input: { repoId: string; prompt: string }) => {
			const sections =
				queryClient.getQueryData<AgentModelSection[]>(
					helmorQueryKeys.agentModelSections,
				) ?? [];
			const allModels = sections.flatMap((section) => section.options);
			const preferred = appSettings.defaultModelId
				? allModels.find((m) => m.id === appSettings.defaultModelId)
				: undefined;
			const model = preferred ?? allModels[0];
			if (!model) {
				pushToast(
					"Pick a default model in Settings first.",
					"Can't send feedback",
				);
				return;
			}

			try {
				const result = await submitFeedbackWorkspaceAndPrompt({
					repoId: input.repoId,
					prompt: input.prompt,
					provider: model.provider,
					modelId: model.id,
					effortLevel: appSettings.defaultEffort ?? "high",
					fastMode: appSettings.defaultFastMode ?? false,
					permissionMode: "default",
				});
				selectWorkspace(result.workspaceId);
				selectSession(result.sessionId);
				setViewMode("conversation");
			} catch (error) {
				pushToast(
					describeUnknownError(error, "Failed to send feedback to agent."),
					"Couldn't open workspace",
				);
			}
		},
		[
			appSettings.defaultEffort,
			appSettings.defaultFastMode,
			appSettings.defaultModelId,
			queryClient,
			pushToast,
			selectSession,
			selectWorkspace,
			setViewMode,
		],
	);
}
