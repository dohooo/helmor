import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, TimerReset } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { ActionRow, ActionRowButton } from "@/components/action-row";
import { ShimmerText } from "@/components/ui/shimmer-text";
import { ShineBorder } from "@/components/ui/shine-border";
import type { PendingDeferredTool } from "@/features/conversation/pending-deferred-tool";
import type { PendingElicitation } from "@/features/conversation/pending-elicitation";
import type {
	AgentModelOption,
	AgentModelSection,
	AgentProvider,
	SlashCommandEntry,
} from "@/lib/api";
import { createSession, saveAutoCloseActionKinds } from "@/lib/api";
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
import { useSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import {
	clampEffortToModel,
	findModelOption,
	getComposerContextKey,
	isNewSession,
	resolveSessionSelectedModelId,
} from "@/lib/workspace-helpers";
import type { DeferredToolResponseHandler } from "./deferred-tool";
import type { ElicitationResponseHandler } from "./elicitation";
import { WorkspaceComposer } from "./index";

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
	pendingElicitation?: PendingElicitation | null;
	onElicitationResponse?: ElicitationResponseHandler;
	elicitationResponsePending?: boolean;
	pendingDeferredTool?: PendingDeferredTool | null;
	onDeferredToolResponse?: DeferredToolResponseHandler;
	hasPlanReview?: boolean;
	modelSelections: Record<string, string>;
	effortLevels: Record<string, string>;
	permissionModes: Record<string, string>;
	fastModes: Record<string, boolean>;
	onSelectModel: (contextKey: string, modelId: string) => void;
	onSelectEffort: (contextKey: string, level: string) => void;
	onChangePermissionMode: (contextKey: string, mode: string) => void;
	onChangeFastMode: (contextKey: string, enabled: boolean) => void;
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
		fastMode: boolean;
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

const noopDeferredToolResponse: DeferredToolResponseHandler = () => {};
const noopElicitationResponse: ElicitationResponseHandler = () => {};

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
		pendingElicitation = null,
		onElicitationResponse = noopElicitationResponse,
		elicitationResponsePending = false,
		pendingDeferredTool = null,
		onDeferredToolResponse = noopDeferredToolResponse,
		hasPlanReview = false,
		modelSelections,
		effortLevels = {},
		permissionModes = {},
		fastModes = {},
		onSelectModel,
		onSelectEffort,
		onChangePermissionMode,
		onChangeFastMode,
		onSwitchSession,
		onSubmit,
		pendingPromptForSession = null,
		onPendingPromptConsumed,
		pendingInsertRequests = [],
		onPendingInsertRequestsConsumed,
	}: WorkspaceComposerContainerProps) {
		const queryClient = useQueryClient();
		const { settings } = useSettings();
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
		const modelsLoading =
			modelSectionsQuery.isLoading &&
			modelSections.every((s) => s.options.length === 0);
		const currentSession =
			(sessionsQuery.data ?? []).find(
				(session) => session.id === displayedSessionId,
			) ?? null;
		const composerContextKey = getComposerContextKey(
			displayedWorkspaceId,
			displayedSessionId,
		);
		const selectedModelId = resolveSessionSelectedModelId({
			session: currentSession,
			modelSelections,
			modelSections,
			settingsDefaultModelId: settings.defaultModelId,
		});
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
		const cachedEffort = composerContextKey.startsWith("session:")
			? effortLevels[composerContextKey]
			: undefined;
		// For new sessions, use user setting; for existing sessions with history, use session's effort
		const sessionEffort =
			(!isNewSession(currentSession) && currentSession?.effortLevel) || null;
		const rawEffort =
			cachedEffort ?? sessionEffort ?? settings.defaultEffort ?? "high";
		const effortLevel = clampEffortToModel(
			rawEffort,
			effectiveSelectedModelId,
			modelSections,
		);
		const cachedPermissionMode = composerContextKey.startsWith("session:")
			? permissionModes[composerContextKey]
			: undefined;
		const sessionPermissionMode = !isNewSession(currentSession)
			? currentSession?.permissionMode
			: null;
		const permissionMode =
			cachedPermissionMode ??
			(sessionPermissionMode === "plan" ? "plan" : "bypassPermissions");
		const effectivePermissionMode =
			pendingOverrideActive && pendingPromptForSession?.permissionMode
				? pendingPromptForSession.permissionMode
				: permissionMode;
		const supportsFastMode = effectiveModel?.supportsFastMode === true;
		const cachedFastMode = composerContextKey.startsWith("session:")
			? fastModes[composerContextKey]
			: undefined;
		const sessionFastMode = !isNewSession(currentSession)
			? currentSession?.fastMode
			: undefined;
		const fastMode = supportsFastMode
			? (cachedFastMode ?? sessionFastMode ?? false)
			: false;
		const loadingConversationContext =
			Boolean(displayedWorkspaceId) &&
			(workspaceDetailQuery.isPending || sessionsQuery.isPending);
		const composerDisabled =
			displayedWorkspaceId === null ||
			workspaceDetailQuery.data?.state === "archived";

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

				// Only create a new session when provider changes AND the session
				// already has messages. New/empty sessions just switch in-place.
				if (
					newProvider &&
					currentProvider &&
					newProvider !== currentProvider &&
					!isNewSession(currentSession) &&
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
		const slashCommandsResponse = slashCommandsQuery.data;
		const slashCommands =
			slashCommandsResponse?.commands ?? EMPTY_SLASH_COMMANDS;
		// Pending only (`isPending`) covers the very first fetch with no data
		// yet; once we have data, `isFetching` covers background refetches but
		// users don't need a spinner for those — the cached list is fine.
		const slashCommandsLoading =
			Boolean(workingDirectory) &&
			slashCommandsQuery.isPending &&
			!slashCommandsQuery.isError;
		const slashCommandsError =
			Boolean(workingDirectory) && slashCommandsQuery.isError;
		// True when local skills are shown but the full list is still loading
		// in the background via the sidecar.
		const slashCommandsRefreshing =
			slashCommandsResponse != null && !slashCommandsResponse.isComplete;
		const refetchSlashCommands = useCallback(() => {
			void slashCommandsQuery.refetch();
		}, [slashCommandsQuery]);

		const handleComposerSubmit = useCallback(
			(
				prompt: string,
				imagePaths: string[],
				filePaths: string[],
				customTags: ComposerCustomTag[],
				options?: { permissionModeOverride?: string },
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
					permissionMode:
						options?.permissionModeOverride ?? effectivePermissionMode,
					fastMode: supportsFastMode ? fastMode : false,
				});
			},
			[
				effectiveModel,
				onSubmit,
				workingDirectory,
				effortLevel,
				effectivePermissionMode,
				fastMode,
				supportsFastMode,
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
				fastMode: supportsFastMode ? fastMode : false,
			});
			onPendingPromptConsumed?.();
		}, [
			displayedSessionId,
			effectiveModel,
			effectivePermissionMode,
			effortLevel,
			fastMode,
			onPendingPromptConsumed,
			onSubmit,
			pendingModel,
			pendingPromptForSession,
			supportsFastMode,
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

		const handleChangePermissionModeInner = useCallback(
			(mode: string) => {
				onChangePermissionMode(composerContextKey, mode);
			},
			[onChangePermissionMode, composerContextKey],
		);

		const handleChangeFastModeInner = useCallback(
			(enabled: boolean) => {
				onChangeFastMode(composerContextKey, enabled);
			},
			[onChangeFastMode, composerContextKey],
		);

		const autoCloseHelpText =
			"When enabled, action sessions will close automatically when finished.";

		return (
			<div className="flex flex-col">
				{isActionSession ? (
					<ActionRow
						className={cn(
							"relative z-10 mx-auto -mb-px w-[90%] rounded-t-2xl border-b-0",
							autoCloseEnabled ? "border-transparent" : "border-secondary/80",
						)}
						overlay={
							autoCloseEnabled ? (
								<>
									<ShineBorder
										borderWidth={1}
										duration={8}
										shineColor="var(--primary)"
									/>
									<div className="pointer-events-none absolute inset-x-px bottom-0 z-[1] h-[2px] bg-sidebar" />
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
								active={autoCloseEnabled}
								aria-label={
									autoCloseEnabled ? "Disable Auto Close" : "Enable Auto Close"
								}
								disabled={composerDisabled}
								onClick={() => {
									void handleToggleAutoClose();
								}}
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
					modelsLoading={modelsLoading}
					onSelectModel={handleSelectModelInner}
					provider={provider}
					effortLevel={effortLevel}
					onSelectEffort={handleSelectEffortInner}
					permissionMode={effectivePermissionMode}
					onChangePermissionMode={handleChangePermissionModeInner}
					fastMode={fastMode}
					onChangeFastMode={
						supportsFastMode ? handleChangeFastModeInner : undefined
					}
					sendError={sendError}
					restoreDraft={restoreDraft}
					restoreImages={restoreImages}
					restoreFiles={restoreFiles}
					restoreCustomTags={restoreCustomTags}
					restoreNonce={restoreNonce}
					pendingElicitation={pendingElicitation}
					onElicitationResponse={onElicitationResponse}
					elicitationResponsePending={elicitationResponsePending}
					pendingDeferredTool={pendingDeferredTool}
					onDeferredToolResponse={onDeferredToolResponse}
					hasPlanReview={hasPlanReview}
					pendingInsertRequests={pendingInsertRequests}
					onPendingInsertRequestsConsumed={onPendingInsertRequestsConsumed}
					slashCommands={slashCommands}
					slashCommandsLoading={slashCommandsLoading}
					slashCommandsError={slashCommandsError}
					slashCommandsRefreshing={slashCommandsRefreshing}
					onRetrySlashCommands={refetchSlashCommands}
					workspaceRootPath={workingDirectory}
				/>
			</div>
		);
	},
);
