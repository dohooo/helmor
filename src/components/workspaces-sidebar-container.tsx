import { useQuery, useQueryClient } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
	validateArchiveWorkspace,
	validateRestoreWorkspace,
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
	rowToWorkspaceSummary,
	summaryToArchivedRow,
	workspaceGroupIdFromStatus,
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
		// `addingRepository` is the only operation kept gated at the UI level —
		// it opens a system file dialog (one-at-a-time semantic). Every other
		// workspace mutation (archive / restore / delete / mark unread) is
		// optimistic and fire-and-forget; the backend mutation lock serializes
		// concurrent IPCs naturally, so we no longer need to disable the UI
		// while one is in flight.
		const [addingRepository, setAddingRepository] = useState(false);
		const [creatingWorkspaceRepoId, setCreatingWorkspaceRepoId] = useState<
			string | null
		>(null);
		const [markingReadWorkspaceId, setMarkingReadWorkspaceId] = useState<
			string | null
		>(null);
		const [suppressedWorkspaceReadId, setSuppressedWorkspaceReadId] = useState<
			string | null
		>(null);

		// Number of in-flight optimistic mutations whose state lives in the
		// sidebar query caches (workspaceGroups + archivedWorkspaces). While
		// this counter is > 0, ANY refresh of those two queries is deferred —
		// otherwise the canonical data returned by an early-completing mutation
		// would wipe out the optimistic state of a still-flying neighbor.
		// The last mutation to settle is responsible for triggering the single
		// final invalidation.
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
				// Per-workspace queries are independent of any sidebar optimistic
				// state, so they always refresh immediately.
				await Promise.all([
					queryClient.invalidateQueries({
						queryKey: helmorQueryKeys.workspaceDetail(workspaceId),
					}),
					queryClient.invalidateQueries({
						queryKey: helmorQueryKeys.workspaceSessions(workspaceId),
					}),
				]);
				// Sidebar lists: only refresh if no optimistic mutation is still
				// in flight. Otherwise the in-flight mutation's `endSidebarMutation`
				// will trigger the refresh once everything has settled.
				if (sidebarMutationCountRef.current === 0) {
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

				if (selectedWorkspaceId === workspaceId) {
					setSuppressedWorkspaceReadId(workspaceId);
				}

				void markWorkspaceUnread(workspaceId)
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
						pushWorkspaceToast(
							describeUnknownError(
								error,
								"Unable to mark workspace as unread.",
							),
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
			onSelectWorkspace,
			prefetchWorkspace,
			pushWorkspaceToast,
			refetchNavigation,
		]);

		// ─── Optimistic delete ──────────────────────────────────────────────
		// Immediately removes the workspace from whichever list (groups OR
		// archived) currently holds it, navigates to the next visible
		// workspace if necessary, then fires the IPC fire-and-forget. On
		// failure, both lists roll back to their previous state and an error
		// toast is shown.
		const handleDeleteWorkspace = useCallback(
			(workspaceId: string) => {
				const previousGroups = queryClient.getQueryData(
					helmorQueryKeys.workspaceGroups,
				);
				const previousArchived = queryClient.getQueryData(
					helmorQueryKeys.archivedWorkspaces,
				);

				// Remove from groups
				queryClient.setQueryData(helmorQueryKeys.workspaceGroups, (current) =>
					Array.isArray(current)
						? (current as typeof groups).map((group) => ({
								...group,
								rows: group.rows.filter((row) => row.id !== workspaceId),
							}))
						: current,
				);
				// Remove from archived
				queryClient.setQueryData(
					helmorQueryKeys.archivedWorkspaces,
					(current) =>
						Array.isArray(current)
							? (current as typeof archivedSummaries).filter(
									(summary) => summary.id !== workspaceId,
								)
							: current,
				);

				// Navigate away if we were viewing the deleted workspace
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
						pushWorkspaceToast(
							describeUnknownError(error, "Unable to delete workspace."),
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

		// ─── Recovery toast helper ──────────────────────────────────────────
		// Archive and restore can both fail in ways the user can only resolve
		// by tearing the workspace down: the source worktree is missing, the
		// archived context directory is gone, the DB record is missing a
		// branch / archive commit, etc. In every one of those cases the only
		// forward motion is `permanently_delete_workspace`. Surface that as a
		// persistent destructive toast with a Permanently Delete action so
		// the user is never stranded with a workspace they can neither
		// archive, restore, nor get rid of.
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

		// ─── Branch-rename notification helper ──────────────────────────────
		// When restore lands on a `-vN`-suffixed branch because the original
		// branch name was already taken, the backend returns the rename in
		// the response. Surface it as a non-destructive informational toast
		// so the user is never confused about why their workspace is on a
		// different branch than they remember.
		const notifyBranchRename = useCallback(
			(rename: { original: string; actual: string }) => {
				pushWorkspaceToast(
					`Branch "${rename.original}" was already taken. Restored on "${rename.actual}" instead.`,
					"Branch renamed",
				);
			},
			[pushWorkspaceToast],
		);

		// ─── Optimistic archive (with preflight) ────────────────────────────
		// 1. Run a fast read-only preflight (DB load + filesystem checks +
		//    git rev-parse). If it fails, the workspace is in a state where
		//    archive can never succeed (broken on disk, missing DB fields,
		//    etc.) — surface the recovery toast so the user can permanently
		//    delete it instead of being stuck.
		// 2. If preflight passes, optimistically remove the row from its
		//    current group, insert a placeholder into the archived list,
		//    navigate to the next visible workspace, and fire the slow IPC
		//    fire-and-forget.
		// 3. The slow apply still has its own catch path (rare race: state
		//    changed between preflight and apply, disk full mid-write, etc.)
		//    that rolls back and uses the same recovery toast.
		const handleArchiveWorkspace = useCallback(
			(workspaceId: string) => {
				void (async () => {
					try {
						await validateArchiveWorkspace(workspaceId);
					} catch (error) {
						pushPermanentDeleteRecoveryToast(
							workspaceId,
							"Archive failed",
							error,
							"Unable to archive workspace.",
						);
						return;
					}

					const previousGroups = queryClient.getQueryData(
						helmorQueryKeys.workspaceGroups,
					);
					const previousArchived = queryClient.getQueryData(
						helmorQueryKeys.archivedWorkspaces,
					);

					// Find the row in groups so we can move it to archived.
					let movedRow: (typeof groups)[number]["rows"][number] | null = null;
					const optimisticGroups = Array.isArray(previousGroups)
						? (previousGroups as typeof groups).map((group) => {
								const idx = group.rows.findIndex(
									(row) => row.id === workspaceId,
								);
								if (idx === -1) return group;
								movedRow = group.rows[idx];
								return {
									...group,
									rows: [
										...group.rows.slice(0, idx),
										...group.rows.slice(idx + 1),
									],
								};
							})
						: undefined;

					if (!movedRow || !optimisticGroups) {
						// Row not found in groups — nothing to optimistically remove.
						// Just fire the IPC; the in-flight counter will trigger a
						// single sidebar refresh once everything settles.
						beginSidebarMutation();
						void archiveWorkspace(workspaceId)
							.catch((error) => {
								pushPermanentDeleteRecoveryToast(
									workspaceId,
									"Archive failed",
									error,
									"Unable to archive workspace.",
								);
							})
							.finally(endSidebarMutation);
						return;
					}

					queryClient.setQueryData(
						helmorQueryKeys.workspaceGroups,
						optimisticGroups,
					);

					const archivedPlaceholder = rowToWorkspaceSummary(movedRow, {
						state: "archived",
					});
					queryClient.setQueryData(
						helmorQueryKeys.archivedWorkspaces,
						(current) =>
							Array.isArray(current)
								? [
										archivedPlaceholder,
										...(current as typeof archivedSummaries),
									]
								: [archivedPlaceholder],
					);

					// Compute next workspace from the optimistic state.
					const optimisticArchived =
						(queryClient.getQueryData(
							helmorQueryKeys.archivedWorkspaces,
						) as typeof archivedSummaries) ?? [];
					const shouldNavigate =
						!selectedWorkspaceId || selectedWorkspaceId === workspaceId;
					if (shouldNavigate) {
						const nextWorkspaceId =
							findInitialWorkspaceId(optimisticGroups) ??
							optimisticArchived.find((s) => s.id !== workspaceId)?.id ??
							null;
						if (nextWorkspaceId) {
							prefetchWorkspace(nextWorkspaceId);
						}
						onSelectWorkspace(nextWorkspaceId);
					}

					beginSidebarMutation();
					void archiveWorkspace(workspaceId)
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
								"Archive failed",
								error,
								"Unable to archive workspace.",
							);
						})
						.finally(endSidebarMutation);
				})();
			},
			[
				beginSidebarMutation,
				endSidebarMutation,
				onSelectWorkspace,
				prefetchWorkspace,
				pushPermanentDeleteRecoveryToast,
				queryClient,
				selectedWorkspaceId,
			],
		);

		// ─── Optimistic restore (with preflight) ────────────────────────────
		// Same shape as archive: cheap preflight first (verifies the archive
		// commit still exists in git, archived context dir is on disk, etc.),
		// then optimistic UI move + slow IPC. The preflight catches the
		// common "Commit not found" / "Archived context directory missing"
		// failure modes BEFORE the row jumps groups, so the user never sees
		// the workspace flicker between archived and progress. Both the
		// preflight and the slow apply use the shared recovery toast so an
		// archived workspace whose on-disk state is broken can still be
		// permanently deleted.
		const executeRestore = useCallback(
			(workspaceId: string, targetBranchOverride?: string) => {
				const previousGroups = queryClient.getQueryData(
					helmorQueryKeys.workspaceGroups,
				);
				const previousArchived = queryClient.getQueryData(
					helmorQueryKeys.archivedWorkspaces,
				);

				// Find the summary in archived.
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

				queryClient.setQueryData(
					helmorQueryKeys.archivedWorkspaces,
					(current) =>
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
						// Per-workspace caches refresh immediately — they're not
						// part of the deferred sidebar batch and downstream UI
						// (panel, sessions list) needs the latest record.
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
				onArchiveWorkspace={handleArchiveWorkspace}
				onMarkWorkspaceUnread={handleMarkWorkspaceUnread}
				onRestoreWorkspace={handleRestoreWorkspace}
				onDeleteWorkspace={handleDeleteWorkspace}
				onTogglePin={(workspaceId, pinned) => {
					void handleTogglePin(workspaceId, pinned);
				}}
				onSetManualStatus={(workspaceId, status) => {
					void handleSetManualStatus(workspaceId, status);
				}}
			/>
		);
	},
);
