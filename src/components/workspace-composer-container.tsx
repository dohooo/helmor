import { useQuery, useQueryClient } from "@tanstack/react-query";
import { memo, useCallback, useMemo } from "react";
import type {
	AgentModelOption,
	AgentModelSection,
	AgentProvider,
	SlashCommandEntry,
} from "@/lib/api";
import { createSession } from "@/lib/api";
import {
	agentModelSectionsQueryOptions,
	helmorQueryKeys,
	slashCommandsQueryOptions,
	workspaceDetailQueryOptions,
	workspaceSessionsQueryOptions,
} from "@/lib/query-client";
import {
	clampEffortToModel,
	findModelOption,
	getComposerContextKey,
	inferDefaultModelId,
} from "@/lib/workspace-helpers";
import { WorkspaceComposer } from "./workspace-composer";

const EMPTY_MODEL_SECTIONS: AgentModelSection[] = [];
const EMPTY_SLASH_COMMANDS: SlashCommandEntry[] = [];

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

		const modelSections = modelSectionsQuery.data ?? EMPTY_MODEL_SECTIONS;
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
		const rawEffort =
			effortLevels[composerContextKey] ?? currentSession?.effortLevel ?? "high";
		const effortLevel = clampEffortToModel(
			rawEffort,
			selectedModelId,
			provider,
		);
		const permissionMode =
			permissionModes[composerContextKey] ??
			(currentSession?.permissionMode === "plan"
				? "plan"
				: "bypassPermissions");
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

		const workingDirectory = workspaceDetailQuery.data?.rootPath ?? null;

		// Narrow `provider` (which can be the loosely-typed agentType from a
		// historical session) to a real AgentProvider before keying the
		// query — anything else degrades to claude so we never miss the popup.
		const slashProvider: AgentProvider =
			provider === "codex" ? "codex" : "claude";
		// Slash command list — keyed by (provider, workingDirectory). The
		// composer popup is hidden until this resolves; on error we fall back
		// to an empty list and the popup never opens (no UI breakage).
		const slashCommandsQuery = useQuery({
			...slashCommandsQueryOptions(
				slashProvider,
				workingDirectory,
				selectedModelId,
			),
			enabled: Boolean(workingDirectory),
		});
		const slashCommands = slashCommandsQuery.data ?? EMPTY_SLASH_COMMANDS;
		const handleComposerSubmit = useCallback(
			(prompt: string, imagePaths: string[]) => {
				if (!selectedModel) {
					return;
				}
				onSubmit({
					prompt,
					imagePaths,
					model: selectedModel,
					workingDirectory,
					effortLevel,
					permissionMode,
				});
			},
			[selectedModel, onSubmit, workingDirectory, effortLevel, permissionMode],
		);

		const handleSelectModelInner = useCallback(
			(modelId: string) => {
				void handleModelSelect(modelId);
			},
			[handleModelSelect],
		);

		const handleSelectEffortInner = useCallback(
			(level: string) => {
				onSelectEffort(composerContextKey, level);
			},
			[onSelectEffort, composerContextKey],
		);

		const handleTogglePlanModeInner = useCallback(() => {
			onTogglePlanMode(composerContextKey);
		}, [onTogglePlanMode, composerContextKey]);

		return (
			<WorkspaceComposer
				contextKey={composerContextKey}
				onSubmit={handleComposerSubmit}
				disabled={displayedWorkspaceId === null}
				submitDisabled={disabled || loadingConversationContext}
				onStop={onStop}
				sending={sending}
				selectedModelId={selectedModelId}
				modelSections={modelSections}
				onSelectModel={handleSelectModelInner}
				provider={provider}
				effortLevel={effortLevel}
				onSelectEffort={handleSelectEffortInner}
				permissionMode={permissionMode}
				onTogglePlanMode={handleTogglePlanModeInner}
				sendError={sendError}
				restoreDraft={restoreDraft}
				restoreImages={restoreImages}
				restoreNonce={restoreNonce}
				slashCommands={slashCommands}
			/>
		);
	},
);
