import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { open as openDirectoryDialog } from "@tauri-apps/plugin-dialog";
import { CircleAlert, TimerReset } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ActionRow, ActionRowButton } from "@/components/action-row";
import { ShimmerText } from "@/components/ui/shimmer-text";
import { ShineBorder } from "@/components/ui/shine-border";
import type { PendingDeferredTool } from "@/features/conversation/pending-deferred-tool";
import type { PendingElicitation } from "@/features/conversation/pending-elicitation";
import {
	getShortcut,
	getShortcutConflicts,
} from "@/features/shortcuts/registry";
import type {
	AgentModelOption,
	AgentModelSection,
	AgentProvider,
	CandidateDirectory,
	SlashCommandEntry,
} from "@/lib/api";
import {
	createSession,
	mutateCodexGoal,
	saveAutoCloseActionKinds,
	setWorkspaceLinkedDirectories,
} from "@/lib/api";
import { isAutoHideableActionKind } from "@/lib/commit-button-prompts";
import type {
	ComposerCustomTag,
	ResolvedComposerInsertRequest,
} from "@/lib/composer-insert";
import {
	agentModelSectionsQueryOptions,
	autoCloseActionKindsQueryOptions,
	helmorQueryKeys,
	sessionCodexGoalQueryOptions,
	slashCommandsQueryOptions,
	workspaceCandidateDirectoriesQueryOptions,
	workspaceDetailQueryOptions,
	workspaceLinkedDirectoriesQueryOptions,
	workspaceSessionsQueryOptions,
} from "@/lib/query-client";
import { useSettings } from "@/lib/settings";
import type { QueuedSubmit } from "@/lib/use-submit-queue";
import { cn } from "@/lib/utils";
import {
	clampEffortToModel,
	findModelOption,
	getComposerContextKey,
	isNewSession,
	resolveSessionSelectedModelId,
} from "@/lib/workspace-helpers";
import { CodexGoalBanner } from "../panel/codex-goal-banner";
import type { DeferredToolResponseHandler } from "./deferred-tool";
import type { AddDirPickerEntry } from "./editor/add-dir/typeahead-plugin";
import type { ElicitationResponseHandler } from "./elicitation";
import { WorkspaceComposer } from "./index";
import { SubmitQueueList } from "./submit-queue-list";

const EMPTY_MODEL_SECTIONS: AgentModelSection[] = [];
const EMPTY_SLASH_COMMANDS: SlashCommandEntry[] = [];
const EMPTY_LINKED_DIRECTORIES: readonly string[] = [];
const EMPTY_CANDIDATE_DIRECTORIES: readonly CandidateDirectory[] = [];
const EMPTY_QUEUE_ITEMS: readonly QueuedSubmit[] = [];

/**
 * Host-app slash commands. Prepended to the agent-supplied list so they
 * always appear at the top of the popup.
 */
const ADD_DIR_COMMAND: SlashCommandEntry = {
	name: "add-dir",
	description: "Link extra directories to this workspace",
	source: "client-action",
};

const CODEX_COMPACT_COMMAND: SlashCommandEntry = {
	name: "compact",
	description: "Compact this Codex thread's context",
	source: "builtin",
	providers: ["codex"],
};

const CODEX_GOAL_COMMAND: SlashCommandEntry = {
	name: "goal",
	description:
		"Set a persistent goal Codex pursues turn-after-turn until done or paused",
	argumentHint: "<objective>",
	source: "builtin",
	providers: ["codex"],
};

