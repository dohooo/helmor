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
	createAndCheckoutBranch,
	getRepoCurrentBranch,
	listBranchesForLocalPicker,
	listRemoteBranches,
	moveLocalWorkspaceToWorktree,
	prewarmSlashCommandsForRepo,
	type RepositoryCreateOption,
	type WorkspaceMode,
} from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import type { AppSettings } from "@/lib/settings";
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
	startPendingNewBranch: string | null;
	startInboxProviderTab: string;
	startInboxProviderSourceTab: string;
	startInboxStateFilterBySource: Record<string, string>;
	startBranches: string[];
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
	const [startSourceBranchOverride, setStartSourceBranchOverride] = useState<
		string | null
	>(null);
	const [startPendingNewBranch, setStartPendingNewBranch] = useState<
		string | null
	>(null);
	const [startPendingLinkedDirectories, setStartPendingLinkedDirectories] =
		useState<readonly string[]>(EMPTY_STRING_LIST);
	const [startMode, setStartMode] = useState<WorkspaceMode>("worktree");

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

	// Default repo selection: prefer kanbanViewState.repoId, fall back to the
	// first repo. Re-runs when the kanban repo persists or the list refreshes.
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
				(repository) => repository.id === appSettings.kanbanViewState.repoId,
			) ?? null;
		setStartRepositoryId((savedRepository ?? repositories[0]).id);
	}, [
		appSettings.kanbanViewState.repoId,
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

	// Reset start scratch state on repo switch.
	useEffect(() => {
		setStartSourceBranchOverride(null);
		setStartPendingNewBranch(null);
		setStartPendingLinkedDirectories(EMPTY_STRING_LIST);
		setStartMode("worktree");
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
	const startSourceBranch =
		startSourceBranchOverride ??
		(startMode === "local"
			? (startLocalCurrentBranchQuery.data ??
				startRepository?.defaultBranch ??
				"main")
			: (startRepository?.defaultBranch ?? "main"));

	// Local mode shows local + remote branches (deduped). Worktree mode only
	// cares about remote refs (workspace branches off `origin/<x>`).
	const startBranchesQuery = useQuery({
		queryKey:
			startMode === "local"
				? ["localPickerBranches", startRepository?.id]
				: ["remoteBranches", "start", startRepository?.id],
		queryFn: () => {
			if (!startRepository) throw new Error("no repo");
			return startMode === "local"
				? listBranchesForLocalPicker(startRepository.id)
				: listRemoteBranches({ repoId: startRepository.id });
		},
		enabled: Boolean(startRepository?.id),
	});

	const selectRepository = useCallback(
		(repository: RepositoryCreateOption) => {
			setStartRepositoryId(repository.id);
			void updateSettings({
				kanbanViewState: {
					...appSettings.kanbanViewState,
					repoId: repository.id,
				},
			});
		},
		[appSettings.kanbanViewState, updateSettings],
	);

	const selectSourceBranch = useCallback(
		(branch: string) => {
			if (!startRepository) return;
			setStartSourceBranchOverride(branch);
			// Picking an existing branch from the dropdown clears any pending
			// "create new branch" selection so we don't try to create-and-
			// checkout on submit.
			setStartPendingNewBranch(null);
		},
		[startRepository],
	);

	const selectMode = useCallback((mode: WorkspaceMode) => {
		setStartMode(mode);
		setStartSourceBranchOverride(null);
		setStartPendingNewBranch(null);
	}, []);

	const stashPendingNewBranch = useCallback((branch: string) => {
		// Lazy: just remember the desired name. Actual `git checkout -b` runs
		// at submit time inside `prepareComposer`.
		setStartSourceBranchOverride(branch);
		setStartPendingNewBranch(branch);
	}, []);

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
				kanbanViewState: {
					...appSettings.kanbanViewState,
					repoId: repositoryId,
				},
			});
			openWorkspaceStartRef.current();
		},
		[appSettings.kanbanViewState, updateSettings],
	);

	const prepareComposer = useCallback(
		async (
			payload: ComposerSubmitPayload,
			options?: { startSubmitMode?: StartSubmitMode },
		): Promise<ComposerCreatePrepareOutcome> => {
			if (!startRepository?.id) {
				pushToastRef.current(
					"Pick a repository before sending.",
					"Can't create workspace",
				);
				return { shouldStream: false };
			}

			try {
				if (startPendingNewBranch) {
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
					repoId: startRepository.id,
					sourceBranch: startSourceBranch,
					mode: startMode,
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
				pushToastRef.current(
					describeUnknownError(error, "Could not create workspace."),
					"Can't create workspace",
				);
				return { shouldStream: false };
			}
		},
		[
			queryClient,
			startMode,
			startPendingLinkedDirectories,
			startPendingNewBranch,
			startRepository?.id,
			startSourceBranch,
		],
	);

	const startComposerContextKey = startRepository
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
		setStartSourceBranchOverride(null);
		setStartPendingNewBranch(null);
	}, []);

	const actions = useStableActions<StartSurfaceActions>({
		selectRepository,
		selectSourceBranch,
		selectMode,
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

const EMPTY_BRANCH_LIST: string[] = [];
