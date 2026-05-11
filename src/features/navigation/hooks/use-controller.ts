import { useQuery, useQueryClient } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { closeAllTerminalsForWorkspace } from "@/features/inspector/terminal-store";
import {
	type AddRepositoryResponse,
	addRepositoryFromLocalPath,
	cloneRepositoryFromUrl,
	finalizeWorkspaceFromRepo,
	listenArchiveExecutionFailed,
	listenArchiveExecutionSucceeded,
	loadAddRepositoryDefaults,
	markWorkspaceUnread,
	permanentlyDeleteWorkspace,
	pinWorkspace,
	prepareArchiveWorkspace,
	prepareWorkspaceFromRepo,
	type RepositoryCreateOption,
	restoreWorkspace,
	setWorkspaceStatus,
	startArchiveWorkspace,
	unpinWorkspace,
	validateRestoreWorkspace,
	type WorkspaceDetail,
	type WorkspaceRow,
	type WorkspaceSessionSummary,
	type WorkspaceState,
	type WorkspaceStatus,
} from "@/lib/api";
import { extractError, isRecoverableByPurge } from "@/lib/errors";
import {
	archivedWorkspacesQueryOptions,
	helmorQueryKeys,
	repositoriesQueryOptions,
	sessionThreadMessagesQueryOptions,
	workspaceDetailQueryOptions,
	workspaceGitActionStatusQueryOptions,
	workspaceGroupsQueryOptions,
	workspaceSessionsQueryOptions,
} from "@/lib/query-client";
import { useSettings } from "@/lib/settings";
import {
	beginSidebarMutation as gateBeginSidebarMutation,
	endSidebarMutation as gateEndSidebarMutation,
	flushSidebarLists as gateFlushSidebarLists,
	isSidebarMutationInFlight,
} from "@/lib/sidebar-mutation-gate";
import {
	createOptimisticCreatingWorkspaceDetail,
	describeUnknownError,
	findInitialWorkspaceId,
	findReplacementWorkspaceIdAfterRemoval,
	hasWorkspaceId,
	insertRowByCreatedAtDesc,
	rowToWorkspaceSummary,
	summaryToArchivedRow,
	workspaceGroupIdFromStatus,
} from "@/lib/workspace-helpers";
import {
	type PendingArchiveEntry,
	type PendingCreationEntry,
	projectSidebarLists,
	shouldReconcilePendingArchive,
	shouldReconcilePendingCreation,
} from "../sidebar-projection";

type WorkspaceToastVariant = "default" | "destructive";

type WorkspaceToastFn = (
	description: string,
	title?: string,
	variant?: WorkspaceToastVariant,
	opts?: {
		action?: { label: string; onClick: () => void; destructive?: boolean };
		persistent?: boolean;
	},
) => void;

type UseWorkspacesSidebarControllerArgs = {
	selectedWorkspaceId: string | null;
	autoSelectEnabled?: boolean;
	onSelectWorkspace: (workspaceId: string | null) => void;
	onOpenNewWorkspace?: () => void;
	/**
	 * Called after a successful add-repo when the backend hands us a
	 * `selectedWorkspaceId: null` — newly added repo, or re-add with only
	 * archived workspaces. UI lands on the start page with this repo
	 * preselected.
	 */
	onAddRepositoryNeedsStart?: (repositoryId: string) => void;
	pushWorkspaceToast: WorkspaceToastFn;
};

const WORKSPACE_GROUPS_INITIAL_DATA = workspaceGroupsQueryOptions().initialData;

