// Start-surface controller: every piece of state that lives only on the
// workspace-start page (selected repo, source branch, mode, lazy
// pending-new-branch / linked-directories, inbox-tab + state filters), plus
// the `prepareComposer` orchestration that runs when the user commits the
// start composer to create a workspace.
import { type QueryClient, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { StartSubmitMode } from "@/features/composer/start-submit-mode";
import type {
	ComposerCreatePrepareOutcome,
	ComposerSettingsController,
	ComposerSubmitPayload,
	PendingCreatedWorkspaceSubmit,
} from "@/features/conversation";
import {
	buildTitleSeed,
	seedSessionTitle,
} from "@/features/conversation/hooks/seed-session-title";
import { buildTerminalBootCommand } from "@/features/terminal/terminal-presets";
import { setPendingBoot } from "@/features/terminal/terminal-session-store";
import { createWorkspaceFromStartComposer } from "@/features/workspace-start/create-workspace";
import {
	type BranchPickerEntry,
	convertSessionToTerminal,
	createAndCheckoutBranch,
	getRepoCurrentBranch,
	listBranchesForWorkspacePicker,
	moveLocalWorkspaceToWorktree,
	prefetchRemoteRefs,
	prewarmSlashCommandsForRepo,
	type RepositoryCreateOption,
	renameSession,
	type ThreadMessageLike,
	type WorkspaceBranchIntent,
	type WorkspaceDetail,
	type WorkspaceMode,
} from "@/lib/api";
import { extractError } from "@/lib/errors";
import { translateSource } from "@/lib/i18n";
import { helmorQueryKeys } from "@/lib/query-client";
import { sessionThreadCacheKey } from "@/lib/session-thread-cache";
import {
	type AppSettings,
	readRepoPreference,
	START_SURFACE_BRANCH_INTENT_FALLBACK,
	START_SURFACE_MODE_FALLBACK,
	writeRepoPreference,
} from "@/lib/settings";
import { requestSidebarReconcile } from "@/lib/sidebar-mutation-gate";
import { describeUnknownError } from "@/lib/workspace-helpers";
import type { PushWorkspaceToast } from "@/lib/workspace-toast-context";
import { EMPTY_STRING_LIST } from "@/shell/constants";
import type { ShellViewMode } from "@/shell/controllers/use-selection-controller";
import { useShellEvent } from "@/shell/event-bus";
import {
	useLatestRef,
	useStableActions,
} from "@/shell/hooks/use-stable-actions";

export type StartSurfaceState = {
	startRepositoryId: string | null;
	startRepository: RepositoryCreateOption | null;
	startSourceBranch: string;
	startMode: WorkspaceMode;
	/** Worktree mode only; backend ignores in local mode. */
	startBranchIntent: WorkspaceBranchIntent;
	startPendingNewBranch: string | null;
	startInboxProviderTab: string;
	startInboxProviderSourceTab: string;
	startInboxStateFilterBySource: Record<string, string>;
	startBranches: BranchPickerEntry[];
	startBranchesLoading: boolean;
	startComposerContextKey: string;
	startComposerInsertTarget: { contextKey: string };
	startLinkedDirectoriesController: {
		directories: readonly string[];
		onChange: (next: readonly string[]) => void;
	};
	/** Persisted composer picks for the start surface, so model/effort/
	 *  permission/fast survive the start-subtree unmount on navigation. */
	startComposerSettingsController: ComposerSettingsController;
};

export type StartSurfaceActions = {
	selectRepository(repository: RepositoryCreateOption): void;
	selectSourceBranch(branch: string): void;
	selectMode(mode: WorkspaceMode): void;
	selectBranchIntent(intent: WorkspaceBranchIntent): void;
	stashPendingNewBranch(branch: string): void;
	refetchBranches(): void;
	setInboxProviderTab(tab: string): void;
	setInboxProviderSourceTab(tab: string): void;
	setInboxStateFilterBySource(value: Record<string, string>): void;
	moveLocalToWorktree(workspaceId: string): void;
	prepareComposer(
		payload: ComposerSubmitPayload,
		options?: { startSubmitMode?: StartSubmitMode },
	): Promise<ComposerCreatePrepareOutcome>;
	addRepositoryNeedsStart(repositoryId: string): void;
	// Drops the stashed branch override + pending new branch so the next
	// re-entry to the start surface begins clean.
	resetScratchOnReentry(): void;
};

export type StartSurfaceController = {
	state: StartSurfaceState;
	actions: StartSurfaceActions;
};

export type StartSurfaceControllerDeps = {
	queryClient: QueryClient;
	appSettings: AppSettings;
	areSettingsLoaded: boolean;
	updateSettings: (patch: Partial<AppSettings>) => void | Promise<void>;
	repositories: RepositoryCreateOption[];
	pushToast: PushWorkspaceToast;
	getViewMode(): ShellViewMode;
	/** Reactive view-mode used to clear the one-shot mode override on exit. */
	viewMode: ShellViewMode;
	openWorkspaceStart(): void;
	setViewMode(mode: ShellViewMode): void;
	selectWorkspace(workspaceId: string): void;
	selectSession(sessionId: string): void;
	setPendingCreatedWorkspaceSubmit(
		updater:
			| PendingCreatedWorkspaceSubmit
			| null
			| ((
					prev: PendingCreatedWorkspaceSubmit | null,
			  ) => PendingCreatedWorkspaceSubmit | null),
	): void;
};

export function useStartSurfaceController(
	deps: StartSurfaceControllerDeps,
): StartSurfaceController {
	const {
		queryClient,
		appSettings,
		areSettingsLoaded,
		updateSettings,
		repositories,
	} = deps;

	const [startRepositoryId, setStartRepositoryId] = useState<string | null>(
		null,
	);
	const [startInboxProviderTab, setStartInboxProviderTab] =
		useState<string>("github");
	const [startInboxProviderSourceTab, setStartInboxProviderSourceTab] =
		useState<string>("issues");
	const [startInboxStateFilterBySource, setStartInboxStateFilterBySource] =
		useState<Record<string, string>>({});
	const [startPendingNewBranch, setStartPendingNewBranch] = useState<
		string | null
	>(null);
	// Local-mode branch pick — transient (a pending checkout), kept out of the
	// persisted worktree `sourceBranchByRepoId` so it can't shadow live HEAD.
	const [startLocalBranchSelection, setStartLocalBranchSelection] = useState<
		string | null
	>(null);
	const [startPendingLinkedDirectories, setStartPendingLinkedDirectories] =
		useState<readonly string[]>(EMPTY_STRING_LIST);
	// One-shot mode override set by the `Cmd+N` / `Cmd+Shift+N` shortcuts
	// (carried via the `open-new-workspace` event's `mode` payload). Wins
	// over the persisted preference for the lifetime of the current visit
	// to the start surface. Cleared when the user (a) manually picks a
	// different mode in the composer, or (b) leaves the start surface — so
	// the next non-shortcut entry (e.g. sidebar "New workspace" button)
	// falls back to the persisted default.
	const [transientModeOverride, setTransientModeOverride] =
		useState<WorkspaceMode | null>(null);

	// Pickers read from settings; writes go through `updateSettings`.
	const prefs = appSettings.startSurfacePreferences;
	// Chat is a top-level toggle (independent of repo). When off, the start
	// surface falls back to the selected repo's stored work mode.
	const repoWorkMode = readRepoPreference(
		prefs.modeByRepoId,
		startRepositoryId,
		START_SURFACE_MODE_FALLBACK,
	);
	// No repos → lock to chat (worktree/local can't run without one);
	// the transient override is ignored in this case so `Cmd+N` falls back
	// to chat cleanly. Otherwise, transient (shortcut-driven) > persisted
	// prefs > per-repo work mode.
	const startMode: WorkspaceMode =
		repositories.length === 0
			? "chat"
			: (transientModeOverride ??
				(prefs.chatModeActive ? "chat" : repoWorkMode));
	const startBranchIntent = readRepoPreference(
		prefs.branchIntentByRepoId,
		startRepositoryId,
		START_SURFACE_BRANCH_INTENT_FALLBACK,
	);
	const startSourceBranchOverride = readRepoPreference(
		prefs.sourceBranchByRepoId,
		startRepositoryId,
		null,
	);

	// Latest cross-controller callbacks, kept in refs so AppShell can pass
	// inline arrows without thrashing every downstream useCallback.
	const getViewModeRef = useLatestRef(deps.getViewMode);
	const openWorkspaceStartRef = useLatestRef(deps.openWorkspaceStart);
	const setViewModeRef = useLatestRef(deps.setViewMode);
	const selectWorkspaceRef = useLatestRef(deps.selectWorkspace);
	const selectSessionRef = useLatestRef(deps.selectSession);
	const setPendingCreatedWorkspaceSubmitRef = useLatestRef(
		deps.setPendingCreatedWorkspaceSubmit,
	);
	const pushToastRef = useLatestRef(deps.pushToast);

	const startRepository =
		repositories.find((repository) => repository.id === startRepositoryId) ??
		repositories[0] ??
		null;

	// Default repo selection: prefer the persisted `repoId`, fall back to
	// the first repo. Re-runs when the persisted value resolves or the
	// repository list refreshes.
	useEffect(() => {
		if (!areSettingsLoaded || repositories.length === 0) return;
		if (
			startRepositoryId &&
			repositories.some((repository) => repository.id === startRepositoryId)
		) {
			return;
		}
		const savedRepository =
			repositories.find(
				(repository) =>
					repository.id === appSettings.startSurfacePreferences.repoId,
			) ?? null;
		setStartRepositoryId((savedRepository ?? repositories[0]).id);
	}, [
		appSettings.startSurfacePreferences.repoId,
		areSettingsLoaded,
		repositories,
		startRepositoryId,
	]);

	// Prewarm slash-commands so the next `/` press hits warm cache. Gated on
	// start view to avoid scheduling while in workspace mode.
	useEffect(() => {
		if (getViewModeRef.current() !== "start") return;
		if (!startRepository) return;
		void prewarmSlashCommandsForRepo(startRepository.id);
	}, [startRepository]);

	// Repo switch only clears transient state; persisted picker selections
	// are re-read from the new repo's slot automatically.
	useEffect(() => {
		setStartPendingNewBranch(null);
		setStartLocalBranchSelection(null);
		setStartPendingLinkedDirectories(EMPTY_STRING_LIST);
	}, [startRepositoryId]);

	// Drop the one-shot mode override whenever we leave the start surface.
	// Re-entry via a non-shortcut path (sidebar "New workspace" button,
	// boot rehydration, etc.) should honor the user's persisted default.
	useEffect(() => {
		if (deps.viewMode !== "start") {
			setTransientModeOverride(null);
		}
	}, [deps.viewMode]);

	// Payload `mode` forces the initial mode for this open only; no payload
	// clears any prior transient override so the per-repo remembered mode wins.
	useShellEvent("open-new-workspace", (event) => {
		setTransientModeOverride(event.mode ?? null);
	});

	// Live HEAD = local-mode default. Fetched eagerly (not gated on local mode)
	// so switching to local shows the real branch without flashing "main".
	const startLocalCurrentBranchQuery = useQuery({
		queryKey: ["repoCurrentBranch", startRepository?.id],
		queryFn: () => {
			if (!startRepository) throw new Error("no repo");
			return getRepoCurrentBranch(startRepository.id);
		},
		enabled: Boolean(startRepository?.id),
	});
	// Local: live HEAD wins (the worktree's persisted override must not leak in).
	// Worktree: pendingNewBranch > per-repo override > default.
	const startSourceBranch =
		startMode === "local"
			? (startPendingNewBranch ??
				startLocalBranchSelection ??
				startLocalCurrentBranchQuery.data ??
				startRepository?.defaultBranch ??
				"main")
			: (startPendingNewBranch ??
				startSourceBranchOverride ??
				startRepository?.defaultBranch ??
				"main");

	// Combined local + remote source — both modes use it. Each entry carries
	// `hasLocal` / `hasRemote` so the picker can render a single icon by
	// priority and the pill can decide whether to prefix with `origin/`.
	const startBranchesQuery = useQuery({
		queryKey: ["workspacePickerBranches", startRepository?.id],
		queryFn: () => {
			if (!startRepository) throw new Error("no repo");
			return listBranchesForWorkspacePicker(startRepository.id);
		},
		enabled: Boolean(startRepository?.id),
	});

	const selectRepository = useCallback(
		(repository: RepositoryCreateOption) => {
			setStartRepositoryId(repository.id);
			void updateSettings({
				startSurfacePreferences: {
					...appSettings.startSurfacePreferences,
					repoId: repository.id,
				},
			});
		},
		[appSettings.startSurfacePreferences, updateSettings],
	);

	const selectSourceBranch = useCallback(
		(branch: string) => {
			if (!startRepository) return;
			// Picking an existing branch drops any in-flight create-new stash.
			setStartPendingNewBranch(null);
			// Local mode: keep the pick transient so it can't shadow live HEAD
			// via the shared worktree `sourceBranchByRepoId`.
			if (startMode === "local") {
				setStartLocalBranchSelection(branch);
				return;
			}
			void updateSettings({
				startSurfacePreferences: {
					...appSettings.startSurfacePreferences,
					sourceBranchByRepoId: writeRepoPreference(
						appSettings.startSurfacePreferences.sourceBranchByRepoId,
						startRepository.id,
						branch,
					),
				},
			});
		},
		[
			appSettings.startSurfacePreferences,
			startMode,
			startRepository,
			updateSettings,
		],
	);

	const selectMode = useCallback(
		(mode: WorkspaceMode) => {
			// Manual pick supersedes any shortcut-driven override and gets
			// persisted via the normal `updateSettings` path below.
			setTransientModeOverride(null);
			// pendingNewBranch + local branch pick are local-only; clear on flip.
			setStartPendingNewBranch(null);
			setStartLocalBranchSelection(null);

			// Chat is the top-level toggle — flip just the boolean, don't
			// touch any repo-bound state. Works even with no repo selected
			// (chat doesn't need one).
			if (mode === "chat") {
				if (appSettings.startSurfacePreferences.chatModeActive) return;
				void updateSettings({
					startSurfacePreferences: {
						...appSettings.startSurfacePreferences,
						chatModeActive: true,
					},
				});
				return;
			}

			// Leaving chat back into a repo-bound mode requires a repo.
			if (!startRepository) return;
			void updateSettings({
				startSurfacePreferences: {
					...appSettings.startSurfacePreferences,
					chatModeActive: false,
					modeByRepoId: writeRepoPreference(
						appSettings.startSurfacePreferences.modeByRepoId,
						startRepository.id,
						mode,
					),
				},
			});
		},
		[appSettings.startSurfacePreferences, startRepository, updateSettings],
	);

	const selectBranchIntent = useCallback(
		(intent: WorkspaceBranchIntent) => {
			if (!startRepository) return;
			// use_branch + pendingNewBranch is a logical conflict; drop the pending.
			if (intent === "use_branch") {
				setStartPendingNewBranch(null);
			}
			void updateSettings({
				startSurfacePreferences: {
					...appSettings.startSurfacePreferences,
					branchIntentByRepoId: writeRepoPreference(
						appSettings.startSurfacePreferences.branchIntentByRepoId,
						startRepository.id,
						intent,
					),
				},
			});
		},
		[appSettings.startSurfacePreferences, startRepository, updateSettings],
	);

	const stashPendingNewBranch = useCallback(
		(branch: string) => {
			// Transient only — actual `git checkout -b` runs at submit time.
			// Don't persist to `sourceBranchByRepoId` (branch doesn't exist yet).
			setStartPendingNewBranch(branch);
			if (!startRepository) return;
			if (startBranchIntent !== "from_branch") {
				void updateSettings({
					startSurfacePreferences: {
						...appSettings.startSurfacePreferences,
						branchIntentByRepoId: writeRepoPreference(
							appSettings.startSurfacePreferences.branchIntentByRepoId,
							startRepository.id,
							"from_branch",
						),
					},
				});
			}
		},
		[
			appSettings.startSurfacePreferences,
			startBranchIntent,
			startRepository,
			updateSettings,
		],
	);

	const refetchBranches = useCallback(() => {
		// Show cached refs immediately, then sync the remote so freshly
		// pushed branches appear without a restart. Mirrors the header
		// target-branch picker; backend rate-limits the fetch to 10s.
		void startBranchesQuery.refetch();
		if (!startRepository) return;
		void prefetchRemoteRefs({ repoId: startRepository.id })
			.then((result) => {
				if (result.fetched) {
					void startBranchesQuery.refetch();
				}
			})
			.catch(() => {});
	}, [startBranchesQuery, startRepository]);

	const moveLocalToWorktree = useCallback(
		(workspaceId: string) => {
			void moveLocalWorkspaceToWorktree(workspaceId)
				.then(() => {
					requestSidebarReconcile(queryClient);
					void queryClient.invalidateQueries({
						queryKey: helmorQueryKeys.workspaceDetail(workspaceId),
					});
				})
				.catch((error) => {
					pushToastRef.current(
						describeUnknownError(
							error,
							translateSource("miscCouldNotMoveToWorktree"),
						),
						translateSource("miscMoveToWorktreeFailed"),
					);
				});
		},
		[queryClient],
	);

	const addRepositoryNeedsStart = useCallback(
		(repositoryId: string) => {
			setStartRepositoryId(repositoryId);
			void updateSettings({
				startSurfacePreferences: {
					...appSettings.startSurfacePreferences,
					repoId: repositoryId,
				},
			});
			openWorkspaceStartRef.current();
		},
		[appSettings.startSurfacePreferences, updateSettings],
	);

	const prepareComposer = useCallback(
		async (
			payload: ComposerSubmitPayload,
			options?: { startSubmitMode?: StartSubmitMode },
		): Promise<ComposerCreatePrepareOutcome> => {
			// Chat mode doesn't require a repo selection — every other
			// mode does.
			if (startMode !== "chat" && !startRepository?.id) {
				pushToastRef.current(
					translateSource("miscPickRepositoryBeforeSending"),
					translateSource("miscCantCreateWorkspace"),
				);
				return { shouldStream: false };
			}

			try {
				if (startMode !== "chat" && startPendingNewBranch && startRepository) {
					await createAndCheckoutBranch(
						startRepository.id,
						startPendingNewBranch,
					);
					setStartPendingNewBranch(null);
				}
				const {
					finalizePromise,
					outcome,
					workspaceId,
					sessionId,
					preparedWorkingDirectory,
				} = await createWorkspaceFromStartComposer({
					// Chat mode ignores repoId/sourceBranch — pass empty
					// strings so the function signature stays the same.
					repoId: startRepository?.id ?? "",
					sourceBranch: startMode === "chat" ? "" : startSourceBranch,
					mode: startMode,
					// Only worktree mode honors branchIntent.
					branchIntent:
						startMode === "worktree" ? startBranchIntent : undefined,
					submitMode: options?.startSubmitMode ?? "startNow",
					editorStateSnapshot: payload.editorStateSnapshot,
					composerConfig: {
						modelId: payload.model.id,
						effortLevel: payload.effortLevel,
						permissionMode: payload.permissionMode,
						fastMode: payload.fastMode,
					},
					linkedDirectories: startPendingLinkedDirectories,
					// Reuse the composer's provisional id so pre-submit
					// paste-cache files end up owned by this session.
					seedSessionId: payload.provisionalSessionId,
				});
				// Picks belonged to the in-flight create; clear regardless of
				// outcome so the next start-page session begins clean.
				setStartPendingLinkedDirectories(EMPTY_STRING_LIST);

				// Chat workspaces ship as `ready` from a single-phase prep,
				// so a real WorkspaceDetail isn't materialised until the
				// follow-up query roundtrips. Without something in the
				// detail cache, the inspector pane reads `mode === undefined`
				// → renders one frame → re-renders with `mode === "chat"`
				// → vanishes. Seed a minimal synthetic detail with the
				// fields the inspector gate checks; the real fetch
				// overwrites it shortly after.
				if (startMode === "chat") {
					const synthetic: WorkspaceDetail = {
						id: workspaceId,
						title: "New chat",
						repoId: "",
						repoName: "Chats",
						directoryName: "",
						state: "ready",
						hasUnread: false,
						workspaceUnread: 0,
						unreadSessionCount: 0,
						status: "in-progress",
						mode: "chat",
						sessionCount: 1,
						messageCount: 0,
						rootPath: preparedWorkingDirectory ?? null,
						activeSessionId: sessionId,
					};
					queryClient.setQueryData<WorkspaceDetail | null>(
						helmorQueryKeys.workspaceDetail(workspaceId),
						(existing) => existing ?? synthetic,
					);
					// Seed an empty thread so the panel's
					// `messagesQuery.data === undefined` gate doesn't suppress the
					// optimistic user bubble before the first DB fetch lands.
					queryClient.setQueryData<ThreadMessageLike[]>(
						sessionThreadCacheKey(sessionId),
						(existing) => existing ?? [],
					);
				}

				requestSidebarReconcile(queryClient);

				if (outcome.shouldStream) {
					// Terminal-Mode start sends: convert the pipeline's GUI session
					// into a Terminal session IN PLACE (no throwaway placeholder)
					// and stage its boot before anything selects it. The panel's
					// spawn is gated on workspace readiness, so the PTY still
					// waits for the worktree to finalize.
					let terminalConverted = false;
					if (payload.terminalMode) {
						try {
							await convertSessionToTerminal(sessionId, payload.model.provider);
							// Layer 1 of the two-layer title (same as GUI): show a
							// provisional title from the prompt immediately; the agent's
							// UserPromptSubmit hook later triggers the AI rename (layer 2).
							const titleSeed = buildTitleSeed(payload.prompt);
							seedSessionTitle(
								queryClient,
								sessionId,
								outcome.workspaceId,
								titleSeed,
							);
							void renameSession(sessionId, titleSeed).catch((error) => {
								console.warn("[start] failed to seed terminal title:", error);
							});
							const boot = buildTerminalBootCommand(payload.model.provider, {
								prompt: payload.prompt,
								modelId: payload.model.cliModel || null,
								effortLevel: payload.effortLevel || null,
								permissionMode: payload.permissionMode || null,
								addDirs: startPendingLinkedDirectories,
								fastMode: payload.fastMode,
							});
							if (boot) {
								setPendingBoot(sessionId, {
									bootCommand: boot,
									fastMode: payload.fastMode,
								});
							}
							terminalConverted = true;
						} catch (error) {
							// Fall back to a REAL chat send: the pending payload below
							// clears terminalMode, so the consumer streams a GUI turn
							// instead of skipping it (which would drop the prompt).
							console.error(
								"[start] terminal conversion failed; continuing as chat:",
								error,
							);
							pushToastRef.current(
								translateSource("miscTerminalSentAsChat"),
								translateSource("miscTerminalModeUnavailable"),
							);
						}
					}
					// Defer the view-switch state burst to the next animation frame
					// so the browser can paint the current frame (start page)
					// before reconciling the heavy conversation tree. Without this
					// the synchronous commit pumps WKWebView's paint pipeline so
					// hard that RAF stalls for 5–8 seconds, freezing every CSS /
					// Lottie animation on screen even though JS isn't blocked.
					const pendingId = crypto.randomUUID();
					setPendingCreatedWorkspaceSubmitRef.current({
						id: pendingId,
						workspaceId: outcome.workspaceId,
						sessionId: outcome.sessionId,
						// Pin the new workspace's repo (chat mode has none).
						repoId: startRepository?.id ?? null,
						// Local mode already has the cwd; worktree mode patches it
						// onto the payload below once finalize materialises the
						// worktree dir. Either way the payload is the single source
						// of truth.
						payload: {
							...payload,
							workingDirectory:
								preparedWorkingDirectory ?? payload.workingDirectory,
							// Only keep the terminal intent when the conversion really
							// happened — otherwise the consumer must stream a chat turn.
							terminalMode: terminalConverted,
						},
						finalized: false,
					});
					// WKWebView pauses rAF entirely while the webview is hidden or
					// occluded (`document.visibilityState === "hidden"` — e.g. the
					// quick panel dismissed right after submit, or a window on
					// another Space). Race a timer fallback so the view switch can
					// never be lost; when rAF is alive it wins and keeps the
					// paint-first behavior.
					let viewSwitchDone = false;
					const switchToConversation = () => {
						if (viewSwitchDone) return;
						viewSwitchDone = true;
						selectWorkspaceRef.current(outcome.workspaceId);
						selectSessionRef.current(outcome.sessionId);
						setViewModeRef.current("conversation");
					};
					requestAnimationFrame(switchToConversation);
					setTimeout(switchToConversation, 120);

					let finalizedWorkingDirectory: string | null =
						preparedWorkingDirectory;
					if (finalizePromise) {
						try {
							const finalized = await finalizePromise;
							finalizedWorkingDirectory = finalized.workingDirectory;
						} catch (error) {
							setPendingCreatedWorkspaceSubmitRef.current((current) =>
								current?.id === pendingId ? null : current,
							);
							pushToastRef.current(
								describeUnknownError(
									error,
									translateSource("miscWorkspaceSetupFailedDot"),
								),
								translateSource("miscWorkspaceSetupFailed"),
							);
							requestSidebarReconcile(queryClient);
							return { shouldStream: false };
						}
					}
					// Flip the gate: the worktree is materialised + DB row is now
					// in `ready` / `setup_pending`. The conversation effect picks
					// this up immediately — no need to wait for a React Query
					// refetch round-trip.
					setPendingCreatedWorkspaceSubmitRef.current((current) =>
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
					// `workspaceDetail` (initializing → ready) is refreshed by the
					// backend's `WorkspaceChanged` event from finalize, so the
					// Terminal panel's spawn gate opens without a manual tab switch.
					return { shouldStream: false };
				}

				selectWorkspaceRef.current(workspaceId);
				selectSessionRef.current(sessionId);
				setViewModeRef.current("conversation");
				return outcome;
			} catch (error) {
				const { code, message } = extractError(
					error,
					translateSource("miscCouldNotCreateWorkspace"),
				);
				const title =
					code === "BranchInUse"
						? translateSource("miscBranchAlreadyInUse")
						: code === "BranchNotFound"
							? translateSource("miscBranchNotFound")
							: translateSource("miscCantCreateWorkspace");
				pushToastRef.current(message, title);
				return { shouldStream: false };
			}
		},
		[
			queryClient,
			startBranchIntent,
			startMode,
			startPendingLinkedDirectories,
			startPendingNewBranch,
			startRepository?.id,
			startSourceBranch,
		],
	);

	const startComposerContextKey =
		startMode === "chat"
			? "start:chat"
			: startRepository
				? `start:repo:${startRepository.id}`
				: "start:no-repo";
	const startComposerInsertTarget = useMemo(
		() => ({ contextKey: startComposerContextKey }),
		[startComposerContextKey],
	);
	const startLinkedDirectoriesController = useMemo(
		() => ({
			directories: startPendingLinkedDirectories,
			onChange: (next: readonly string[]) => {
				setStartPendingLinkedDirectories(next);
			},
		}),
		[startPendingLinkedDirectories],
	);

	// Persisted composer picks for the start surface. Writes merge into
	// `startSurfacePreferences`; only `start:*` context keys are persisted so a
	// stray `session:*` key (e.g. from the fast-mode-unavailable subscription on
	// the start container) can't pollute the blob.
	const startComposerSettingsController = useMemo<ComposerSettingsController>(
		() => ({
			modelSelections: prefs.composerModelByContextKey,
			effortLevels: prefs.composerEffortByContextKey,
			permissionModes: prefs.composerPermissionModeByContextKey,
			fastModes: prefs.composerFastModeByContextKey,
			onSelectModel: (contextKey, modelId, provider) => {
				if (!contextKey.startsWith("start:")) return;
				void updateSettings({
					startSurfacePreferences: {
						...prefs,
						composerModelByContextKey: {
							...prefs.composerModelByContextKey,
							[contextKey]: { provider, modelId },
						},
					},
				});
			},
			onSelectEffort: (contextKey, level) => {
				if (!contextKey.startsWith("start:")) return;
				void updateSettings({
					startSurfacePreferences: {
						...prefs,
						composerEffortByContextKey: {
							...prefs.composerEffortByContextKey,
							[contextKey]: level,
						},
					},
				});
			},
			onChangePermissionMode: (contextKey, mode) => {
				if (!contextKey.startsWith("start:")) return;
				void updateSettings({
					startSurfacePreferences: {
						...prefs,
						composerPermissionModeByContextKey: {
							...prefs.composerPermissionModeByContextKey,
							[contextKey]: mode,
						},
					},
				});
			},
			onChangeFastMode: (contextKey, enabled) => {
				if (!contextKey.startsWith("start:")) return;
				void updateSettings({
					startSurfacePreferences: {
						...prefs,
						composerFastModeByContextKey: {
							...prefs.composerFastModeByContextKey,
							[contextKey]: enabled,
						},
					},
				});
			},
		}),
		[prefs, updateSettings],
	);

	const startBranches = startBranchesQuery.data ?? EMPTY_BRANCH_LIST;

	const resetScratchOnReentry = useCallback(() => {
		// Transient only — persisted picker selections survive re-entry.
		setStartPendingNewBranch(null);
		setStartLocalBranchSelection(null);
	}, []);

	const actions = useStableActions<StartSurfaceActions>({
		selectRepository,
		selectSourceBranch,
		selectMode,
		selectBranchIntent,
		stashPendingNewBranch,
		refetchBranches,
		setInboxProviderTab: setStartInboxProviderTab,
		setInboxProviderSourceTab: setStartInboxProviderSourceTab,
		setInboxStateFilterBySource: setStartInboxStateFilterBySource,
		moveLocalToWorktree,
		prepareComposer,
		addRepositoryNeedsStart,
		resetScratchOnReentry,
	});

	const state = useMemo<StartSurfaceState>(
		() => ({
			startRepositoryId,
			startRepository,
			startSourceBranch,
			startMode,
			startBranchIntent,
			startPendingNewBranch,
			startInboxProviderTab,
			startInboxProviderSourceTab,
			startInboxStateFilterBySource,
			startBranches,
			startBranchesLoading: startBranchesQuery.isFetching,
			startComposerContextKey,
			startComposerInsertTarget,
			startLinkedDirectoriesController,
			startComposerSettingsController,
		}),
		[
			startBranchIntent,
			startBranches,
			startBranchesQuery.isFetching,
			startComposerContextKey,
			startComposerInsertTarget,
			startComposerSettingsController,
			startInboxProviderSourceTab,
			startInboxProviderTab,
			startInboxStateFilterBySource,
			startLinkedDirectoriesController,
			startMode,
			startPendingNewBranch,
			startRepository,
			startRepositoryId,
			startSourceBranch,
		],
	);

	return { state, actions };
}

const EMPTY_BRANCH_LIST: BranchPickerEntry[] = [];
