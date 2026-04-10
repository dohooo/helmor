import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, TimerReset } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import type {
	AgentModelOption,
	AgentModelSection,
	AgentProvider,
	SlashCommandEntry,
} from "@/lib/api";
import { createSession, saveAutoCloseActionKinds } from "@/lib/api";
import { describeActionKind } from "@/lib/commit-button-prompts";
import type {
	ComposerCustomTag,
	ResolvedComposerInsertRequest,
} from "@/lib/composer-insert";
import {
	agentModelSectionsQueryOptions,
	autoCloseActionKindsQueryOptions,
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
import { ActionRow, ActionRowButton } from "./action-row";
import { ShimmerText } from "./ui/shimmer-text";
import { ShineBorder } from "./ui/shine-border";
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
	restoreFiles: string[];
	restoreCustomTags?: ComposerCustomTag[];
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
		filePaths: string[];
		customTags: ComposerCustomTag[];
		model: AgentModelOption;
		workingDirectory: string | null;
		effortLevel: string;
		permissionMode: string;
	}) => void;
	/** Prompt queued by an external caller to auto-submit once the displayed
	 * session matches `sessionId`. */
	pendingPromptForSession?: {
		sessionId: string;
		prompt: string;
		modelId?: string | null;
		permissionMode?: string | null;
	} | null;
	/** Called after the pending prompt has been dispatched, so the caller can
	 * clear the queue. */
	onPendingPromptConsumed?: () => void;
	pendingInsertRequests?: ResolvedComposerInsertRequest[];
	onPendingInsertRequestsConsumed?: (ids: string[]) => void;
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
		restoreFiles,
		restoreCustomTags = [],
		restoreNonce,
		modelSelections,
		effortLevels = {},
		permissionModes = {},
		onSelectModel,
		onSelectEffort,
		onTogglePlanMode,
		onSwitchSession,
		onSubmit,
		pendingPromptForSession = null,
		onPendingPromptConsumed,
		pendingInsertRequests = [],
		onPendingInsertRequestsConsumed,
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
		const pendingOverrideActive =
			pendingPromptForSession?.sessionId === displayedSessionId;
		const pendingModel = useMemo(
			() =>
				pendingOverrideActive && pendingPromptForSession?.modelId
					? findModelOption(modelSections, pendingPromptForSession.modelId)
					: null,
			[
				displayedSessionId,
				modelSections,
				pendingOverrideActive,
				pendingPromptForSession,
			],
		);
		const effectiveModel = pendingModel ?? selectedModel;
		const effectiveSelectedModelId = effectiveModel?.id ?? selectedModelId;
		const provider =
			effectiveModel?.provider ?? currentSession?.agentType ?? "claude";
		const rawEffort =
			effortLevels[composerContextKey] ?? currentSession?.effortLevel ?? "high";
		const effortLevel = clampEffortToModel(
			rawEffort,
			effectiveSelectedModelId,
			provider,
		);
		const permissionMode =
			permissionModes[composerContextKey] ??
			(currentSession?.permissionMode === "plan"
				? "plan"
				: "bypassPermissions");
		const effectivePermissionMode =
			pendingOverrideActive && pendingPromptForSession?.permissionMode
				? pendingPromptForSession.permissionMode
				: permissionMode;
		const loadingConversationContext =
			Boolean(displayedWorkspaceId) &&
			(workspaceDetailQuery.isPending || sessionsQuery.isPending);
		const composerDisabled = displayedWorkspaceId === null;

		// Auto-close opt-in state comes from settings: `auto_close_action_kinds`
		// is the persistent list of action kinds the user has enabled. A given
		// session is "auto-close enabled" when its `actionKind` is in that set.
		const autoCloseQuery = useQuery(autoCloseActionKindsQueryOptions());
		const autoCloseActionKinds = useMemo(
			() => new Set(autoCloseQuery.data ?? []),
			[autoCloseQuery.data],
		);
		const sessionActionKind = currentSession?.actionKind ?? null;
		const isActionSession = Boolean(sessionActionKind);
		const autoCloseEnabled = sessionActionKind
			? autoCloseActionKinds.has(sessionActionKind)
			: false;

		const handleToggleAutoClose = useCallback(async () => {
			if (!sessionActionKind) return;
			const currentKinds = Array.from(autoCloseActionKinds);
			const nextKinds = autoCloseEnabled
				? currentKinds.filter((kind) => kind !== sessionActionKind)
				: [...currentKinds, sessionActionKind];
			try {
				await saveAutoCloseActionKinds(nextKinds);
			} finally {
				queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.autoCloseActionKinds,
				});
			}
		}, [
			sessionActionKind,
			autoCloseActionKinds,
			autoCloseEnabled,
			queryClient,
		]);

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
		// Pending only (`isPending`) covers the very first fetch with no data
		// yet; once we have data, `isFetching` covers background refetches but
		// users don't need a spinner for those — the cached list is fine.
		const slashCommandsLoading =
			Boolean(workingDirectory) &&
			slashCommandsQuery.isPending &&
			!slashCommandsQuery.isError;
		const slashCommandsError =
			Boolean(workingDirectory) && slashCommandsQuery.isError;
		const refetchSlashCommands = useCallback(() => {
			void slashCommandsQuery.refetch();
		}, [slashCommandsQuery]);
		const handleComposerSubmit = useCallback(
			(
				prompt: string,
				imagePaths: string[],
				filePaths: string[],
				customTags: ComposerCustomTag[],
			) => {
				if (!effectiveModel) {
					return;
				}
				onSubmit({
					prompt,
					imagePaths,
					filePaths,
					customTags,
					model: effectiveModel,
					workingDirectory,
					effortLevel,
					permissionMode: effectivePermissionMode,
				});
			},
			[
				effectiveModel,
				onSubmit,
				workingDirectory,
				effortLevel,
				effectivePermissionMode,
			],
		);

		// Track which queued prompt we've already dispatched so a re-render
		// (e.g. due to query invalidation refreshing the session list) can't
		// resubmit the same prompt twice before the parent clears the queue.
		const dispatchedPromptKeyRef = useRef<string | null>(null);

		useEffect(() => {
			if (!pendingPromptForSession) {
				dispatchedPromptKeyRef.current = null;
				return;
			}
			if (pendingPromptForSession.sessionId !== displayedSessionId) {
				return;
			}
			if (pendingPromptForSession.modelId && !pendingModel) {
				// Wait for the model sections query to resolve the queued model.
				return;
			}
			if (!effectiveModel) {
				// Wait for the model sections query to resolve.
				return;
			}

			const dispatchKey = [
				pendingPromptForSession.sessionId,
				pendingPromptForSession.prompt,
				pendingPromptForSession.modelId ?? "",
				pendingPromptForSession.permissionMode ?? "",
			].join("|");
			if (dispatchedPromptKeyRef.current === dispatchKey) {
				return;
			}
			dispatchedPromptKeyRef.current = dispatchKey;

			onSubmit({
				prompt: pendingPromptForSession.prompt,
				imagePaths: [],
				filePaths: [],
				customTags: [],
				model: effectiveModel,
				workingDirectory,
				effortLevel,
				permissionMode: effectivePermissionMode,
			});
			onPendingPromptConsumed?.();
		}, [
			displayedSessionId,
			effectiveModel,
			effectivePermissionMode,
			effortLevel,
			onPendingPromptConsumed,
			onSubmit,
			pendingModel,
			pendingPromptForSession,
			workingDirectory,
		]);

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

		const actionDisplayName = sessionActionKind
			? describeActionKind(sessionActionKind)
			: null;
		const autoCloseHelpText = autoCloseEnabled
			? `Completed ${actionDisplayName ?? "action"} sessions are hidden automatically.`
			: `Hide completed ${actionDisplayName ?? "action"} sessions in this workspace.`;

		return (
			<div className="flex flex-col">
				{isActionSession ? (
					<ActionRow
						className="relative z-10 mx-auto -mb-px w-[90%] rounded-t-[14px]"
						overlay={
							autoCloseEnabled ? (
								<>
									<ShineBorder
										borderWidth={1}
										duration={8}
										shineColor={[
											"oklch(0.88 0.08 98)",
											"oklch(0.84 0.1 92)",
											"oklch(0.8 0.09 84)",
										]}
									/>
									<div className="pointer-events-none absolute inset-x-px bottom-0 z-[1] h-[2px] bg-background" />
								</>
							) : null
						}
						leading={
							sending ? (
								<ShimmerText
									durationMs={1900}
									className="truncate text-[12px] font-medium tracking-[0.02em] text-muted-foreground"
								>
									Working...
								</ShimmerText>
							) : (
								<>
									<CircleAlert
										className="size-3.5 shrink-0 text-muted-foreground/60"
										strokeWidth={1.8}
										aria-hidden="true"
									/>
									<span className="truncate text-[12px] font-medium tracking-[0.01em] text-muted-foreground">
										{autoCloseHelpText}
									</span>
								</>
							)
						}
						trailing={
							<ActionRowButton
								aria-label={
									autoCloseEnabled ? "Disable Auto Close" : "Enable Auto Close"
								}
								aria-pressed={autoCloseEnabled}
								disabled={composerDisabled}
								onClick={() => {
									void handleToggleAutoClose();
								}}
								className={
									autoCloseEnabled
										? "border-[color:oklch(0.76_0.17_88_/_0.45)] bg-[color:oklch(0.76_0.17_88_/_0.12)] text-[color:oklch(0.84_0.11_96)] hover:bg-[color:oklch(0.76_0.17_88_/_0.16)] hover:text-[color:oklch(0.9_0.08_96)]"
										: undefined
								}
							>
								<TimerReset
									className="size-[13px] shrink-0"
									strokeWidth={1.8}
								/>
								<span className="inline-flex items-center">
									{autoCloseEnabled ? "Auto Close On" : "Enable Auto Close"}
								</span>
							</ActionRowButton>
						}
					/>
				) : null}

				<WorkspaceComposer
					contextKey={composerContextKey}
					onSubmit={handleComposerSubmit}
					disabled={composerDisabled}
					submitDisabled={disabled || loadingConversationContext}
					onStop={onStop}
					sending={sending}
					selectedModelId={effectiveSelectedModelId}
					modelSections={modelSections}
					onSelectModel={handleSelectModelInner}
					provider={provider}
					effortLevel={effortLevel}
					onSelectEffort={handleSelectEffortInner}
					permissionMode={effectivePermissionMode}
					onTogglePlanMode={handleTogglePlanModeInner}
					sendError={sendError}
					restoreDraft={restoreDraft}
					restoreImages={restoreImages}
					restoreFiles={restoreFiles}
					restoreCustomTags={restoreCustomTags}
					restoreNonce={restoreNonce}
					pendingInsertRequests={pendingInsertRequests}
					onPendingInsertRequestsConsumed={onPendingInsertRequestsConsumed}
					slashCommands={slashCommands}
					slashCommandsLoading={slashCommandsLoading}
					slashCommandsError={slashCommandsError}
					onRetrySlashCommands={refetchSlashCommands}
					workspaceRootPath={workingDirectory}
				/>
			</div>
		);
	},
);