export function useWorkspacesSidebarController({
	selectedWorkspaceId,
	autoSelectEnabled = true,
	onSelectWorkspace,
	onOpenNewWorkspace,
	onAddRepositoryNeedsStart,
	pushWorkspaceToast,
}: UseWorkspacesSidebarControllerArgs) {
	const queryClient = useQueryClient();
	const { settings } = useSettings();
	const [addingRepository, setAddingRepository] = useState(false);
	const [isCloneDialogOpen, setIsCloneDialogOpen] = useState(false);
	const [cloneDefaultDirectory, setCloneDefaultDirectory] = useState<
		string | null
	>(null);
	const [creatingWorkspaceRepoId, setCreatingWorkspaceRepoId] = useState<
		string | null
	>(null);
	const [archivingWorkspaceIds, setArchivingWorkspaceIds] = useState<
		Set<string>
	>(() => new Set());
	const [pendingArchives, setPendingArchives] = useState<
		Map<string, PendingArchiveEntry>
	>(() => new Map());
	const [pendingCreations, setPendingCreations] = useState<
		Map<
			string,
			{
				entry: PendingCreationEntry;
				// Workspace id selected before the creation started — used
				// by the Phase 2 failure path to restore selection when the
				// user is still sitting on the failing workspace.
				previousSelection: string | null;
			}
		>
	>(() => new Map());
	// Live mirror of `selectedWorkspaceId` so async callbacks (Phase 2
	// finalize catch, archive/restore handlers, etc.) can read the
	// current selection rather than a stale closure snapshot.
	const selectedWorkspaceIdRef = useRef(selectedWorkspaceId);
	selectedWorkspaceIdRef.current = selectedWorkspaceId;

	const flushSidebarLists = useCallback(() => {
		gateFlushSidebarLists(queryClient);
	}, [queryClient]);

	const beginSidebarMutation = useCallback(() => {
		gateBeginSidebarMutation();
	}, []);

	const endSidebarMutation = useCallback(() => {
		gateEndSidebarMutation();
		if (!isSidebarMutationInFlight()) {
			flushSidebarLists();
		}
	}, [flushSidebarLists]);

	const groupsQuery = useQuery(workspaceGroupsQueryOptions());
	const archivedQuery = useQuery(archivedWorkspacesQueryOptions());
	const repositoriesQuery = useQuery(repositoriesQueryOptions());

	const baseGroups = groupsQuery.data ?? [];
	const baseArchivedSummaries = archivedQuery.data ?? [];
	const projectedSidebar = useMemo(
		() =>
			projectSidebarLists({
				baseGroups,
				baseArchivedSummaries,
				pendingArchives,
				pendingCreations: new Map(
					Array.from(pendingCreations.entries()).map(
						([workspaceId, pendingCreation]) => [
							workspaceId,
							pendingCreation.entry,
						],
					),
				),
			}),
		[baseArchivedSummaries, baseGroups, pendingArchives, pendingCreations],
	);
	const groups = projectedSidebar.groups;
	const archivedSummaries = useMemo(
		() =>
			projectedSidebar.archivedRows.map((row) => rowToWorkspaceSummary(row)),
		[projectedSidebar.archivedRows],
	);
	const archivedRows = useMemo(
		() => projectedSidebar.archivedRows,
		[projectedSidebar.archivedRows],
	);

	const updateArchivingWorkspaceId = useCallback(
		(workspaceId: string, active: boolean) => {
			setArchivingWorkspaceIds((current) => {
				const next = new Set(current);
				if (active) {
					next.add(workspaceId);
				} else {
					next.delete(workspaceId);
				}
				return next;
			});
		},
		[],
	);

	// Forward-ref into `handleDeleteWorkspace` so early callbacks
	// (e.g. `pushWorkspaceErrorToast`) can wire up the "Permanently Delete"
	// recovery action without creating a circular useCallback dependency.
	const handleDeleteWorkspaceRef = useRef<(workspaceId: string) => void>(
		() => {},
	);

	/**
	 * Destructive workspace toast that auto-upgrades to the "Permanently Delete"
	 * recovery action when the backend's error code indicates the workspace is
	 * orphaned (missing on disk / DB row gone / git worktree corrupt).
	 */
	const pushWorkspaceErrorToast = useCallback(
		(
			workspaceId: string,
			title: string,
			error: unknown,
			fallbackMessage: string,
		) => {
			const { code, message } = extractError(error, fallbackMessage);
			if (isRecoverableByPurge(code)) {
				pushWorkspaceToast(message, title, "destructive", {
					persistent: true,
					action: {
						label: "Permanently Delete",
						destructive: true,
						onClick: () => handleDeleteWorkspaceRef.current(workspaceId),
					},
				});
				return;
			}
			pushWorkspaceToast(message, title, "destructive");
		},
		[pushWorkspaceToast],
	);

	// Forward-ref so the rollback can call into the recovery toast helper that
	// is defined below (they form a cycle: the helper depends on
	// `handleDeleteWorkspace`, which is defined later still).
	const pushPermanentDeleteRecoveryToastRef = useRef<
		(
			workspaceId: string,
			title: string,
			error: unknown,
			fallbackMessage: string,
		) => void
	>(() => {});

	const rollbackArchivedWorkspace = useCallback(
		(workspaceId: string, error: unknown, fallbackMessage: string) => {
			updateArchivingWorkspaceId(workspaceId, false);
			let rollback: PendingArchiveEntry | null = null;
			setPendingArchives((current) => {
				const existing = current.get(workspaceId) ?? null;
				if (!existing) {
					return current;
				}
				rollback = existing;
				const next = new Map(current);
				next.delete(workspaceId);
				return next;
			});

			if (!rollback) {
				flushSidebarLists();
			}

			// Always offer the permanent-delete escape hatch on archive failure —
			// matches the restore-failure path. The user already chose to drop
			// this workspace; if cleanup hits a snag (e.g. trash-dir collision,
			// stale worktree) they need a way out without restarting the app.
			pushPermanentDeleteRecoveryToastRef.current(
				workspaceId,
				"Archive failed",
				error,
				fallbackMessage,
			);
		},
		[flushSidebarLists, updateArchivingWorkspaceId],
	);

	useEffect(() => {
		let disposed = false;
		let unlistenFailure: (() => void) | undefined;
		let unlistenSuccess: (() => void) | undefined;

		void listenArchiveExecutionFailed((payload) => {
			if (disposed) {
				return;
			}
			rollbackArchivedWorkspace(
				payload.workspaceId,
				payload,
				"Unable to archive workspace.",
			);
		}).then((cleanup) => {
			if (disposed) {
				cleanup();
				return;
			}
			unlistenFailure = cleanup;
		});

		void listenArchiveExecutionSucceeded((payload) => {
			if (disposed) {
				return;
			}
			setPendingArchives((current) => {
				const existing = current.get(payload.workspaceId);
				if (!existing || existing.stage === "confirmed") {
					return current;
				}
				const next = new Map(current);
				next.set(payload.workspaceId, {
					...existing,
					stage: "confirmed",
				});
				return next;
			});
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.workspaceGroups,
			});
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.archivedWorkspaces,
			});
		}).then((cleanup) => {
			if (disposed) {
				cleanup();
				return;
			}
			unlistenSuccess = cleanup;
		});

		return () => {
			disposed = true;
			unlistenFailure?.();
			unlistenSuccess?.();
		};
	}, [queryClient, rollbackArchivedWorkspace]);

	useEffect(() => {
		if (pendingArchives.size === 0) {
			return;
		}

		const resolvedIds: string[] = [];
		for (const [workspaceId, pendingArchive] of pendingArchives) {
			if (
				pendingArchive.stage === "confirmed" &&
				shouldReconcilePendingArchive(
					workspaceId,
					baseGroups,
					baseArchivedSummaries,
				)
			) {
				resolvedIds.push(workspaceId);
			}
		}

		if (resolvedIds.length === 0) {
			return;
		}

		setPendingArchives((current) => {
			let changed = false;
			const next = new Map(current);
			for (const workspaceId of resolvedIds) {
				changed = next.delete(workspaceId) || changed;
			}
			return changed ? next : current;
		});
	}, [baseArchivedSummaries, baseGroups, pendingArchives]);

	useEffect(() => {
		if (pendingCreations.size === 0) {
			return;
		}

		const resolvedIds: string[] = [];
		for (const [workspaceId, pendingCreation] of pendingCreations) {
			if (shouldReconcilePendingCreation(pendingCreation.entry, baseGroups)) {
				resolvedIds.push(workspaceId);
			}
		}

		if (resolvedIds.length === 0) {
			return;
		}

		setPendingCreations((current) => {
			let changed = false;
			const next = new Map(current);
			for (const workspaceId of resolvedIds) {
				changed = next.delete(workspaceId) || changed;
			}
			return changed ? next : current;
		});
	}, [baseGroups, pendingCreations]);

	useEffect(() => {
		if (!autoSelectEnabled) {
			return;
		}

		if (
			selectedWorkspaceId === null &&
			groupsQuery.data === undefined &&
			archivedQuery.data === undefined
		) {
			return;
		}

		if (
			selectedWorkspaceId === null &&
			groupsQuery.isFetching &&
			groupsQuery.data === WORKSPACE_GROUPS_INITIAL_DATA
		) {
			return;
		}

		// A freshly-created workspace lands here BEFORE `groupsQuery`
		// refetches it from the backend, so `hasWorkspaceId` returns false
		// and the fallback below would otherwise jump us to whatever sits
		// in `archivedSummaries[0]` — clobbering the user's brand-new
		// workspace selection. Hold off until the refetch settles.
		if (
			selectedWorkspaceId &&
			!hasWorkspaceId(selectedWorkspaceId, groups, archivedSummaries) &&
			groupsQuery.isFetching
		) {
			return;
		}

		// Only restore archived workspaces if they were the live selection
		// (runtime state). Never auto-restore archived from persisted
		// `lastWorkspaceId` — the directory may be gone, which would spam
		// git/editor errors on every poll. Fall through to an active group.
		const isInActiveGroups = (id: string) =>
			groups.some((group) => group.rows.some((row) => row.id === id));

		let nextWorkspaceId: string | null;
		if (
			selectedWorkspaceId &&
			hasWorkspaceId(selectedWorkspaceId, groups, archivedSummaries)
		) {
			nextWorkspaceId = selectedWorkspaceId;
		} else if (
			settings.lastWorkspaceId &&
			isInActiveGroups(settings.lastWorkspaceId)
		) {
			nextWorkspaceId = settings.lastWorkspaceId;
		} else {
			nextWorkspaceId =
				findInitialWorkspaceId(groups) ?? archivedSummaries[0]?.id ?? null;
		}

		if (nextWorkspaceId !== selectedWorkspaceId) {
			onSelectWorkspace(nextWorkspaceId);
		}
	}, [
		autoSelectEnabled,
		archivedQuery.data,
		archivedSummaries,
		groups,
		groupsQuery.data,
		groupsQuery.isFetching,
		onSelectWorkspace,
		selectedWorkspaceId,
		settings.lastWorkspaceId,
	]);

	const prefetchWorkspace = useCallback(
		(workspaceId: string) => {
			void (async () => {
				// Kick off the git-status prefetch immediately — it's the single
				// data source that gates the sidebar hover card and runs `git
				// status` synchronously, which can take 100–500ms. Starting it
				// in parallel with the detail/session prefetch means by the
				// time the HoverCard's openDelay (~400ms) elapses, the data is
				// usually already cached.
				void queryClient.prefetchQuery(
					workspaceGitActionStatusQueryOptions(workspaceId),
				);
				const [workspaceDetail, workspaceSessions] = await Promise.all([
					queryClient.ensureQueryData(workspaceDetailQueryOptions(workspaceId)),
					queryClient.ensureQueryData(
						workspaceSessionsQueryOptions(workspaceId),
					),
				]);
				const sessionId =
					workspaceDetail?.activeSessionId ??
					workspaceSessions.find((session) => session.active)?.id ??
					workspaceSessions[0]?.id ??
					null;

				if (sessionId) {
					await queryClient.prefetchQuery(
						sessionThreadMessagesQueryOptions(sessionId),
					);
				}
			})();
		},
		[queryClient],
	);

	const refetchNavigation = useCallback(async () => {
		await Promise.all([
			queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.workspaceGroups,
			}),
			queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.archivedWorkspaces,
			}),
			queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.repositories,
			}),
		]);

		const [loadedGroups, loadedArchived] = await Promise.all([
			queryClient.fetchQuery(workspaceGroupsQueryOptions()),
			queryClient.fetchQuery(archivedWorkspacesQueryOptions()),
		]);

		return {
			loadedGroups,
			loadedArchived,
		};
	}, [queryClient]);

	const invalidateWorkspaceSummary = useCallback(
		async (workspaceId: string, opts?: { skipSidebarFlush?: boolean }) => {
			await Promise.all([
				queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.workspaceDetail(workspaceId),
				}),
				queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.workspaceSessions(workspaceId),
				}),
			]);
			if (!opts?.skipSidebarFlush && !isSidebarMutationInFlight()) {
				flushSidebarLists();
			}
		},
		[flushSidebarLists, queryClient],
	);

	const handleSelectWorkspace = useCallback(
		(workspaceId: string) => {
			onSelectWorkspace(workspaceId);
		},
		[onSelectWorkspace],
	);

	const handleMarkWorkspaceUnread = useCallback(
		(workspaceId: string) => {
			const previousGroups = queryClient.getQueryData(
				helmorQueryKeys.workspaceGroups,
			);
			const previousArchived = queryClient.getQueryData(
				helmorQueryKeys.archivedWorkspaces,
			);
			const previousDetail = queryClient.getQueryData(
				helmorQueryKeys.workspaceDetail(workspaceId),
			);

			// Optimistic flash of the red dot. The backend sets
			// `workspaces.unread = 1` directly without touching sessions, so
			// mirror that here: flip `workspaceUnread` + `hasUnread`, leave
			// `unreadSessionCount` alone. The post-IPC invalidation backfills.
			queryClient.setQueryData(helmorQueryKeys.workspaceGroups, (current) =>
				Array.isArray(current)
					? (current as typeof groups).map((group) => ({
							...group,
							rows: group.rows.map((row) =>
								row.id === workspaceId
									? { ...row, hasUnread: true, workspaceUnread: 1 }
									: row,
							),
						}))
					: current,
			);
			queryClient.setQueryData(helmorQueryKeys.archivedWorkspaces, (current) =>
				Array.isArray(current)
					? (current as typeof archivedSummaries).map((summary) =>
							summary.id === workspaceId
								? { ...summary, hasUnread: true, workspaceUnread: 1 }
								: summary,
						)
					: current,
			);
			queryClient.setQueryData(
				helmorQueryKeys.workspaceDetail(workspaceId),
				(current) =>
					current
						? {
								...(current as Record<string, unknown>),
								hasUnread: true,
								workspaceUnread: 1,
							}
						: current,
			);

			void markWorkspaceUnread(workspaceId)
				.then(() =>
					invalidateWorkspaceSummary(workspaceId, {
						skipSidebarFlush: true,
					}),
				)
				.catch((error) => {
					queryClient.setQueryData(
						helmorQueryKeys.workspaceGroups,
						previousGroups,
					);
					queryClient.setQueryData(
						helmorQueryKeys.archivedWorkspaces,
						previousArchived,
					);
					queryClient.setQueryData(
						helmorQueryKeys.workspaceDetail(workspaceId),
						previousDetail,
					);
					pushWorkspaceToast(
						describeUnknownError(error, "Unable to mark workspace as unread."),
					);
				});
		},
		[invalidateWorkspaceSummary, pushWorkspaceToast, queryClient],
	);

	const handleTogglePin = useCallback(
		async (workspaceId: string, currentlyPinned: boolean) => {
			queryClient.setQueryData(helmorQueryKeys.workspaceGroups, (current) => {
				if (!Array.isArray(current)) {
					return current;
				}
				const groupsCopy = current as typeof groups;

				type Row = (typeof groups)[number]["rows"][number];
				let foundRow: Row | null = null;
				const withoutRow = groupsCopy.map((group) => {
					const index = group.rows.findIndex((row) => row.id === workspaceId);
					if (index === -1) {
						return group;
					}
					foundRow = group.rows[index];
					return {
						...group,
						rows: [
							...group.rows.slice(0, index),
							...group.rows.slice(index + 1),
						],
					};
				});

				if (!foundRow) {
					return current;
				}
				const row = foundRow as Row;
				const updatedRow: Row = {
					...row,
					pinnedAt: currentlyPinned ? null : new Date().toISOString(),
				};

				const targetGroupId = workspaceGroupIdFromStatus(
					updatedRow.status,
					updatedRow.pinnedAt,
				);

				return withoutRow.map((group) =>
					group.id === targetGroupId
						? { ...group, rows: [updatedRow, ...group.rows] }
						: group,
				);
			});

			try {
				if (currentlyPinned) {
					await unpinWorkspace(workspaceId);
				} else {
					await pinWorkspace(workspaceId);
				}
				await invalidateWorkspaceSummary(workspaceId);
			} catch (error) {
				void queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.workspaceGroups,
				});
				pushWorkspaceToast(
					describeUnknownError(error, "Unable to update pin state."),
				);
			}
		},
		[invalidateWorkspaceSummary, pushWorkspaceToast, queryClient],
	);

	const handleSetWorkspaceStatus = useCallback(
		async (workspaceId: string, status: WorkspaceStatus) => {
			try {
				await setWorkspaceStatus(workspaceId, status);
				flushSidebarLists();
			} catch (error) {
				pushWorkspaceToast(
					describeUnknownError(error, "Unable to set status."),
				);
			}
		},
		[flushSidebarLists, pushWorkspaceToast],
	);

	const handleCreateWorkspaceFromRepo = useCallback(
		async (repoId: string) => {
			if (creatingWorkspaceRepoId) {
				return;
			}

			const repository = (repositoriesQuery.data ?? []).find(
				(item) => item.id === repoId,
			);
			if (!repository) {
				pushWorkspaceToast(
					"Unable to resolve repository for workspace creation.",
				);
				return;
			}

			const previousSelection = selectedWorkspaceId;
			setCreatingWorkspaceRepoId(repoId);

			let prepareResponse: Awaited<ReturnType<typeof prepareWorkspaceFromRepo>>;
			try {
				// Phase 1 — fast backend prep (<20ms). Blocks until we have
				// the real workspace/session ids, directory name, branch,
				// and repo scripts. Nothing is painted yet; the sidebar +
				// panel are still showing the previously selected workspace.
				prepareResponse = await prepareWorkspaceFromRepo(repoId);
			} catch (error) {
				setCreatingWorkspaceRepoId(null);
				pushWorkspaceToast(
					describeUnknownError(error, "Unable to create workspace."),
				);
				return;
			}

			// Phase 1 succeeded. Paint immediately using the real metadata —
			// no optimistic title, no optimistic scripts, no placeholder.
			const createdAt = new Date().toISOString();
			const preparedRow = createPreparedWorkspaceRow(
				repository,
				prepareResponse,
			);
			const preparedSession = createOptimisticWorkspaceSession(
				prepareResponse.workspaceId,
				prepareResponse.initialSessionId,
				createdAt,
			);
			setPendingCreations((current) => {
				const next = new Map(current);
				next.set(prepareResponse.workspaceId, {
					entry: {
						repoId,
						row: preparedRow,
						stage: "creating",
						resolvedWorkspaceId: prepareResponse.workspaceId,
					},
					previousSelection,
				});
				return next;
			});
			queryClient.setQueryData<WorkspaceDetail | null>(
				helmorQueryKeys.workspaceDetail(prepareResponse.workspaceId),
				{
					...createOptimisticCreatingWorkspaceDetail(
						preparedRow,
						repoId,
						prepareResponse.initialSessionId,
					),
					// Populate branch/remote fields from Phase 1's real
					// values — the helper defaults these to null, but the
					// inspector computes `workspaceTargetBranch` from them
					// (`${remote}/${intendedTargetBranch || defaultBranch}`)
					// and the ChangesSection flips `branchSwitching=true`
					// whenever `workspaceTargetBranch` changes within the
					// same workspace. Leaving these null during Phase 1
					// means the value flips `null → "origin/main"` when the
					// real detail lands, briefly flashing the "Remote"
					// BranchDiffSection header. Fresh workspace points at
					// `defaultBranch` for both initialization parent and
					// intended target, matching what Phase 2 writes.
					remote: repository.remote ?? "origin",
					defaultBranch: prepareResponse.defaultBranch,
					initializationParentBranch: prepareResponse.defaultBranch,
					intendedTargetBranch: prepareResponse.defaultBranch,
				},
			);
			queryClient.setQueryData<WorkspaceSessionSummary[]>(
				helmorQueryKeys.workspaceSessions(prepareResponse.workspaceId),
				[preparedSession],
			);
			// Empty thread array — the panel renders the final "nothing here
			// yet" state from the first frame instead of falling through to
			// the cold placeholder.
			queryClient.setQueryData(
				[
					...helmorQueryKeys.sessionMessages(prepareResponse.initialSessionId),
					"thread",
				],
				[],
			);
			// Real repo scripts delivered by Phase 1 — the EmptyState shows
			// the correct "missing script" button count immediately.
			queryClient.setQueryData(
				helmorQueryKeys.repoScripts(repoId, prepareResponse.workspaceId),
				prepareResponse.repoScripts,
			);
			// Seed git + PR statuses so the inspector's Actions section
			// paints its final "fresh workspace" empty rows from the first
			// frame — otherwise the query is in-flight, `data` is undefined
			// and the UI falls back to `EMPTY_*_STATUS` which shows the
			// misleading "Sync status unavailable" / "Waiting for PR review"
			// placeholders until the short-circuited backend responds a few
			// ms later. Values mirror the Rust short-circuits in
			// `get_workspace_git_action_status` and
			// `get_workspace_forge_action_status` — keep them in sync.
			queryClient.setQueryData(
				helmorQueryKeys.workspaceGitActionStatus(prepareResponse.workspaceId),
				{
					uncommittedCount: 0,
					conflictCount: 0,
					syncTargetBranch: prepareResponse.defaultBranch,
					syncStatus: "upToDate",
					behindTargetCount: 0,
					remoteTrackingRef: null,
					aheadOfRemoteCount: 0,
					pushStatus: "unpublished",
				},
			);
			queryClient.setQueryData(
				helmorQueryKeys.workspaceChangeRequest(prepareResponse.workspaceId),
				null,
			);
			queryClient.setQueryData(
				helmorQueryKeys.workspaceForgeActionStatus(prepareResponse.workspaceId),
				{
					changeRequest: null,
					reviewDecision: null,
					mergeable: null,
					deployments: [],
					checks: [],
					remoteState: "noPr",
					message: null,
				},
			);
			onSelectWorkspace(prepareResponse.workspaceId);

			// Phase 2 — slow git worktree creation (~200ms-2s). Runs in the
			// background so the UI is already interactive. State flips from
			// "initializing" → "ready"/"setup_pending" when it completes;
			// the only visible change is the composer enabling.
			finalizeWorkspaceFromRepo(prepareResponse.workspaceId)
				.then((finalized) => {
					queryClient.setQueryData<WorkspaceDetail | null>(
						helmorQueryKeys.workspaceDetail(prepareResponse.workspaceId),
						(current) =>
							current ? { ...current, state: finalized.finalState } : current,
					);
					setPendingCreations((current) => {
						const pending = current.get(prepareResponse.workspaceId);
						if (!pending) {
							return current;
						}
						const next = new Map(current);
						next.set(prepareResponse.workspaceId, {
							...pending,
							entry: {
								...pending.entry,
								row: { ...pending.entry.row, state: finalized.finalState },
								stage: "confirmed",
							},
						});
						return next;
					});
					void queryClient.invalidateQueries({
						queryKey: helmorQueryKeys.workspaceDetail(
							prepareResponse.workspaceId,
						),
					});
					// Phase 1 probed helmor.json at the source repo root, which
					// matches the worktree for a fresh clone. If the user had
					// uncommitted local edits to helmor.json the two can
					// diverge — invalidate so the canonical worktree-side
					// probe runs once the dir exists.
					void queryClient.invalidateQueries({
						queryKey: helmorQueryKeys.repoScripts(
							repoId,
							prepareResponse.workspaceId,
						),
					});
					// Same story for git status — we seeded 0/0/UpToDate
					// during Phase 1, but once the worktree is on disk the
					// canonical git query returns the real tree state (still
					// 0/0 in practice for a fresh clone, but invalidate so
					// any divergence — e.g. a setup script that edited
					// files — shows up promptly).
					void queryClient.invalidateQueries({
						queryKey: helmorQueryKeys.workspaceGitActionStatus(
							prepareResponse.workspaceId,
						),
					});
					prefetchWorkspace(prepareResponse.workspaceId);
					void refetchNavigation();
				})
				.catch((error) => {
					// Rust already cleaned up the DB row + worktree. Tear
					// down the frontend mirror so the sidebar doesn't show
					// a ghost "initializing" workspace.
					setPendingCreations((current) => {
						if (!current.has(prepareResponse.workspaceId)) {
							return current;
						}
						const next = new Map(current);
						next.delete(prepareResponse.workspaceId);
						return next;
					});
					queryClient.removeQueries({
						queryKey: helmorQueryKeys.workspaceDetail(
							prepareResponse.workspaceId,
						),
						exact: true,
					});
					queryClient.removeQueries({
						queryKey: helmorQueryKeys.workspaceSessions(
							prepareResponse.workspaceId,
						),
						exact: true,
					});
					queryClient.removeQueries({
						queryKey: [
							...helmorQueryKeys.sessionMessages(
								prepareResponse.initialSessionId,
							),
							"thread",
						],
						exact: true,
					});
					queryClient.removeQueries({
						queryKey: helmorQueryKeys.repoScripts(
							repoId,
							prepareResponse.workspaceId,
						),
						exact: true,
					});
					queryClient.removeQueries({
						queryKey: helmorQueryKeys.workspaceGitActionStatus(
							prepareResponse.workspaceId,
						),
						exact: true,
					});
					queryClient.removeQueries({
						queryKey: helmorQueryKeys.workspaceChangeRequest(
							prepareResponse.workspaceId,
						),
						exact: true,
					});
					queryClient.removeQueries({
						queryKey: helmorQueryKeys.workspaceForge(
							prepareResponse.workspaceId,
						),
						exact: true,
					});
					queryClient.removeQueries({
						queryKey: helmorQueryKeys.workspaceForgeActionStatus(
							prepareResponse.workspaceId,
						),
						exact: true,
					});
					// Read current selection via ref — the closure's
					// `selectedWorkspaceId` is the value from when the user
					// clicked create, which is before `onSelectWorkspace`
					// landed the new id, so comparing against the captured
					// value would always miss.
					if (selectedWorkspaceIdRef.current === prepareResponse.workspaceId) {
						onSelectWorkspace(
							previousSelection ?? findInitialWorkspaceId(groups),
						);
					}
					pushWorkspaceToast(
						describeUnknownError(error, "Unable to create workspace."),
					);
					void refetchNavigation();
				})
				.finally(() => {
					setCreatingWorkspaceRepoId(null);
				});
		},
		[
			creatingWorkspaceRepoId,
			groups,
			onSelectWorkspace,
			prefetchWorkspace,
			pushWorkspaceToast,
			queryClient,
			repositoriesQuery.data,
			refetchNavigation,
			selectedWorkspaceId,
		],
	);

	const applyAddRepositoryResponse = useCallback(
		async (response: AddRepositoryResponse) => {
			await refetchNavigation();
			if (response.selectedWorkspaceId) {
				// Re-add of an existing repo with a visible workspace —
				// jump straight to it, same as before.
				prefetchWorkspace(response.selectedWorkspaceId);
				onSelectWorkspace(response.selectedWorkspaceId);
				if (!response.createdRepository) {
					pushWorkspaceToast(
						"Switched to the existing workspace.",
						"Repository already added",
						"default",
					);
				}
				return;
			}
			// No visible workspace to focus → land on the start page with
			// the new repo selected so the user picks branch + mode.
			onAddRepositoryNeedsStart?.(response.repositoryId);
			if (!response.createdRepository) {
				pushWorkspaceToast(
					"Repository already added — opened the start page so you can spin up a workspace.",
					"Repository already added",
					"default",
				);
			}
		},
		[
			onAddRepositoryNeedsStart,
			onSelectWorkspace,
			prefetchWorkspace,
			pushWorkspaceToast,
			refetchNavigation,
		],
	);

	const handleAddRepository = useCallback(async () => {
		if (addingRepository) {
			return;
		}

		setAddingRepository(true);

		try {
			const defaults = await loadAddRepositoryDefaults();
			setCloneDefaultDirectory(defaults.lastCloneDirectory ?? null);
			const selection = await open({
				directory: true,
				multiple: false,
				defaultPath: defaults.lastCloneDirectory ?? undefined,
			});
			const selectedPath = Array.isArray(selection) ? selection[0] : selection;

			if (!selectedPath) {
				return;
			}

			const response = await addRepositoryFromLocalPath(selectedPath);
			await applyAddRepositoryResponse(response);
		} catch (error) {
			pushWorkspaceToast(
				describeUnknownError(error, "Unable to add repository."),
			);
		} finally {
			setAddingRepository(false);
		}
	}, [addingRepository, applyAddRepositoryResponse, pushWorkspaceToast]);

	const handleOpenCloneDialog = useCallback(() => {
		setIsCloneDialogOpen(true);
		// Lazy-load the last-used clone directory so the dialog pre-fills it.
		// Errors here are non-fatal — the dialog still works without a default.
		void loadAddRepositoryDefaults()
			.then((defaults) => {
				setCloneDefaultDirectory(defaults.lastCloneDirectory ?? null);
			})
			.catch(() => {
				/* swallow: dialog will just have an empty default */
			});
	}, []);

	const handleCloneFromUrl = useCallback(
		async (args: { gitUrl: string; cloneDirectory: string }) => {
			const response = await cloneRepositoryFromUrl(args);
			await applyAddRepositoryResponse(response);
			setCloneDefaultDirectory(args.cloneDirectory);
		},
		[applyAddRepositoryResponse],
	);

	const handleDeleteWorkspace = useCallback(
		(workspaceId: string) => {
			// Tear down any live terminal shells in this workspace so they
			// don't keep running in the background after the workspace is
			// gone from the UI.
			closeAllTerminalsForWorkspace(workspaceId);
			const wasSelected = selectedWorkspaceId === workspaceId;
			setPendingArchives((current) => {
				if (!current.has(workspaceId)) {
					return current;
				}
				const next = new Map(current);
				next.delete(workspaceId);
				return next;
			});
			const previousGroups = queryClient.getQueryData(
				helmorQueryKeys.workspaceGroups,
			);
			const previousArchived = queryClient.getQueryData(
				helmorQueryKeys.archivedWorkspaces,
			);

			queryClient.setQueryData(helmorQueryKeys.workspaceGroups, (current) =>
				Array.isArray(current)
					? (current as typeof groups).map((group) => ({
							...group,
							rows: group.rows.filter((row) => row.id !== workspaceId),
						}))
					: current,
			);
			queryClient.setQueryData(helmorQueryKeys.archivedWorkspaces, (current) =>
				Array.isArray(current)
					? (current as typeof archivedSummaries).filter(
							(summary) => summary.id !== workspaceId,
						)
					: current,
			);

			if (selectedWorkspaceId === workspaceId) {
				// Pick the neighbour so virtualizer doesn't fling to the top.
				const optimisticGroups =
					(queryClient.getQueryData(
						helmorQueryKeys.workspaceGroups,
					) as typeof groups) ?? [];
				const nextArchivedRows = archivedRows.filter(
					(row) => row.id !== workspaceId,
				);
				const nextWorkspaceId = findReplacementWorkspaceIdAfterRemoval({
					currentGroups: groups,
					currentArchivedRows: archivedRows,
					nextGroups: optimisticGroups,
					nextArchivedRows,
					removedWorkspaceId: workspaceId,
				});
				if (nextWorkspaceId) {
					prefetchWorkspace(nextWorkspaceId);
				}
				onSelectWorkspace(nextWorkspaceId);
			}

			beginSidebarMutation();
			void permanentlyDeleteWorkspace(workspaceId)
				.catch((error) => {
					queryClient.setQueryData(
						helmorQueryKeys.workspaceGroups,
						previousGroups,
					);
					queryClient.setQueryData(
						helmorQueryKeys.archivedWorkspaces,
						previousArchived,
					);
					if (wasSelected) {
						onSelectWorkspace(workspaceId);
					}
					pushWorkspaceToast(
						describeUnknownError(error, "Unable to delete workspace."),
						"Delete failed",
						"destructive",
					);
				})
				.finally(endSidebarMutation);
		},
		[
			archivedRows,
			beginSidebarMutation,
			endSidebarMutation,
			groups,
			onSelectWorkspace,
			prefetchWorkspace,
			pushWorkspaceToast,
			queryClient,
			selectedWorkspaceId,
		],
	);

	const pushPermanentDeleteRecoveryToast = useCallback(
		(
			workspaceId: string,
			title: string,
			error: unknown,
			fallbackMessage: string,
		) => {
			pushWorkspaceToast(
				describeUnknownError(error, fallbackMessage),
				title,
				"destructive",
				{
					persistent: true,
					action: {
						label: "Permanently Delete",
						destructive: true,
						onClick: () => {
							handleDeleteWorkspace(workspaceId);
						},
					},
				},
			);
		},
		[handleDeleteWorkspace, pushWorkspaceToast],
	);

	const notifyTargetBranchRestore = useCallback(
		(targetBranch: string | null) => {
			if (!targetBranch) {
				return;
			}
			pushWorkspaceToast(
				`No archive commit was available, so the workspace was restored from "${targetBranch}".`,
				"Restored from target branch",
				"default",
			);
		},
		[pushWorkspaceToast],
	);

	// Keep the forward-ref used by `pushWorkspaceErrorToast` in sync.
	useEffect(() => {
		handleDeleteWorkspaceRef.current = handleDeleteWorkspace;
	}, [handleDeleteWorkspace]);

	// Keep the forward-ref used by `rollbackArchivedWorkspace` in sync.
	useEffect(() => {
		pushPermanentDeleteRecoveryToastRef.current =
			pushPermanentDeleteRecoveryToast;
	}, [pushPermanentDeleteRecoveryToast]);

	const notifyBranchRename = useCallback(
		(rename: { original: string; actual: string }) => {
			pushWorkspaceToast(
				`Branch "${rename.original}" was already taken. Restored on "${rename.actual}" instead.`,
				"Branch renamed",
			);
		},
		[pushWorkspaceToast],
	);

	const handleArchiveWorkspace = useCallback(
		(workspaceId: string) => {
			void (async () => {
				if (archivingWorkspaceIds.has(workspaceId)) {
					return;
				}

				updateArchivingWorkspaceId(workspaceId, true);

				try {
					await prepareArchiveWorkspace(workspaceId);
				} catch (error) {
					updateArchivingWorkspaceId(workspaceId, false);
					pushWorkspaceErrorToast(
						workspaceId,
						"Archive failed",
						error,
						"Unable to archive workspace.",
					);
					return;
				}

				const previousGroups =
					queryClient.getQueryData(helmorQueryKeys.workspaceGroups) ?? groups;

				const moved = {
					row: null as WorkspaceRow | null,
					groupId: null as string | null,
					index: -1,
				};
				const optimisticGroups = Array.isArray(previousGroups)
					? (previousGroups as typeof groups).map((group) => {
							const index = group.rows.findIndex(
								(row) => row.id === workspaceId,
							);
							if (index === -1) {
								return group;
							}
							moved.row = group.rows[index];
							moved.groupId = group.id;
							moved.index = index;
							return {
								...group,
								rows: [
									...group.rows.slice(0, index),
									...group.rows.slice(index + 1),
								],
							};
						})
					: undefined;

				if (
					!moved.row ||
					!optimisticGroups ||
					moved.groupId === null ||
					moved.index < 0
				) {
					updateArchivingWorkspaceId(workspaceId, false);
					pushWorkspaceToast(
						"Unable to find workspace in the sidebar cache.",
						"Archive failed",
						"destructive",
					);
					return;
				}

				const sortTimestamp = Date.now();
				const pendingArchive: PendingArchiveEntry = {
					row: {
						...moved.row,
						state: "archived",
					},
					sourceGroupId: moved.groupId,
					sourceIndex: moved.index,
					stage: "running",
					sortTimestamp,
				};
				setPendingArchives((current) => {
					const next = new Map(current);
					next.set(workspaceId, pendingArchive);
					return next;
				});

				queryClient.setQueryData(
					helmorQueryKeys.workspaceGroups,
					optimisticGroups,
				);

				const optimisticArchived = projectSidebarLists({
					baseGroups: optimisticGroups,
					baseArchivedSummaries,
					pendingArchives: new Map([
						...pendingArchives,
						[workspaceId, pendingArchive],
					]),
					pendingCreations: new Map(
						Array.from(pendingCreations.entries()).map(
							([optimisticWorkspaceId, pendingCreation]) => [
								optimisticWorkspaceId,
								pendingCreation.entry,
							],
						),
					),
				});
				const shouldNavigate =
					!selectedWorkspaceId || selectedWorkspaceId === workspaceId;
				if (shouldNavigate) {
					if (onOpenNewWorkspace) {
						onOpenNewWorkspace();
					} else {
						const nextWorkspaceId = findReplacementWorkspaceIdAfterRemoval({
							currentGroups: groups,
							currentArchivedRows: archivedRows,
							nextGroups: optimisticGroups,
							nextArchivedRows: optimisticArchived.archivedRows,
							removedWorkspaceId: workspaceId,
						});
						if (nextWorkspaceId) {
							prefetchWorkspace(nextWorkspaceId);
						}
						onSelectWorkspace(nextWorkspaceId);
					}
				}

				void startArchiveWorkspace(workspaceId)
					.catch((error) => {
						rollbackArchivedWorkspace(
							workspaceId,
							error,
							"Unable to archive workspace.",
						);
					})
					.finally(() => {
						updateArchivingWorkspaceId(workspaceId, false);
					});
			})();
		},
		[
			archivingWorkspaceIds,
			baseArchivedSummaries,
			groups,
			onSelectWorkspace,
			onOpenNewWorkspace,
			pendingArchives,
			prefetchWorkspace,
			pushWorkspaceErrorToast,
			pushWorkspaceToast,
			queryClient,
			rollbackArchivedWorkspace,
			selectedWorkspaceId,
			updateArchivingWorkspaceId,
		],
	);

	const executeRestore = useCallback(
		(workspaceId: string, targetBranchOverride?: string) => {
			const previousGroups = queryClient.getQueryData(
				helmorQueryKeys.workspaceGroups,
			);
			const previousArchived = queryClient.getQueryData(
				helmorQueryKeys.archivedWorkspaces,
			);

			const archivedSummary = Array.isArray(previousArchived)
				? (previousArchived as typeof archivedSummaries).find(
						(summary) => summary.id === workspaceId,
					)
				: undefined;

			if (!archivedSummary) {
				beginSidebarMutation();
				void restoreWorkspace(workspaceId, targetBranchOverride)
					.then((response) => {
						prefetchWorkspace(workspaceId);
						onSelectWorkspace(workspaceId);
						notifyTargetBranchRestore(response.restoredFromTargetBranch);
						if (response.branchRename) {
							notifyBranchRename(response.branchRename);
						}
					})
					.catch((error) => {
						pushPermanentDeleteRecoveryToast(
							workspaceId,
							"Restore failed",
							error,
							"Unable to restore workspace.",
						);
					})
					.finally(endSidebarMutation);
				return;
			}

			queryClient.setQueryData(helmorQueryKeys.archivedWorkspaces, (current) =>
				Array.isArray(current)
					? (current as typeof archivedSummaries).filter(
							(summary) => summary.id !== workspaceId,
						)
					: current,
			);

			const placeholderRow = summaryToArchivedRow({
				...archivedSummary,
				state: "ready",
			});
			const targetGroupId = workspaceGroupIdFromStatus(
				archivedSummary.status,
				archivedSummary.pinnedAt,
			);
			// Sorted insert by createdAt DESC so the row lands where the server
			// will place it on refetch — avoids the reorder flicker we'd get from
			// unconditionally prepending.
			queryClient.setQueryData(helmorQueryKeys.workspaceGroups, (current) =>
				Array.isArray(current)
					? (current as typeof groups).map((group) =>
							group.id === targetGroupId
								? {
										...group,
										rows: insertRowByCreatedAtDesc(group.rows, placeholderRow),
									}
								: group,
						)
					: current,
			);

			prefetchWorkspace(workspaceId);
			onSelectWorkspace(workspaceId);

			beginSidebarMutation();
			void restoreWorkspace(workspaceId, targetBranchOverride)
				.then(async (response) => {
					await Promise.all([
						queryClient.invalidateQueries({
							queryKey: helmorQueryKeys.workspaceDetail(workspaceId),
						}),
						queryClient.invalidateQueries({
							queryKey: helmorQueryKeys.workspaceSessions(workspaceId),
						}),
					]);
					if (response.branchRename) {
						notifyBranchRename(response.branchRename);
					}
					notifyTargetBranchRestore(response.restoredFromTargetBranch);
				})
				.catch((error) => {
					queryClient.setQueryData(
						helmorQueryKeys.workspaceGroups,
						previousGroups,
					);
					queryClient.setQueryData(
						helmorQueryKeys.archivedWorkspaces,
						previousArchived,
					);
					pushPermanentDeleteRecoveryToast(
						workspaceId,
						"Restore failed",
						error,
						"Unable to restore workspace.",
					);
				})
				.finally(endSidebarMutation);
		},
		[
			beginSidebarMutation,
			endSidebarMutation,
			notifyBranchRename,
			notifyTargetBranchRestore,
			onSelectWorkspace,
			pendingCreations,
			prefetchWorkspace,
			pushPermanentDeleteRecoveryToast,
			queryClient,
		],
	);

	const handleRestoreWorkspace = useCallback(
		(workspaceId: string) => {
			void (async () => {
				try {
					const validation = await validateRestoreWorkspace(workspaceId);
					if (validation.targetBranchConflict) {
						const { currentBranch, suggestedBranch, remote } =
							validation.targetBranchConflict;
						pushWorkspaceToast(
							`Branch "${currentBranch}" no longer exists on ${remote}. Switch target to "${suggestedBranch}"?`,
							"Target branch changed",
							"default",
							{
								persistent: true,
								action: {
									label: `Switch to ${suggestedBranch}`,
									onClick: () => executeRestore(workspaceId, suggestedBranch),
								},
							},
						);
						return;
					}
				} catch (error) {
					pushPermanentDeleteRecoveryToast(
						workspaceId,
						"Restore failed",
						error,
						"Unable to restore workspace.",
					);
					return;
				}

				executeRestore(workspaceId);
			})();
		},
		[executeRestore, pushPermanentDeleteRecoveryToast, pushWorkspaceToast],
	);

	return {
		addingRepository,
		archivingWorkspaceIds,
		archivedRows,
		availableRepositories: repositoriesQuery.data ?? [],
		creatingWorkspaceRepoId,
		cloneDefaultDirectory,
		groups,
		handleAddRepository,
		handleArchiveWorkspace,
		handleCloneFromUrl,
		handleCreateWorkspaceFromRepo,
		handleDeleteWorkspace,
		handleMarkWorkspaceUnread,
		handleOpenCloneDialog,
		handleRestoreWorkspace,
		handleSelectWorkspace,
		handleSetWorkspaceStatus,
		handleTogglePin,
		isCloneDialogOpen,
		prefetchWorkspace,
		setIsCloneDialogOpen,
	};
}

