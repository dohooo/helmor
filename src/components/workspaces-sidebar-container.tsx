import { useQuery, useQueryClient } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
	addRepositoryFromLocalPath,
	archiveWorkspace,
	createWorkspaceFromRepo,
	loadAddRepositoryDefaults,
	markWorkspaceRead,
	markWorkspaceUnread,
	permanentlyDeleteWorkspace,
	pinWorkspace,
	restoreWorkspace,
	setWorkspaceManualStatus,
	unpinWorkspace,
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
import {
	clearWorkspaceUnreadFromGroups,
	clearWorkspaceUnreadFromSummaries,
	describeUnknownError,
	findInitialWorkspaceId,
	findWorkspaceRowById,
	hasWorkspaceId,
	summaryToArchivedRow,
} from "@/lib/workspace-helpers";
import { WorkspacesSidebar } from "./workspaces-sidebar";

type WorkspaceToastVariant = "default" | "destructive";

type WorkspacesSidebarContainerProps = {
	selectedWorkspaceId: string | null;
	sendingWorkspaceIds?: Set<string>;
	onSelectWorkspace: (workspaceId: string | null) => void;
	pushWorkspaceToast: (
		description: string,
		title?: string,
		variant?: WorkspaceToastVariant,
		opts?: {
			action?: { label: string; onClick: () => void; destructive?: boolean };
			persistent?: boolean;
		},
	) => void;
};

