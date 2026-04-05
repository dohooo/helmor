import { useQuery, useQueryClient } from "@tanstack/react-query";
import { memo, useCallback, useMemo } from "react";
import type { AgentModelOption } from "@/lib/api";
import { createSession } from "@/lib/api";
import {
	agentModelSectionsQueryOptions,
	helmorQueryKeys,
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
	onSwitchSession?: (sessionId: string) => void;
	onSubmit: (payload: {
		prompt: string;
		imagePaths: string[];
		model: AgentModelOption;
		workingDirectory: string | null;
		effortLevel: string;
		permissionMode: string;
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
		onSwitchSession,
		onSubmit,
	}: WorkspaceComposerContainerProps) {
		const queryClient = useQueryClient();
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
		const isOpus = selectedModelId === "opus-1m" || selectedModelId === "opus";
		const rawEffort =
			effortLevels[composerContextKey] ?? currentSession?.effortLevel ?? "high";
		const effectiveEffort = (() => {
			let level = rawEffort;
			if (provider === "codex") {
				if (level === "max") level = "xhigh";
			} else {
				if (level === "xhigh") level = isOpus ? "max" : "high";
				if (level === "minimal") level = "low";
				if (level === "max" && !isOpus) level = "high";
			}
			return level;
		})();
		const effortLevel = effectiveEffort;
		const permissionMode =
			permissionModes[composerContextKey] ??
			(currentSession?.permissionMode === "plan" ? "plan" : "acceptEdits");
		const loadingConversationContext =
			Boolean(displayedWorkspaceId) &&
			(workspaceDetailQuery.isPending || sessionsQuery.isPending);

		const handleModelSelect = useCallback(
			async (modelId: string) => {
				const newModel = findModelOption(modelSections, modelId);
				const currentProvider = provider;
				const newProvider = newModel?.provider;

				// If provider changed and session has been used (has agentType),
				// create a new session for the new provider
				if (
					newProvider &&
					currentProvider &&
					newProvider !== currentProvider &&
					currentSession?.agentType &&
					displayedSessionId &&
					displayedWorkspaceId
				) {
					try {
						const { sessionId: newSessionId } =
							await createSession(displayedWorkspaceId);
						await queryClient.invalidateQueries({
							queryKey: helmorQueryKeys.workspaceSessions(displayedWorkspaceId),
						});
						onSwitchSession?.(newSessionId);
						const newContextKey = getComposerContextKey(
							displayedWorkspaceId,
							newSessionId,
						);
						onSelectModel(newContextKey, modelId);
						return;
					} catch {
						// Fall through to just update model
					}
				}

				onSelectModel(composerContextKey, modelId);
			},
			[
				modelSections,
				provider,
				currentSession,
				displayedSessionId,
				displayedWorkspaceId,
				composerContextKey,
				onSelectModel,
				onSwitchSession,
				queryClient,
			],
		);

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
						effortLevel: effectiveEffort,
						permissionMode,
					});
				}}
				disabled={displayedWorkspaceId === null}
				submitDisabled={disabled || loadingConversationContext}
				onStop={onStop}
				sending={sending}
				selectedModelId={selectedModelId}
				modelSections={modelSections}
				onSelectModel={(modelId) => {
					void handleModelSelect(modelId);
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
