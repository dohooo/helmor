import { useQuery, useQueryClient } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	addRepositoryFromLocalPath,
	createWorkspaceFromRepo,
	listenArchiveExecutionFailed,
	listenArchiveExecutionSucceeded,
	loadAddRepositoryDefaults,
	markWorkspaceRead,
	markWorkspaceUnread,
	permanentlyDeleteWorkspace,
	pinWorkspace,
	prepareArchiveWorkspace,
	restoreWorkspace,
	setWorkspaceManualStatus,
	startArchiveWorkspace,
	unpinWorkspace,
	validateRestoreWorkspace,
	type WorkspaceRow,
	type WorkspaceSessionSummary,
} from "@/lib/api";
import {
	archivedWorkspacesQueryOptions,
	helmorQueryKeys,
	repositoriesQueryOptions,
	sessionThreadMessagesQueryOptions,
	workspaceDetailQueryOptions,
	workspaceGroupsQueryOptions,
	workspaceSessionsQueryOptions,
} from "@/lib/query-client";
import { useSettings } from "@/lib/settings";
import {
	clearWorkspaceUnreadFromGroups,
	clearWorkspaceUnreadFromSummaries,
	describeUnknownError,
	findInitialWorkspaceId,
	findWorkspaceRowById,
	hasWorkspaceId,
	rowToWorkspaceSummary,
	summaryToArchivedRow,
	workspaceGroupIdFromStatus,
} from "@/lib/workspace-helpers";

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
	onSelectWorkspace: (workspaceId: string | null) => void;
	pushWorkspaceToast: WorkspaceToastFn;
};

const WORKSPACE_GROUPS_INITIAL_DATA = workspaceGroupsQueryOptions().initialData;