export const WorkspacesSidebarContainer = memo(
	function WorkspacesSidebarContainer({
		selectedWorkspaceId,
		sendingWorkspaceIds,
		onSelectWorkspace,
		pushWorkspaceToast,
	}: WorkspacesSidebarContainerProps) {
		const queryClient = useQueryClient();
		const [addingRepository, setAddingRepository] = useState(false);
		const [creatingWorkspaceRepoId, setCreatingWorkspaceRepoId] = useState<
			string | null
		>(null);
		const [archivingWorkspaceId, setArchivingWorkspaceId] = useState<
			string | null
		>(null);
		const [restoringWorkspaceId, setRestoringWorkspaceId] = useState<
			string | null
		>(null);
		const [markingUnreadWorkspaceId, setMarkingUnreadWorkspaceId] = useState<
			string | null
		>(null);
		const [markingReadWorkspaceId, setMarkingReadWorkspaceId] = useState<
			string | null
		>(null);
		const [suppressedWorkspaceReadId, setSuppressedWorkspaceReadId] = useState<
			string | null
		>(null);

		const groupsQuery = useQuery(workspaceGroupsQueryOptions());
		const archivedQuery = useQuery(archivedWorkspacesQueryOptions());
		const repositoriesQuery = useQuery(repositoriesQueryOptions());

		const groups = groupsQuery.data ?? [];
		const archivedSummaries = archivedQuery.data ?? [];
		const archivedRows = useMemo(
			() => archivedSummaries.map(summaryToArchivedRow),
			[archivedSummaries],
		);

		useEffect(() => {
			if (
				selectedWorkspaceId === null &&
				groupsQuery.data === undefined &&
				archivedQuery.data === undefined
			) {
				return;
			}

			// Avoid selecting browser-dev fallback rows while the real desktop query is still loading.
			if (
				selectedWorkspaceId === null &&
				groupsQuery.isFetching &&
				groupsQuery.data === workspaceGroupsQueryOptions().initialData
			) {
				return;
			}

			const nextWorkspaceId =
				selectedWorkspaceId &&
				hasWorkspaceId(selectedWorkspaceId, groups, archivedSummaries)
					? selectedWorkspaceId
					: (findInitialWorkspaceId(groups) ??
						archivedSummaries[0]?.id ??
						null);

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
		]);

		const prefetchWorkspace = useCallback(
			(workspaceId: string) => {
				void (async () => {
					const [workspaceDetail, workspaceSessions] = await Promise.all([
						queryClient.ensureQueryData(
							workspaceDetailQueryOptions(workspaceId),
						),
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
			async (workspaceId: string) => {
				await Promise.all([
					queryClient.invalidateQueries({
						queryKey: helmorQueryKeys.workspaceGroups,
					}),
					queryClient.invalidateQueries({
						queryKey: helmorQueryKeys.archivedWorkspaces,
					}),
					queryClient.invalidateQueries({
						queryKey: helmorQueryKeys.workspaceDetail(workspaceId),
					}),
					queryClient.invalidateQueries({
						queryKey: helmorQueryKeys.workspaceSessions(workspaceId),
					}),
				]);
			},
			[queryClient],
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
				queryClient.setQueryData(
					helmorQueryKeys.archivedWorkspaces,
					(current) =>
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
					.then(() => invalidateWorkspaceSummary(workspaceId))
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
			async (workspaceId: string) => {
				if (
					markingUnreadWorkspaceId ||
					archivingWorkspaceId ||
					restoringWorkspaceId
				) {
					return;
				}

				setMarkingUnreadWorkspaceId(workspaceId);

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
				queryClient.setQueryData(
					helmorQueryKeys.archivedWorkspaces,
					(current) =>
						Array.isArray(current)
							? (current as typeof archivedSummaries).map((summary) =>
									summary.id === workspaceId
										? {
												...summary,
												hasUnread: true,
												workspaceUnread: Math.max(
													1,
													summary.workspaceUnread ?? 0,
												),
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
											(current as { workspaceUnread?: number })
												.workspaceUnread ?? 0,
										),
									),
								}
							: current,
				);

				try {
					await markWorkspaceUnread(workspaceId);
					if (selectedWorkspaceId === workspaceId) {
						setSuppressedWorkspaceReadId(workspaceId);
					}
					await invalidateWorkspaceSummary(workspaceId);
				} catch (error) {
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
				} finally {
					setMarkingUnreadWorkspaceId(null);
				}
			},
			[
				archivedSummaries,
				archivingWorkspaceId,
				groups,
				invalidateWorkspaceSummary,
				markingUnreadWorkspaceId,
				pushWorkspaceToast,
				queryClient,
				restoringWorkspaceId,
			],
		);

		const handleTogglePin = useCallback(
			async (workspaceId: string, currentlyPinned: boolean) => {
				// Optimistic update: move between pinned and status groups
				const statusToGroupId: Record<string, string> = {
					done: "done",
					review: "review",
					"in-review": "review",
					"in-progress": "progress",
					backlog: "backlog",
					canceled: "canceled",
				};

				queryClient.setQueryData(helmorQueryKeys.workspaceGroups, (current) => {
					if (!Array.isArray(current)) return current;
					const groupsCopy = current as typeof groups;

					// Find the row across all groups
					type Row = (typeof groups)[number]["rows"][number];
					let foundRow: Row | null = null;
					const withoutRow = groupsCopy.map((group) => {
						const idx = group.rows.findIndex((row) => row.id === workspaceId);
						if (idx === -1) return group;
						foundRow = group.rows[idx];
						return {
							...group,
							rows: [...group.rows.slice(0, idx), ...group.rows.slice(idx + 1)],
						};
					});

					if (!foundRow) return current;
					const row = foundRow as Row;

					const updatedRow: Row = {
						...row,
						pinnedAt: currentlyPinned ? null : new Date().toISOString(),
					};

					// Determine target group
					const targetGroupId = currentlyPinned
						? (statusToGroupId[
								updatedRow.manualStatus ??
									updatedRow.derivedStatus ??
									"in-progress"
							] ?? "progress")
						: "pinned";

					return withoutRow.map((group) =>
						group.id === targetGroupId
							? { ...group, rows: [...group.rows, updatedRow] }
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
			[groups, invalidateWorkspaceSummary, pushWorkspaceToast, queryClient],
		);

		const handleSetManualStatus = useCallback(
			async (workspaceId: string, status: string | null) => {
				// Map status value → group id
				const statusToGroupId: Record<string, string> = {
					done: "done",
					review: "review",
					"in-review": "review",
					"in-progress": "progress",
					backlog: "backlog",
					canceled: "canceled",
				};
				const targetGroupId =
					statusToGroupId[status ?? "in-progress"] ?? "progress";

				// Optimistic update: move workspace to target group
				queryClient.setQueryData(helmorQueryKeys.workspaceGroups, (current) => {
					if (!Array.isArray(current)) return current;
					const groupsCopy = current as typeof groups;

					// Find and remove the row from its current group
					let movedRow: (typeof groups)[number]["rows"][number] | null = null;
					const withoutRow = groupsCopy.map((group) => {
						const idx = group.rows.findIndex((row) => row.id === workspaceId);
						if (idx === -1) return group;
						movedRow = { ...group.rows[idx], manualStatus: status };
						return {
							...group,
							rows: [...group.rows.slice(0, idx), ...group.rows.slice(idx + 1)],
						};
					});

					if (!movedRow) return current;

					// Add to target group
					return withoutRow.map((group) =>
						group.id === targetGroupId
							? { ...group, rows: [...group.rows, movedRow] }
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
			[groups, invalidateWorkspaceSummary, pushWorkspaceToast, queryClient],
		);

		const handleCreateWorkspaceFromRepo = useCallback(
			async (repoId: string) => {
				if (
					addingRepository ||
					creatingWorkspaceRepoId ||
					archivingWorkspaceId ||
					restoringWorkspaceId ||
					markingUnreadWorkspaceId
				) {
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
				addingRepository,
				archivingWorkspaceId,
				creatingWorkspaceRepoId,
				markingUnreadWorkspaceId,
				onSelectWorkspace,
				prefetchWorkspace,
				pushWorkspaceToast,
				refetchNavigation,
				restoringWorkspaceId,
			],
		);

		const handleAddRepository = useCallback(async () => {
			if (
				addingRepository ||
				creatingWorkspaceRepoId ||
				archivingWorkspaceId ||
				restoringWorkspaceId ||
				markingUnreadWorkspaceId
			) {
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
				const selectedPath = Array.isArray(selection)
					? selection[0]
					: selection;

				if (!selectedPath) {
					return;
				}

				const response = await addRepositoryFromLocalPath(selectedPath);
				await refetchNavigation();
				prefetchWorkspace(response.selectedWorkspaceId);
				onSelectWorkspace(response.selectedWorkspaceId);
			} catch (error) {
				pushWorkspaceToast(
					describeUnknownError(error, "Unable to add repository."),
				);
			} finally {
				setAddingRepository(false);
			}
		}, [
			addingRepository,
			archivingWorkspaceId,
			creatingWorkspaceRepoId,
			markingUnreadWorkspaceId,
			onSelectWorkspace,
			prefetchWorkspace,
			pushWorkspaceToast,
			refetchNavigation,
			restoringWorkspaceId,
		]);

		const handleArchiveWorkspace = useCallback(
			async (workspaceId: string) => {
				if (addingRepository || archivingWorkspaceId || restoringWorkspaceId) {
					return;
				}

				setArchivingWorkspaceId(workspaceId);

				try {
					await archiveWorkspace(workspaceId);
					const { loadedGroups, loadedArchived } = await refetchNavigation();
					const nextWorkspaceId =
						selectedWorkspaceId && selectedWorkspaceId !== workspaceId
							? hasWorkspaceId(
									selectedWorkspaceId,
									loadedGroups,
									loadedArchived,
								)
								? selectedWorkspaceId
								: (findInitialWorkspaceId(loadedGroups) ??
									loadedArchived[0]?.id ??
									null)
							: (findInitialWorkspaceId(loadedGroups) ??
								loadedArchived[0]?.id ??
								null);

					if (nextWorkspaceId) {
						prefetchWorkspace(nextWorkspaceId);
					}
					onSelectWorkspace(nextWorkspaceId);
				} catch (error) {
					const msg = describeUnknownError(
						error,
						"Unable to archive workspace.",
					);
					pushWorkspaceToast(msg, "Archive failed", "destructive", {
						persistent: true,
						action: {
							label: "Permanently Delete",
							destructive: true,
							onClick: () => {
								void (async () => {
									try {
										await permanentlyDeleteWorkspace(workspaceId);
										const { loadedGroups, loadedArchived } =
											await refetchNavigation();
										const nextWorkspaceId =
											findInitialWorkspaceId(loadedGroups) ??
											loadedArchived[0]?.id ??
											null;
										onSelectWorkspace(nextWorkspaceId);
										pushWorkspaceToast(
											"Workspace permanently deleted.",
											"Done",
											"default",
										);
									} catch (deleteError) {
										pushWorkspaceToast(
											describeUnknownError(
												deleteError,
												"Unable to delete workspace.",
											),
										);
									}
								})();
							},
						},
					});
				} finally {
					setArchivingWorkspaceId(null);
				}
			},
			[
				addingRepository,
				archivingWorkspaceId,
				onSelectWorkspace,
				prefetchWorkspace,
				pushWorkspaceToast,
				refetchNavigation,
				restoringWorkspaceId,
				selectedWorkspaceId,
			],
		);

		const handleRestoreWorkspace = useCallback(
			async (workspaceId: string) => {
				if (addingRepository || archivingWorkspaceId || restoringWorkspaceId) {
					return;
				}

				setRestoringWorkspaceId(workspaceId);

				try {
					const response = await restoreWorkspace(workspaceId);
					await Promise.all([
						refetchNavigation(),
						queryClient.invalidateQueries({
							queryKey: helmorQueryKeys.workspaceDetail(workspaceId),
						}),
						queryClient.invalidateQueries({
							queryKey: helmorQueryKeys.workspaceSessions(workspaceId),
						}),
					]);
					prefetchWorkspace(response.selectedWorkspaceId);
					onSelectWorkspace(response.selectedWorkspaceId);
				} catch (error) {
					pushWorkspaceToast(
						describeUnknownError(error, "Unable to restore workspace."),
					);
				} finally {
					setRestoringWorkspaceId(null);
				}
			},
			[
				addingRepository,
				archivingWorkspaceId,
				onSelectWorkspace,
				prefetchWorkspace,
				pushWorkspaceToast,
				refetchNavigation,
				restoringWorkspaceId,
			],
		);

		const handleDeleteWorkspace = useCallback(
			async (workspaceId: string) => {
				try {
					await permanentlyDeleteWorkspace(workspaceId);
					const { loadedGroups, loadedArchived } = await refetchNavigation();
					if (selectedWorkspaceId === workspaceId) {
						const nextWorkspaceId =
							findInitialWorkspaceId(loadedGroups) ??
							loadedArchived[0]?.id ??
							null;
						onSelectWorkspace(nextWorkspaceId);
					}
				} catch (error) {
					pushWorkspaceToast(
						describeUnknownError(error, "Unable to delete workspace."),
					);
				}
			},
			[
				onSelectWorkspace,
				pushWorkspaceToast,
				refetchNavigation,
				selectedWorkspaceId,
			],
		);

		return (
			<WorkspacesSidebar
				groups={groups}
				archivedRows={archivedRows}
				availableRepositories={repositoriesQuery.data ?? []}
				addingRepository={addingRepository}
				selectedWorkspaceId={selectedWorkspaceId}
				sendingWorkspaceIds={sendingWorkspaceIds}
				creatingWorkspaceRepoId={creatingWorkspaceRepoId}
				onAddRepository={() => {
					void handleAddRepository();
				}}
				onSelectWorkspace={handleSelectWorkspace}
				onPrefetchWorkspace={prefetchWorkspace}
				onCreateWorkspace={(repoId) => {
					void handleCreateWorkspaceFromRepo(repoId);
				}}
				onArchiveWorkspace={(workspaceId) => {
					void handleArchiveWorkspace(workspaceId);
				}}
				onMarkWorkspaceUnread={(workspaceId) => {
					void handleMarkWorkspaceUnread(workspaceId);
				}}
				onRestoreWorkspace={(workspaceId) => {
					void handleRestoreWorkspace(workspaceId);
				}}
				onDeleteWorkspace={(workspaceId) => {
					void handleDeleteWorkspace(workspaceId);
				}}
				onTogglePin={(workspaceId, pinned) => {
					void handleTogglePin(workspaceId, pinned);
				}}
				onSetManualStatus={(workspaceId, status) => {
					void handleSetManualStatus(workspaceId, status);
				}}
				archivingWorkspaceId={archivingWorkspaceId}
				markingUnreadWorkspaceId={markingUnreadWorkspaceId}
				restoringWorkspaceId={restoringWorkspaceId}
			/>
		);
	},
);
