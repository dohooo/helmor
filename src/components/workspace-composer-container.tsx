import { useQuery } from "@tanstack/react-query";
import { memo, useMemo } from "react";
import type { AgentModelOption } from "@/lib/api";
import {
	agentModelSectionsQueryOptions,
	workspaceDetailQueryOptions,
	workspaceSessionsQueryOptions,
} from "@/lib/query-client";
import {
	findModelOption,
	getComposerContextKey,
	inferDefaultModelId,
} from "@/lib/workspace-helpers";
import { WorkspaceComposer } from "./workspace-composer";

type WorkspaceComposerContainerProps = {
	displayedWorkspaceId: string | null;
	displayedSessionId: string | null;
	disabled: boolean;
	onStop?: () => void;
	sending: boolean;
	sendError: string | null;
	restoreDraft: string | null;
	restoreImages: string[];
	restoreNonce: number;
	modelSelections: Record<string, string>;
	effortLevels: Record<string, string>;
	permissionModes: Record<string, string>;
	onSelectModel: (contextKey: string, modelId: string) => void;
	onSelectEffort: (contextKey: string, level: string) => void;
	onTogglePlanMode: (contextKey: string) => void;
	onSubmit: (payload: {
		prompt: string;
		imagePaths: string[];
		model: AgentModelOption;
		workingDirectory: string | null;
	}) => void;
};

export const WorkspaceComposerContainer = memo(
	function WorkspaceComposerContainer({
		displayedWorkspaceId,
		displayedSessionId,
		disabled,
		onStop,
		sending,
		sendError,
		restoreDraft,
		restoreImages,
		restoreNonce,
		modelSelections,
		effortLevels = {},
		permissionModes = {},
		onSelectModel,
		onSelectEffort,
		onTogglePlanMode,
		onSubmit,
	}: WorkspaceComposerContainerProps) {
		const modelSectionsQuery = useQuery(agentModelSectionsQueryOptions());
		const workspaceDetailQuery = useQuery({
			...workspaceDetailQueryOptions(displayedWorkspaceId ?? "__none__"),
			enabled: Boolean(displayedWorkspaceId),
		});
		const sessionsQuery = useQuery({
			...workspaceSessionsQueryOptions(displayedWorkspaceId ?? "__none__"),
			enabled: Boolean(displayedWorkspaceId),
		});

		const modelSections = modelSectionsQuery.data ?? [];
		const currentSession =
			(sessionsQuery.data ?? []).find(
				(session) => session.id === displayedSessionId,
			) ?? null;
		const composerContextKey = getComposerContextKey(
			displayedWorkspaceId,
			displayedSessionId,
		);
		const selectedModelId =
			modelSelections[composerContextKey] ??
			inferDefaultModelId(currentSession, modelSections);
		const selectedModel = useMemo(
			() => findModelOption(modelSections, selectedModelId),
			[modelSections, selectedModelId],
		);
		const provider =
			selectedModel?.provider ?? currentSession?.agentType ?? "claude";
		const effortLevel =
			effortLevels[composerContextKey] ??
			currentSession?.effortLevel ??
			"high";
		const permissionMode =
			permissionModes[composerContextKey] ??
			(currentSession?.permissionMode === "plan" ? "plan" : "acceptEdits");
		const loadingConversationContext =
			Boolean(displayedWorkspaceId) &&
			(workspaceDetailQuery.isPending || sessionsQuery.isPending);

		return (
			<WorkspaceComposer
				contextKey={composerContextKey}
				onSubmit={(prompt, imagePaths) => {
					if (!selectedModel) {
						return;
					}

					onSubmit({
						prompt,
						imagePaths,
						model: selectedModel,
						workingDirectory: workspaceDetailQuery.data?.rootPath ?? null,
					});
				}}
				disabled={displayedWorkspaceId === null}
				submitDisabled={disabled || loadingConversationContext}
				onStop={onStop}
				sending={sending}
				selectedModelId={selectedModelId}
				modelSections={modelSections}
				onSelectModel={(modelId) => {
					onSelectModel(composerContextKey, modelId);
				}}
				provider={provider}
				effortLevel={effortLevel}
				onSelectEffort={(level) => {
					onSelectEffort(composerContextKey, level);
				}}
				permissionMode={permissionMode}
				onTogglePlanMode={() => {
					onTogglePlanMode(composerContextKey);
				}}
				sendError={sendError}
				restoreDraft={restoreDraft}
				restoreImages={restoreImages}
				restoreNonce={restoreNonce}
			/>
		);
	},
);