export function useWorkspacesSidebarController({
	selectedWorkspaceId,
	onSelectWorkspace,
	pushWorkspaceToast,
}: UseWorkspacesSidebarControllerArgs) {
	const queryClient = useQueryClient();
	const { settings } = useSettings();
	const [addingRepository, setAddingRepository] = useState(false);
	const [creatingWorkspaceRepoId, setCreatingWorkspaceRepoId] = useState<
		string | null
	>(null);
	const [archivingWorkspaceIds, setArchivingWorkspaceIds] = useState<
		Set<string>
	>(() => new Set());
	const [markingReadWorkspaceId, setMarkingReadWorkspaceId] = useState<
		string | null
	>(null);
	const [suppressedWorkspaceReadId, setSuppressedWorkspaceReadId] = useState<
		string | null
	>(null);

	const archiveRollbackRef = useRef<
		Map<
			string,
			{
				row: WorkspaceRow;
				sourceGroupId: string;
				sourceIndex: number;
			}
		>
	>(new Map());
	const sidebarMutationCountRef = useRef(0);

	const flushSidebarLists = useCallback(() => {
		void queryClient.invalidateQueries({
			queryKey: helmorQueryKeys.workspaceGroups,
		});
		void queryClient.invalidateQueries({
			queryKey: helmorQueryKeys.archivedWorkspaces,
		});
	}, [queryClient]);

	const beginSidebarMutation = useCallback(() => {
		sidebarMutationCountRef.current += 1;
	}, []);

	const endSidebarMutation = useCallback(() => {
		sidebarMutationCountRef.current = Math.max(
			0,
			sidebarMutationCountRef.current - 1,
		);
		if (sidebarMutationCountRef.current === 0) {
			flushSidebarLists();
		}
	}, [flushSidebarLists]);

	const groupsQuery = useQuery(workspaceGroupsQueryOptions());
	const archivedQuery = useQuery(archivedWorkspacesQueryOptions());
	const repositoriesQuery = useQuery(repositoriesQueryOptions());

	const baseGroups = groupsQuery.data ?? [];
	const baseArchivedSummaries = archivedQuery.data ?? [];
	const pendingArchivedEntries = Array.from(
		archiveRollbackRef.current.entries(),
	);
	const pendingArchivedIds = new Set(
		pendingArchivedEntries.map(([workspaceId]) => workspaceId),
	);
	const groups =
		pendingArchivedIds.size === 0
			? baseGroups
			: baseGroups.map((group) => ({
					...group,
					rows: group.rows.filter((row) => !pendingArchivedIds.has(row.id)),
				}));
	const archivedSummaries =
		pendingArchivedEntries.length === 0
			? baseArchivedSummaries
			: [
					...pendingArchivedEntries
						.filter(
							([workspaceId]) =>
								!baseArchivedSummaries.some(
									(summary) => summary.id === workspaceId,
								),
						)
						.map(([, rollback]) =>
							rowToWorkspaceSummary(rollback.row, {
								state: "archived",
							}),
						),
					...baseArchivedSummaries,
				];
	const archivedRows = useMemo(
		() => archivedSummaries.map(summaryToArchivedRow),
		[archivedSummaries],
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

	const rollbackArchivedWorkspace = useCallback(
		(workspaceId: string, error: unknown, fallbackMessage: string) => {
			updateArchivingWorkspaceId(workspaceId, false);
			const rollback = archiveRollbackRef.current.get(workspaceId);
			archiveRollbackRef.current.delete(workspaceId);

			if (!rollback) {
				flushSidebarLists();
				pushWorkspaceToast(
					describeUnknownError(error, fallbackMessage),
					"Archive failed",
					"destructive",
				);
				return;
			}

			queryClient.setQueryData(helmorQueryKeys.archivedWorkspaces, (current) =>
				Array.isArray(current)
					? (current as typeof archivedSummaries).filter(
							(summary) => summary.id !== workspaceId,
						)
					: current,
			);

			queryClient.setQueryData(helmorQueryKeys.workspaceGroups, (current) => {
				if (!Array.isArray(current)) {
					return current;
				}
				return (current as typeof groups).map((group) => {
					if (group.id !== rollback.sourceGroupId) {
						return group;
					}
					if (group.rows.some((row) => row.id === workspaceId)) {
						return group;
					}
					const nextRows = [...group.rows];
					const insertAt = Math.min(
						Math.max(rollback.sourceIndex, 0),
						nextRows.length,
					);
					nextRows.splice(insertAt, 0, rollback.row);
					return {
						...group,
						rows: nextRows,
					};
				});
			});

			pushWorkspaceToast(
				describeUnknownError(error, fallbackMessage),
				"Archive failed",
				"destructive",
			);
		},
		[
			archivedSummaries,
			flushSidebarLists,
			groups,
			pushWorkspaceToast,
			queryClient,
			updateArchivingWorkspaceId,
		],
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
				new Error(payload.message),
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
			archiveRollbackRef.current.delete(payload.workspaceId);
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

		let nextWorkspaceId: string | null;
		if (
			selectedWorkspaceId &&
			hasWorkspaceId(selectedWorkspaceId, groups, archivedSummaries)
		) {
			nextWorkspaceId = selectedWorkspaceId;
		} else if (
			settings.lastWorkspaceId &&
			hasWorkspaceId(settings.lastWorkspaceId, groups, archivedSummaries)
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
			if (!opts?.skipSidebarFlush && sidebarMutationCountRef.current === 0) {
				flushSidebarLists();
			}
		},
		[flushSidebarLists, queryClient],
	);

	const markWorkspaceReadOptimistically = useCallback(
		(workspaceId: string) => {
			const selectedRow = findWorkspaceRowById(
				workspaceId,
				groups,
				archivedRows,
			);

			if (
				!selectedRow?.hasUnread ||
				markingReadWorkspaceId === workspaceId ||
				suppressedWorkspaceReadId === workspaceId
			) {
				return;
			}

			setMarkingReadWorkspaceId(workspaceId);

			const previousGroups = queryClient.getQueryData(
				helmorQueryKeys.workspaceGroups,
			);
			const previousArchived = queryClient.getQueryData(
				helmorQueryKeys.archivedWorkspaces,
			);
			const previousDetail = queryClient.getQueryData(
				helmorQueryKeys.workspaceDetail(workspaceId),
			);
			const previousSessions = queryClient.getQueryData(
				helmorQueryKeys.workspaceSessions(workspaceId),
			);

			queryClient.setQueryData(helmorQueryKeys.workspaceGroups, (current) =>
				current
					? clearWorkspaceUnreadFromGroups(
							current as typeof groups,
							workspaceId,
						)
					: current,
			);
			queryClient.setQueryData(helmorQueryKeys.archivedWorkspaces, (current) =>
				current
					? clearWorkspaceUnreadFromSummaries(
							current as typeof archivedSummaries,
							workspaceId,
						)
					: current,
			);
			queryClient.setQueryData(
				helmorQueryKeys.workspaceDetail(workspaceId),
				(current) =>
					current
						? {
								...(current as Record<string, unknown>),
								hasUnread: false,
								workspaceUnread: 0,
								sessionUnreadTotal: 0,
								unreadSessionCount: 0,
							}
						: current,
			);
			queryClient.setQueryData(
				helmorQueryKeys.workspaceSessions(workspaceId),
				(current) =>
					Array.isArray(current)
						? (current as WorkspaceSessionSummary[]).map((session) => ({
								...session,
								unreadCount: 0,
							}))
						: current,
			);

			void markWorkspaceRead(workspaceId)
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
					queryClient.setQueryData(
						helmorQueryKeys.workspaceSessions(workspaceId),
						previousSessions,
					);
					pushWorkspaceToast(
						describeUnknownError(error, "Unable to mark workspace as read."),
					);
				})
				.finally(() => {
					setMarkingReadWorkspaceId((current) =>
						current === workspaceId ? null : current,
					);
				});
		},
		[
			archivedRows,
			archivedSummaries,
			groups,
			invalidateWorkspaceSummary,
			markingReadWorkspaceId,
			pushWorkspaceToast,
			queryClient,
			suppressedWorkspaceReadId,
		],
	);

	const handleSelectWorkspace = useCallback(
		(workspaceId: string) => {
			onSelectWorkspace(workspaceId);
			markWorkspaceReadOptimistically(workspaceId);
		},
		[markWorkspaceReadOptimistically, onSelectWorkspace],
	);

	useEffect(() => {
		if (
			suppressedWorkspaceReadId &&
			selectedWorkspaceId !== suppressedWorkspaceReadId
		) {
			setSuppressedWorkspaceReadId(null);
		}
	}, [selectedWorkspaceId, suppressedWorkspaceReadId]);

	useEffect(() => {
		if (!selectedWorkspaceId) {
			return;
		}

		markWorkspaceReadOptimistically(selectedWorkspaceId);
	}, [markWorkspaceReadOptimistically, selectedWorkspaceId]);

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

			queryClient.setQueryData(helmorQueryKeys.workspaceGroups, (current) =>
				Array.isArray(current)
					? (current as typeof groups).map((group) => ({
							...group,
							rows: group.rows.map((row) =>
								row.id === workspaceId
									? {
											...row,
											hasUnread: true,
											workspaceUnread: Math.max(1, row.workspaceUnread ?? 0),
										}
									: row,
							),
						}))
					: current,
			);
			queryClient.setQueryData(helmorQueryKeys.archivedWorkspaces, (current) =>
				Array.isArray(current)
					? (current as typeof archivedSummaries).map((summary) =>
							summary.id === workspaceId
								? {
										...summary,
										hasUnread: true,
										workspaceUnread: Math.max(1, summary.workspaceUnread ?? 0),
									}
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
								workspaceUnread: Math.max(
									1,
									Number(
										(current as { workspaceUnread?: number }).workspaceUnread ??
											0,
									),
								),
							}
						: current,
			);

			if (selectedWorkspaceId === workspaceId) {
				setSuppressedWorkspaceReadId(workspaceId);
			}

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
		[
			invalidateWorkspaceSummary,
			pushWorkspaceToast,
			queryClient,
			selectedWorkspaceId,
		],
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

				const targetGroupId = currentlyPinned
					? workspaceGroupIdFromStatus(
							updatedRow.manualStatus,
							updatedRow.derivedStatus,
						)
					: "pinned";

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

	const handleSetManualStatus = useCallback(
		async (workspaceId: string, status: string | null) => {
			const targetGroupId = workspaceGroupIdFromStatus(status, status);

			queryClient.setQueryData(helmorQueryKeys.workspaceGroups, (current) => {
				if (!Array.isArray(current)) {
					return current;
				}
				const groupsCopy = current as typeof groups;

				let movedRow: (typeof groups)[number]["rows"][number] | null = null;
				const withoutRow = groupsCopy.map((group) => {
					const index = group.rows.findIndex((row) => row.id === workspaceId);
					if (index === -1) {
						return group;
					}
					movedRow = { ...group.rows[index], manualStatus: status };
					return {
						...group,
						rows: [
							...group.rows.slice(0, index),
							...group.rows.slice(index + 1),
						],
					};
				});

				if (!movedRow) {
					return current;
				}

				return withoutRow.map((group) =>
					group.id === targetGroupId
						? { ...group, rows: [movedRow, ...group.rows] }
						: group,
				);
			});

			try {
				await setWorkspaceManualStatus(workspaceId, status);
				await invalidateWorkspaceSummary(workspaceId);
			} catch (error) {
				void queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.workspaceGroups,
				});
				pushWorkspaceToast(
					describeUnknownError(error, "Unable to set status."),
				);
			}
		},
		[invalidateWorkspaceSummary, pushWorkspaceToast, queryClient],
	);

	const handleCreateWorkspaceFromRepo = useCallback(
		async (repoId: string) => {
			if (creatingWorkspaceRepoId) {
				return;
			}

			setCreatingWorkspaceRepoId(repoId);

			try {
				const response = await createWorkspaceFromRepo(repoId);
				await refetchNavigation();
				prefetchWorkspace(response.selectedWorkspaceId);
				onSelectWorkspace(response.selectedWorkspaceId);
			} catch (error) {
				pushWorkspaceToast(
					describeUnknownError(error, "Unable to create workspace."),
				);
			} finally {
				setCreatingWorkspaceRepoId(null);
			}
		},
		[
			creatingWorkspaceRepoId,
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
			await refetchNavigation();
			prefetchWorkspace(response.selectedWorkspaceId);
			onSelectWorkspace(response.selectedWorkspaceId);

			if (!response.createdRepository) {
				pushWorkspaceToast(
					"Switched to the existing workspace.",
					"Repository already added",
					"default",
				);
			}
		} catch (error) {
			pushWorkspaceToast(
				describeUnknownError(error, "Unable to add repository."),
			);
		} finally {
			setAddingRepository(false);
		}
	}, [
		addingRepository,
		onSelectWorkspace,
		prefetchWorkspace,
		pushWorkspaceToast,
		refetchNavigation,
	]);

	const handleDeleteWorkspace = useCallback(
		(workspaceId: string) => {
			const wasSelected = selectedWorkspaceId === workspaceId;
			archiveRollbackRef.current.delete(workspaceId);
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
				const optimisticGroups =
					(queryClient.getQueryData(
						helmorQueryKeys.workspaceGroups,
					) as typeof groups) ?? [];
				const optimisticArchived =
					(queryClient.getQueryData(
						helmorQueryKeys.archivedWorkspaces,
					) as typeof archivedSummaries) ?? [];
				const nextWorkspaceId =
					findInitialWorkspaceId(optimisticGroups) ??
					optimisticArchived[0]?.id ??
					null;
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
			beginSidebarMutation,
			endSidebarMutation,
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
					pushWorkspaceToast(
						describeUnknownError(error, "Unable to archive workspace."),
						"Archive failed",
						"destructive",
					);
					return;
				}

				const previousGroups =
					queryClient.getQueryData(helmorQueryKeys.workspaceGroups) ?? groups;

				let movedRow: WorkspaceRow | null = null;
				let sourceGroupId: string | null = null;
				let sourceIndex = -1;
				const optimisticGroups = Array.isArray(previousGroups)
					? (previousGroups as typeof groups).map((group) => {
							const index = group.rows.findIndex(
								(row) => row.id === workspaceId,
							);
							if (index === -1) {
								return group;
							}
							movedRow = group.rows[index];
							sourceGroupId = group.id;
							sourceIndex = index;
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
					!movedRow ||
					!optimisticGroups ||
					sourceGroupId === null ||
					sourceIndex < 0
				) {
					updateArchivingWorkspaceId(workspaceId, false);
					pushWorkspaceToast(
						"Unable to find workspace in the sidebar cache.",
						"Archive failed",
						"destructive",
					);
					return;
				}

				queryClient.setQueryData(
					helmorQueryKeys.workspaceGroups,
					optimisticGroups,
				);

				const archivedPlaceholder = rowToWorkspaceSummary(movedRow, {
					state: "archived",
				});
				archiveRollbackRef.current.set(workspaceId, {
					row: movedRow,
					sourceGroupId,
					sourceIndex,
				});
				queryClient.setQueryData(
					helmorQueryKeys.archivedWorkspaces,
					(current) =>
						Array.isArray(current)
							? [archivedPlaceholder, ...(current as typeof archivedSummaries)]
							: [archivedPlaceholder],
				);

				const optimisticArchived =
					(queryClient.getQueryData(
						helmorQueryKeys.archivedWorkspaces,
					) as typeof archivedSummaries) ?? [];
				const shouldNavigate =
					!selectedWorkspaceId || selectedWorkspaceId === workspaceId;
				if (shouldNavigate) {
					const nextWorkspaceId =
						findInitialWorkspaceId(optimisticGroups) ??
						optimisticArchived.find((summary) => summary.id !== workspaceId)
							?.id ??
						null;
					if (nextWorkspaceId) {
						prefetchWorkspace(nextWorkspaceId);
					}
					onSelectWorkspace(nextWorkspaceId);
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
			groups,
			onSelectWorkspace,
			prefetchWorkspace,
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
				archivedSummary.manualStatus,
				archivedSummary.derivedStatus,
			);
			queryClient.setQueryData(helmorQueryKeys.workspaceGroups, (current) =>
				Array.isArray(current)
					? (current as typeof groups).map((group) =>
							group.id === targetGroupId
								? { ...group, rows: [placeholderRow, ...group.rows] }
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
			onSelectWorkspace,
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
		groups,
		handleAddRepository,
		handleArchiveWorkspace,
		handleCreateWorkspaceFromRepo,
		handleDeleteWorkspace,
		handleMarkWorkspaceUnread,
		handleRestoreWorkspace,
		handleSelectWorkspace,
		handleSetManualStatus,
		handleTogglePin,
		prefetchWorkspace,
	};
}
