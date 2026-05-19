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
	ComposerSubmitPayload,
	PendingCreatedWorkspaceSubmit,
} from "@/features/conversation";
import { createWorkspaceFromStartComposer } from "@/features/workspace-start/create-workspace";
import {
	type BranchPickerEntry,
	createAndCheckoutBranch,
	getRepoCurrentBranch,
	listBranchesForWorkspacePicker,
	moveLocalWorkspaceToWorktree,
	prewarmSlashCommandsForRepo,
	type RepositoryCreateOption,
	type WorkspaceBranchIntent,
	type WorkspaceDetail,
	type WorkspaceMode,
} from "@/lib/api";
import { extractError } from "@/lib/errors";
import { helmorQueryKeys } from "@/lib/query-client";
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
	const [startPendingLinkedDirectories, setStartPendingLinkedDirectories] =
		useState<readonly string[]>(EMPTY_STRING_LIST);

	// Pickers read from settings; writes go through `updateSettings`.
	const prefs = appSettings.startSurfacePreferences;
	const startMode = readRepoPreference(
		prefs.modeByRepoId,
		startRepositoryId,
		START_SURFACE_MODE_FALLBACK,
	);
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
		setStartPendingLinkedDirectories(EMPTY_STRING_LIST);
	}, [startRepositoryId]);

	// In local mode default to repo HEAD; worktree mode keeps stored default.
	const startLocalCurrentBranchQuery = useQuery({
		queryKey: ["repoCurrentBranch", startRepository?.id],
		queryFn: () => {
			if (!startRepository) throw new Error("no repo");
			return getRepoCurrentBranch(startRepository.id);
		},
		enabled: Boolean(startRepository?.id) && startMode === "local",
	});
	// pendingNewBranch (transient) > per-repo override > mode default.
	const startSourceBranch =
		startPendingNewBranch ??
		startSourceBranchOverride ??
		(startMode === "local"
			? (startLocalCurrentBranchQuery.data ??
				startRepository?.defaultBranch ??
				"main")
			: (startRepository?.defaultBranch ?? "main"));

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
		[appSettings.startSurfacePreferences, startRepository, updateSettings],
	);

	const selectMode = useCallback(
		(mode: WorkspaceMode) => {
			if (!startRepository) return;
			// pendingNewBranch is local-mode-only; clear it on any mode flip.
			setStartPendingNewBranch(null);
			void updateSettings({
				startSurfacePreferences: {
					...appSettings.startSurfacePreferences,
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
		void startBranchesQuery.refetch();
	}, [startBranchesQuery]);

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
							"Could not move workspace into a new worktree.",
						),
						"Move to worktree failed",
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
					"Pick a repository before sending.",
					"Can't create workspace",
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
				}

				requestSidebarReconcile(queryClient);

				if (outcome.shouldStream) {
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
						// Local mode already has the cwd; worktree mode patches it
						// onto the payload below once finalize materialises the
						// worktree dir. Either way the payload is the single source
						// of truth.
						payload: {
							...payload,
							workingDirectory:
								preparedWorkingDirectory ?? payload.workingDirectory,
						},
						finalized: false,
					});
					requestAnimationFrame(() => {
						selectWorkspaceRef.current(outcome.workspaceId);
						selectSessionRef.current(outcome.sessionId);
						setViewModeRef.current("conversation");
					});

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
								describeUnknownError(error, "Workspace setup failed."),
								"Workspace setup failed",
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
					return { shouldStream: false };
				}

				selectWorkspaceRef.current(workspaceId);
				selectSessionRef.current(sessionId);
				setViewModeRef.current("conversation");
				return outcome;
			} catch (error) {
				const { code, message } = extractError(
					error,
					"Could not create workspace.",
				);
				const title =
					code === "BranchInUse"
						? "Branch already in use"
						: code === "BranchNotFound"
							? "Branch not found"
							: "Can't create workspace";
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

	const startBranches = startBranchesQuery.data ?? EMPTY_BRANCH_LIST;

	const resetScratchOnReentry = useCallback(() => {
		// Transient only — persisted picker selections survive re-entry.
		setStartPendingNewBranch(null);
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
		}),
		[
			startBranchIntent,
			startBranches,
			startBranchesQuery.isFetching,
			startComposerContextKey,
			startComposerInsertTarget,
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