const BUILTIN_CLIENT_COMMANDS: readonly SlashCommandEntry[] = [
	ADD_DIR_COMMAND,
	CODEX_COMPACT_COMMAND,
	CODEX_GOAL_COMMAND,
];

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
	persistDrafts?: boolean;
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
	activeFastPreludes?: Record<string, boolean>;
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
		/** Force queue (bypass `followUpBehavior`) if a turn is streaming. */
		forceQueue?: boolean;
		/** When set, override the user's `followUpBehavior` setting for this
		 *  one submit (queue ↔ steer). Used by the "send with opposite
		 *  follow-up" composer shortcut. Ignored when `forceQueue` is true. */
		followUpBehaviorOverride?: "queue" | "steer";
	}) => void;
	/** Prompt queued by an external caller to auto-submit once the displayed
	 * session matches `sessionId`. */
	pendingPromptForSession?: {
		sessionId: string;
		prompt: string;
		modelId?: string | null;
		/** Effort level forced for this pending submit. Takes precedence over
		 *  cached/session/default effort. */
		effort?: string | null;
		/** Fast-mode forced for this pending submit. Takes precedence over
		 *  cached/session/default fast-mode. */
		fastMode?: boolean | null;
		permissionMode?: string | null;
		/** Force queue (bypass `followUpBehavior`) if a turn is streaming. */
		forceQueue?: boolean;
	} | null;
	/** Called after the pending prompt has been dispatched, so the caller can
	 * clear the queue. */
	onPendingPromptConsumed?: () => void;
	pendingInsertRequests?: ResolvedComposerInsertRequest[];
	onPendingInsertRequestsConsumed?: (ids: string[]) => void;
	/** Follow-up queue rendered above composer when `followUpBehavior === 'queue'`. */
	queueItems?: readonly QueuedSubmit[];
	onSteerQueued?: (itemId: string) => void;
	onRemoveQueued?: (itemId: string) => void;
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
		persistDrafts = true,
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
		activeFastPreludes = {},
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
		queueItems = EMPTY_QUEUE_ITEMS,
		onSteerQueued,
		onRemoveQueued,
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
		const linkedDirectoriesQuery = useQuery({
			...workspaceLinkedDirectoriesQueryOptions(
				displayedWorkspaceId ?? "__none__",
			),
			enabled: Boolean(displayedWorkspaceId),
		});
		const linkedDirectories =
			linkedDirectoriesQuery.data ?? EMPTY_LINKED_DIRECTORIES;

		// Candidate workspaces the /add-dir popup offers as quick picks.
		// Excludes the currently-active workspace (you're already in it —
		// linking self to self is a no-op).
		const candidateDirectoriesQuery = useQuery({
			...workspaceCandidateDirectoriesQueryOptions(
				displayedWorkspaceId ?? null,
			),
			enabled: Boolean(displayedWorkspaceId),
		});
		const candidateDirectories =
			candidateDirectoriesQuery.data ?? EMPTY_CANDIDATE_DIRECTORIES;

		const linkedDirectoriesMutation = useMutation({
			mutationFn: async (next: string[]) => {
				if (!displayedWorkspaceId) {
					throw new Error("No workspace selected");
				}
				return setWorkspaceLinkedDirectories(displayedWorkspaceId, next);
			},
			// Write the server's canonical (trimmed + deduped) list into
			// the query cache immediately so any back-to-back mutation
			// computes its next value from fresh state, not the stale
			// pre-mutation list. Prevents the obvious race when the user
			// removes two chips in quick succession.
			onSuccess: (returned) => {
				if (!displayedWorkspaceId) return;
				queryClient.setQueryData(
					helmorQueryKeys.workspaceLinkedDirectories(displayedWorkspaceId),
					returned,
				);
				void queryClient.invalidateQueries({
					predicate: (query) =>
						query.queryKey[0] === "slashCommands" &&
						query.queryKey[3] === displayedWorkspaceId,
				});
			},
			onError: (error) => {
				toast.error(
					error instanceof Error
						? error.message
						: "Failed to update linked directories",
				);
			},
		});

		const handleRemoveLinkedDirectory = useCallback(
			(path: string) => {
				if (!displayedWorkspaceId) return;
				// `mutate` (not `mutateAsync`) sends errors through the
				// `onError` callback configured above — no need to catch.
				linkedDirectoriesMutation.mutate(
					linkedDirectories.filter((d) => d !== path),
				);
			},
			[displayedWorkspaceId, linkedDirectories, linkedDirectoriesMutation],
		);

		// Handle a pick from the AddDirTypeaheadPlugin popup. For
		// candidate entries we toggle linking by path (adds if new,
		// removes if already linked — matches the "linked" badge in
		// the popup). For "browse" we open the native directory picker.
		const handlePickAddDir = useCallback(
			async (entry: AddDirPickerEntry) => {
				if (!displayedWorkspaceId) return;
				if (entry.kind === "browse") {
					let picked: string | null = null;
					try {
						const selected = await openDirectoryDialog({
							directory: true,
							multiple: false,
						});
						picked = typeof selected === "string" ? selected : null;
					} catch (error) {
						toast.error(
							error instanceof Error
								? error.message
								: "Could not open directory picker",
						);
						return;
					}
					if (!picked) return;
					if (linkedDirectories.includes(picked)) return;
					linkedDirectoriesMutation.mutate([...linkedDirectories, picked]);
					return;
				}
				const path = entry.candidate.absolutePath;
				if (entry.alreadyLinked) {
					linkedDirectoriesMutation.mutate(
						linkedDirectories.filter((d) => d !== path),
					);
				} else {
					linkedDirectoriesMutation.mutate([...linkedDirectories, path]);
				}
			},
			[displayedWorkspaceId, linkedDirectories, linkedDirectoriesMutation],
		);

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
		const shortcutConflicts = useMemo(
			() => getShortcutConflicts(settings.shortcuts),
			[settings.shortcuts],
		);
		const focusShortcut = shortcutConflicts.conflictById["composer.focus"]
			? null
			: getShortcut(settings.shortcuts, "composer.focus");
		const togglePlanShortcut = shortcutConflicts.conflictById[
			"composer.togglePlanMode"
		]
			? null
			: getShortcut(settings.shortcuts, "composer.togglePlanMode");
		const toggleFollowUpShortcut = shortcutConflicts.conflictById[
			"composer.toggleFollowUpBehavior"
		]
			? null
			: getShortcut(settings.shortcuts, "composer.toggleFollowUpBehavior");
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
		const pendingEffort =
			pendingOverrideActive && pendingPromptForSession?.effort
				? pendingPromptForSession.effort
				: null;
		const rawEffort =
			pendingEffort ??
			cachedEffort ??
			sessionEffort ??
			settings.defaultEffort ??
			"high";
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
		const pendingFastMode =
			pendingOverrideActive &&
			pendingPromptForSession?.fastMode !== undefined &&
			pendingPromptForSession?.fastMode !== null
				? pendingPromptForSession.fastMode
				: undefined;
		const fastMode = supportsFastMode
			? (pendingFastMode ??
				cachedFastMode ??
				sessionFastMode ??
				settings.defaultFastMode ??
				false)
			: false;
		const showFastModePrelude = activeFastPreludes[composerContextKey] === true;
		const loadingConversationContext =
			Boolean(displayedWorkspaceId) &&
			(workspaceDetailQuery.isPending || sessionsQuery.isPending);
		// Split the "disabled" concept along two axes:
		//
		//   * `composerUnavailable` — the composer is conceptually not
		//     usable here (no workspace selected, or workspace archived).
		//     Entire UI dims to opacity-60, all toolbars disabled.
		//
		//   * `composerAwaitingFinalize` — workspace is still in Phase 2
		//     (`initializing`). The composer is fully live visually so the
		//     user can compose / tweak settings while the worktree is
		//     materializing; only the Send button is blocked (see
		//     `submitDisabled` below) to keep sends from racing with
		//     finalize. The typical ~200-500ms window ends long before the
		//     user finishes typing, so there is no visible transition.
		const composerUnavailable =
			displayedWorkspaceId === null ||
			workspaceDetailQuery.data?.state === "archived";
		const composerAwaitingFinalize =
			workspaceDetailQuery.data?.state === "initializing";

		// Auto-close opt-in state comes from settings: `auto_close_action_kinds`
		// is the persistent list of action kinds the user has enabled. A given
		// session is "auto-close enabled" when its `actionKind` is in that set.
		const autoCloseQuery = useQuery(autoCloseActionKindsQueryOptions());
		const autoCloseActionKinds = useMemo(
			() => new Set(autoCloseQuery.data ?? []),
			[autoCloseQuery.data],
		);
		const sessionActionKind = currentSession?.actionKind ?? null;
		// "Action session" here drives the Auto-Close composer affordance.
		// Some kinds (e.g. "review") are auto-created but explicitly NOT
		// auto-hideable — they exist for the user to read — so we hide the
		// toggle UI for them.
		const isActionSession =
			sessionActionKind !== null && isAutoHideableActionKind(sessionActionKind);
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
						await Promise.all([
							queryClient.invalidateQueries({
								queryKey:
									helmorQueryKeys.workspaceSessions(displayedWorkspaceId),
							}),
							...(workspaceDetailQuery.data?.repoId
								? [
										queryClient.invalidateQueries({
											queryKey: helmorQueryKeys.repoScripts(
												workspaceDetailQuery.data.repoId,
												displayedWorkspaceId,
											),
										}),
									]
								: []),
						]);
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
				workspaceDetailQuery.data?.repoId,
			],
		);

		const workingDirectory =
			workspaceDetailQuery.data?.state === "archived"
				? null
				: (workspaceDetailQuery.data?.rootPath ?? null);

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
				workspaceDetailQuery.data?.repoId ?? null,
				displayedWorkspaceId,
			),
			enabled: Boolean(workingDirectory),
		});
		const slashCommandsResponse = slashCommandsQuery.data;
		const agentSlashCommands =
			slashCommandsResponse?.commands ?? EMPTY_SLASH_COMMANDS;
		// Prepend Helmor's host-app commands (e.g. /add-dir) so they always
		// show at the top of the popup, even before the agent-supplied list
		// has loaded.
		const slashCommands = useMemo<readonly SlashCommandEntry[]>(
			() => [
				...BUILTIN_CLIENT_COMMANDS.filter(
					(command) =>
						!command.providers || command.providers.includes(slashProvider),
				),
				...agentSlashCommands,
			],
			[agentSlashCommands, slashProvider],
		);
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

		// Pull the active codex goal so we can intercept `/goal X` submissions
		// when one is already in flight and ask the user for confirmation
		// before replacing it.
		const codexGoalQuery = useQuery({
			...sessionCodexGoalQueryOptions(displayedSessionId ?? "__none__"),
			enabled: Boolean(displayedSessionId) && provider === "codex",
		});
		const activeGoal = codexGoalQuery.data ?? null;

		type PendingGoalReplace = {
			newObjective: string;
			args: Parameters<typeof handleComposerSubmitInner>;
		};
		const [goalReplaceConfirm, setGoalReplaceConfirm] =
			useState<PendingGoalReplace | null>(null);

		const handleComposerSubmitInner = useCallback(
			(
				prompt: string,
				imagePaths: string[],
				filePaths: string[],
				customTags: ComposerCustomTag[],
				options?: {
					permissionModeOverride?: string;
					oppositeFollowUp?: boolean;
				},
			) => {
				if (!effectiveModel) {
					return;
				}
				// Translate the per-submit "opposite" toggle into a concrete
				// override based on the user's persistent setting. The setting
				// itself is left untouched.
				const followUpBehaviorOverride = options?.oppositeFollowUp
					? settings.followUpBehavior === "queue"
						? "steer"
						: "queue"
					: undefined;
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
					followUpBehaviorOverride,
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
				settings.followUpBehavior,
			],
		);

		const handleComposerSubmit = useCallback(
			(
				prompt: string,
				imagePaths: string[],
				filePaths: string[],
				customTags: ComposerCustomTag[],
				options?: {
					permissionModeOverride?: string;
					oppositeFollowUp?: boolean;
				},
			) => {
				// `/goal …` interception for codex sessions. Three flavors:
				//   - `/goal pause` / `/goal clear`  → out-of-band mutate IPC,
				//     no chat bubble (matches the banner-button behaviour).
				//   - `/goal resume`                 → falls through to send-
				//     Message so the resulting stream subscription catches
				//     the goal-continuation turn codex auto-spawns.
				//   - `/goal <new objective>` while a goal already exists
				//                                    → confirm-replace panel.
				if (provider === "codex" && displayedSessionId) {
					const match = prompt.trim().match(/^\/goal\s+([\s\S]+)$/);
					const arg = match ? (match[1]?.trim() ?? "") : "";
					if (arg === "pause" || arg === "clear") {
						if (activeGoal) {
							void mutateCodexGoal(displayedSessionId, arg).catch((err) => {
								toast.error(
									err instanceof Error ? err.message : `Failed to ${arg} goal`,
								);
							});
						}
						return;
					}
					if (
						arg &&
						arg !== "resume" &&
						activeGoal &&
						arg !== activeGoal.objective
					) {
						setGoalReplaceConfirm({
							newObjective: arg,
							args: [prompt, imagePaths, filePaths, customTags, options],
						});
						return;
					}
				}
				handleComposerSubmitInner(
					prompt,
					imagePaths,
					filePaths,
					customTags,
					options,
				);
			},
			[provider, displayedSessionId, activeGoal, handleComposerSubmitInner],
		);

		const handleGoalReplaceConfirm = useCallback(() => {
			if (!goalReplaceConfirm) return;
			const args = goalReplaceConfirm.args;
			setGoalReplaceConfirm(null);
			handleComposerSubmitInner(...args);
		}, [goalReplaceConfirm, handleComposerSubmitInner]);

		const handleGoalReplaceCancel = useCallback(() => {
			setGoalReplaceConfirm(null);
		}, []);

		// Resume button on the goal banner — synthesises a `/goal resume`
		// submit so it travels through the normal sendMessage path. The
		// resulting stream subscription is what catches the
		// goal-continuation turn codex auto-spawns server-side; routing
		// resume through `mutateCodexGoal` would skip that subscription
		// and the chat would go silent even though the agent is working.
		const handleResumeGoal = useCallback(() => {
			handleComposerSubmitInner("/goal resume", [], [], []);
		}, [handleComposerSubmitInner]);

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
				pendingPromptForSession.forceQueue ? "q" : "",
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
				forceQueue: pendingPromptForSession.forceQueue,
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
			// `z-20` lifts the entire composer stacking context above the thread
			// viewport's `z-10` root (`thread-viewport.tsx:99`). Without this the
			// slash/@ popup — which portals into the composer root — gets
			// occluded by chat messages when it opens upward past the composer's
			// top edge, because the composer's `isolate` traps popup z-index
			// inside a stacking context whose outer z defaults to `auto`.
			<div className="relative isolate z-20 flex flex-col">
				{isActionSession ? (
					<ActionRow
						className={cn(
							"relative z-0 mx-auto -mb-px w-[90%] rounded-t-2xl border-b-0",
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
								active={autoCloseEnabled}
								aria-label={
									autoCloseEnabled ? "Disable Auto Close" : "Enable Auto Close"
								}
								disabled={composerUnavailable}
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

				<div className="relative z-10">
					<div className="pointer-events-none absolute inset-x-0 bottom-[calc(100%-1px)] z-20 flex flex-col items-center gap-1.5">
						{displayedSessionId ? (
							<CodexGoalBanner
								sessionId={displayedSessionId}
								hasQueueBelow={queueItems.length > 0}
								disabled={composerUnavailable}
								onResume={handleResumeGoal}
							/>
						) : null}
						<SubmitQueueList
							items={queueItems}
							onSteer={(id) => onSteerQueued?.(id)}
							onRemove={(id) => onRemoveQueued?.(id)}
							disabled={composerUnavailable}
						/>
					</div>
					<WorkspaceComposer
						contextKey={composerContextKey}
						sessionId={displayedSessionId}
						providerSessionId={currentSession?.providerSessionId ?? null}
						agentType={
							effectiveModel?.provider === "codex" ? "codex" : "claude"
						}
						focusShortcut={focusShortcut}
						togglePlanShortcut={togglePlanShortcut}
						toggleFollowUpShortcut={toggleFollowUpShortcut}
						alwaysShowContextUsage={settings.alwaysShowContextUsage}
						onSubmit={handleComposerSubmit}
						disabled={composerUnavailable}
						submitDisabled={
							disabled || loadingConversationContext || composerAwaitingFinalize
						}
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
						showFastModePrelude={showFastModePrelude}
						onChangeFastMode={
							supportsFastMode ? handleChangeFastModeInner : undefined
						}
						sendError={sendError}
						restoreDraft={restoreDraft}
						restoreImages={restoreImages}
						restoreFiles={restoreFiles}
						restoreCustomTags={restoreCustomTags}
						restoreNonce={restoreNonce}
						persistDrafts={persistDrafts}
						pendingElicitation={pendingElicitation}
						onElicitationResponse={onElicitationResponse}
						elicitationResponsePending={elicitationResponsePending}
						pendingDeferredTool={pendingDeferredTool}
						onDeferredToolResponse={onDeferredToolResponse}
						goalReplace={
							goalReplaceConfirm && activeGoal
								? {
										currentObjective: activeGoal.objective,
										newObjective: goalReplaceConfirm.newObjective,
										onReplace: handleGoalReplaceConfirm,
										onCancel: handleGoalReplaceCancel,
									}
								: null
						}
						hasPlanReview={hasPlanReview}
						pendingInsertRequests={pendingInsertRequests}
						onPendingInsertRequestsConsumed={onPendingInsertRequestsConsumed}
						slashCommands={slashCommands}
						slashCommandsLoading={slashCommandsLoading}
						slashCommandsError={slashCommandsError}
						onRetrySlashCommands={refetchSlashCommands}
						workspaceRootPath={workingDirectory}
						linkedDirectories={linkedDirectories}
						onRemoveLinkedDirectory={handleRemoveLinkedDirectory}
						linkedDirectoriesDisabled={linkedDirectoriesMutation.isPending}
						addDirCandidates={candidateDirectories}
						onPickAddDir={handlePickAddDir}
					/>
				</div>
			</div>
		);
	},
);