function createPreparedWorkspaceRow(
	repository: RepositoryCreateOption,
	prepared: {
		workspaceId: string;
		initialSessionId: string;
		directoryName: string;
		branch: string;
		state: WorkspaceState;
	},
): WorkspaceRow {
	return {
		id: prepared.workspaceId,
		// Prepare returns the final directory and branch, so the row is
		// already in its terminal shape — no placeholder → real swap.
		title: `${repository.name} workspace`,
		directoryName: prepared.directoryName,
		repoName: repository.name,
		repoIconSrc: repository.repoIconSrc ?? null,
		repoInitials: repository.repoInitials ?? null,
		state: prepared.state,
		hasUnread: false,
		workspaceUnread: 0,
		unreadSessionCount: 0,
		status: "in-progress",
		branch: prepared.branch,
		activeSessionId: prepared.initialSessionId,
		activeSessionTitle: "Untitled",
		activeSessionAgentType: null,
		activeSessionStatus: "idle",
		prTitle: null,
		pinnedAt: null,
		sessionCount: 1,
		messageCount: 0,
		createdAt: new Date().toISOString(),
	};
}

function createOptimisticWorkspaceSession(
	workspaceId: string,
	sessionId: string,
	createdAt: string,
): WorkspaceSessionSummary {
	return {
		id: sessionId,
		workspaceId,
		title: "Untitled",
		agentType: null,
		status: "idle",
		model: null,
		permissionMode: "default",
		providerSessionId: null,
		effortLevel: null,
		unreadCount: 0,
		fastMode: false,
		createdAt,
		updatedAt: createdAt,
		lastUserMessageAt: null,
		isHidden: false,
		actionKind: null,
		active: true,
	};
}
