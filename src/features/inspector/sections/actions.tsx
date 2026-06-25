import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	ArrowUpRightIcon,
	CheckIcon,
	ChevronDown,
	CircleSlashIcon,
	EyeIcon,
	LoaderCircleIcon,
	TriangleIcon,
} from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import {
	AppendContextButton,
	type AppendContextPayloadResult,
} from "@/components/append-context-button";
import { GithubBrandIcon, GitlabBrandIcon } from "@/components/brand-icon";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type {
	CommitButtonState,
	WorkspaceCommitButtonMode,
} from "@/features/commit/button";
import {
	type ActionProvider,
	type ActionStatusKind,
	type ChangeRequestInfo,
	type ForgeActionItem,
	type ForgeActionStatus,
	getWorkspaceForgeCheckInsertText,
	loadRepoPreferences,
	type RepoPreferences,
	type SyncWorkspaceTargetResponse,
	syncWorkspaceWithTargetBranch,
	type WorkspaceGitActionStatus,
} from "@/lib/api";
import { buildComposerPreviewPayload } from "@/lib/composer-insert";
import { formatSource, I18nText, translateSource, useI18n } from "@/lib/i18n";
import { openUrl } from "@/lib/platform-bridge";
import {
	helmorQueryKeys,
	workspaceForgeActionStatusQueryOptions,
	workspaceForgeQueryOptions,
	workspaceGitActionStatusQueryOptions,
} from "@/lib/query-client";
// `workspaceForgeQueryOptions` is still used here to drive `changeRequestName`
// for the review/PR rows (MR vs PR wording). Forge onboarding lives in
// `GitSectionHeader` — see the top-right of the Changes section.
import { resolveRepoPreferencePrompt } from "@/lib/repo-preferences-prompts";
import { requestSidebarReconcile } from "@/lib/sidebar-mutation-gate";
import { cn } from "@/lib/utils";
import {
	INSPECTOR_SECTION_HEADER_CLASS,
	INSPECTOR_SECTION_TITLE_CLASS,
} from "../layout";

interface GitStatusItem {
	label: string;
	status: ActionStatusKind;
	action?: {
		label: string;
		kind: "commit" | "sync";
		mode?: WorkspaceCommitButtonMode;
	};
}

// `label` is an i18n key (see buildGitRows action labels). Maps the action
// key to the loading-state label key, both resolved via t() at the call site.
function loadingActionLabel(label: string): string {
	switch (label) {
		case "push":
			return "pushing";
		case "pull":
			return "pulling";
		case "resolve":
			return "resolving";
		case "commit":
		case "commitPush":
			return "committing";
		default:
			return "loading";
	}
}

const EMPTY_GIT_ACTION_STATUS: WorkspaceGitActionStatus = {
	uncommittedCount: 0,
	conflictCount: 0,
	syncTargetBranch: null,
	syncStatus: "unknown",
	behindTargetCount: 0,
	remoteTrackingRef: null,
	aheadOfRemoteCount: 0,
	aheadOfTargetCount: 0,
	pushStatus: "unknown",
};

const EMPTY_FORGE_ACTION_STATUS: ForgeActionStatus = {
	changeRequest: null,
	reviewDecision: null,
	mergeable: null,
	deployments: [],
	checks: [],
	remoteState: "unavailable",
	message: null,
};

const INSPECTOR_ACTION_ROW_STATE_CLASS =
	"text-muted-foreground transition-colors hover:bg-accent/45";
const INSPECTOR_ACTION_ICON_STATE_CLASS =
	"hover:bg-accent/45 hover:text-foreground";

type ActionsSectionProps = {
	workspaceId: string | null;
	workspaceState?: string | null;
	repoId?: string | null;
	workspaceRemote?: string | null;
	sectionRef?: React.RefObject<HTMLElement | null>;
	open: boolean;
	onToggle: () => void;
	onCommitAction?: (mode: WorkspaceCommitButtonMode) => Promise<void>;
	onReviewAction?: () => Promise<void>;
	currentSessionId?: string | null;
	onQueuePendingPromptForSession?: (request: {
		sessionId: string;
		prompt: string;
		modelId?: string | null;
		permissionMode?: string | null;
		forceQueue?: boolean;
	}) => void;
	commitButtonMode?: WorkspaceCommitButtonMode;
	commitButtonState?: CommitButtonState;
	changeRequest: ChangeRequestInfo | null;
};

function buildSyncResolutionPrompt(
	result: SyncWorkspaceTargetResponse,
	repoPreferences: RepoPreferences | null,
	workspaceRemote?: string | null,
): string {
	const remote = workspaceRemote?.trim();
	const targetBranch = result.targetBranch.trim();
	const targetRef =
		remote &&
		(targetBranch === remote ||
			targetBranch.startsWith(`${remote}/`) ||
			targetBranch.startsWith(`refs/remotes/${remote}/`))
			? targetBranch
			: remote
				? `${remote}/${targetBranch}`
				: targetBranch;

	return resolveRepoPreferencePrompt({
		key: "resolveConflicts",
		repoPreferences,
		targetRef,
		resolveConflictsKind:
			result.outcome === "stashPopConflict"
				? "stashPopConflict"
				: "mergeConflict",
	});
}

export function ActionsSection({
	workspaceId,
	workspaceState,
	repoId,
	workspaceRemote,
	sectionRef,
	open,
	onToggle,
	onCommitAction,
	onReviewAction,
	currentSessionId,
	onQueuePendingPromptForSession,
	commitButtonMode,
	commitButtonState,
	changeRequest,
}: ActionsSectionProps) {
	const { t } = useI18n();
	const queryClient = useQueryClient();
	const [syncPending, setSyncPending] = useState(false);
	const [reviewPending, setReviewPending] = useState(false);
	const forgeQuery = useQuery({
		...workspaceForgeQueryOptions(workspaceId ?? "__none__"),
		enabled: workspaceId !== null,
	});
	// Archived workspaces have no live worktree — polling git/PR status every
	// 10s would spam errors. App.tsx mirrors this guard.
	const isArchived = workspaceState === "archived";
	const gitStatusQuery = useQuery({
		...workspaceGitActionStatusQueryOptions(workspaceId ?? "__none__"),
		enabled: workspaceId !== null && !isArchived,
	});
	const forgeStatusQuery = useQuery({
		...workspaceForgeActionStatusQueryOptions(workspaceId ?? "__none__"),
		enabled: workspaceId !== null && !isArchived,
	});
	const gitStatus = gitStatusQuery.data ?? EMPTY_GIT_ACTION_STATUS;
	const forgeStatus = forgeStatusQuery.data ?? EMPTY_FORGE_ACTION_STATUS;
	// "Reviewable" = the user actually has changes of their own to review.
	// Two signals add up:
	//   - `uncommittedCount` — dirty working tree.
	//   - `aheadOfTargetCount` — commits past the target branch's remote ref.
	//
	// We deliberately do NOT use `aheadOfRemoteCount` (it reads as 0 on
	// unpublished branches, missing the local-only-commits case) or the
	// "branch unpublished" signal (a brand-new workspace branched from main
	// is unpublished too, but has no user changes — must not show Review).
	const hasReviewableChanges =
		gitStatus.uncommittedCount > 0 || gitStatus.aheadOfTargetCount > 0;
	const showReviewHelper = Boolean(onReviewAction) && hasReviewableChanges;
	// Helpers group hides entirely when no helper has anything to do. New
	// helpers should `||` into this — never render an empty group header.
	const showHelpersGroup = showReviewHelper;
	const changeRequestName = forgeQuery.data?.labels.changeRequestName ?? "PR";
	const providerName = forgeQuery.data?.labels.providerName ?? "Forge";
	// Auth-flip invalidation lives in the sync bridge — no frontend edge-detect.
	const gitRows = sortStatusRows(buildGitRows(gitStatus, workspaceRemote));
	const reviewRows = sortStatusRows(
		buildReviewRows(
			forgeStatus,
			changeRequest,
			changeRequestName,
			providerName,
		),
	);
	const sortedDeployments = sortActionItems(forgeStatus.deployments);
	const sortedChecks = sortActionItems(forgeStatus.checks);
	const actionDisabled = commitButtonState === "busy";
	const queueSyncResolutionPrompt = useCallback(
		async (result: SyncWorkspaceTargetResponse) => {
			if (!currentSessionId || !onQueuePendingPromptForSession) {
				return false;
			}
			const repoPreferences = repoId ? await loadRepoPreferences(repoId) : null;
			// `forceQueue: true` — if a turn is already streaming, the
			// prompt MUST queue (never steer), regardless of the user's
			// followUpBehavior setting. The merge task is a fresh task,
			// not a course correction for the current turn.
			onQueuePendingPromptForSession({
				sessionId: currentSessionId,
				prompt: buildSyncResolutionPrompt(
					result,
					repoPreferences,
					workspaceRemote,
				),
				forceQueue: true,
			});
			return true;
		},
		[currentSessionId, onQueuePendingPromptForSession, repoId, workspaceRemote],
	);
	const handleSync = useCallback(async () => {
		if (!workspaceId || syncPending) {
			return;
		}

		setSyncPending(true);
		try {
			const result = await syncWorkspaceWithTargetBranch(workspaceId);
			const target = result.targetBranch;
			if (result.outcome === "updated") {
				toast.success(formatSource("inspectorPulledLatestFrom", { target }));
			} else if (result.outcome === "alreadyUpToDate") {
				toast(formatSource("inspectorAlreadyUpToDateWith", { target }));
			} else {
				// conflict or stashPopConflict — both hand off to the agent
				// with a kind-specific narrow prompt.
				await queueSyncResolutionPrompt(result);
			}
		} catch (error) {
			const message =
				error instanceof Error
					? error.message
					: translateSource("inspectorUnableToPullTargetUpdates");
			toast.error(message);
		} finally {
			requestSidebarReconcile(queryClient);
			await Promise.all([
				queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.workspaceGitActionStatus(workspaceId),
				}),
				queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.workspaceChangeRequest(workspaceId),
				}),
				queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.workspaceForgeActionStatus(workspaceId),
				}),
				queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.workspaceDetail(workspaceId),
				}),
				queryClient.invalidateQueries({ queryKey: ["workspaceChanges"] }),
			]);
			setSyncPending(false);
		}
	}, [queryClient, queueSyncResolutionPrompt, syncPending, workspaceId]);
	const handleReviewChanges = useCallback(async () => {
		if (!onReviewAction || reviewPending) {
			return;
		}
		setReviewPending(true);
		try {
			await onReviewAction();
		} finally {
			setReviewPending(false);
		}
	}, [onReviewAction, reviewPending]);
	const handleInsertCheck = useCallback(
		async (item: ForgeActionItem) => {
			if (!workspaceId) {
				return;
			}
			const submitText = await getWorkspaceForgeCheckInsertText(
				workspaceId,
				item.id,
			);
			return {
				target: { workspaceId },
				label: item.name,
				submitText,
				key: `pr-check:${item.id}`,
				preview: buildComposerPreviewPayload({
					title: item.name,
					content: submitText,
					preferredKind: "code",
				}),
			};
		},
		[workspaceId],
	);
	return (
		<section
			ref={sectionRef}
			aria-label={t("inspectorSectionActions")}
			className={cn(
				"flex min-h-0 shrink-0 flex-col overflow-hidden border-b border-border/60 bg-sidebar transition-colors",
			)}
			// Height written via `sectionRef` by `useWorkspaceInspectorSidebar`.
		>
			<div
				className={cn(
					INSPECTOR_SECTION_HEADER_CLASS,
					"transition-colors",
					!open && "border-b-transparent",
				)}
			>
				<span className={INSPECTOR_SECTION_TITLE_CLASS}>
					<I18nText source="actions" />
				</span>
				<Button
					type="button"
					aria-label="toggleInspectorActionsSection"
					onClick={onToggle}
					variant="ghost"
					size="icon-sm"
					className={cn(
						"shrink-0 text-muted-foreground",
						INSPECTOR_ACTION_ICON_STATE_CLASS,
					)}
				>
					<ChevronDown
						className="size-3.5"
						strokeWidth={1.9}
						style={{
							transform: open ? "rotate(0deg)" : "rotate(-90deg)",
							transition: "none",
						}}
					/>
				</Button>
			</div>

			{open && (
				<div className="min-h-0 flex-1">
					<ScrollArea
						aria-label={t("actionsPanelBody")}
						className="h-full min-h-0 bg-muted/18 text-ui"
					>
						{showHelpersGroup && (
							<>
								<div className="px-2.5 pb-1 pt-2">
									<span className="text-mini font-medium tracking-wide text-muted-foreground/70">
										<I18nText source="helpers" />
									</span>
								</div>
								{showReviewHelper && (
									<div
										className={cn(
											"flex items-center gap-1.5 px-2.5 py-[3px]",
											INSPECTOR_ACTION_ROW_STATE_CLASS,
										)}
									>
										<EyeIcon
											aria-hidden="true"
											className="size-3 shrink-0"
											strokeWidth={2}
										/>
										<span className="truncate">
											<I18nText source="reviewChanges" />
										</span>
										<button
											type="button"
											onClick={() => void handleReviewChanges()}
											disabled={reviewPending || workspaceId === null}
											aria-busy={reviewPending ? true : undefined}
											aria-label={reviewPending ? t("reviewing") : undefined}
											className="ml-auto shrink-0 cursor-interactive text-micro text-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
										>
											<span className="inline-flex items-center gap-1">
												{reviewPending ? (
													<LoaderCircleIcon
														aria-hidden="true"
														className="size-3 animate-spin text-current opacity-70"
														strokeWidth={2}
													/>
												) : null}
												{reviewPending ? null : <I18nText source="review2" />}
											</span>
										</button>
									</div>
								)}
							</>
						)}
						<div className="px-2.5 pb-1 pt-2">
							<span className="text-mini font-medium tracking-wide text-muted-foreground/70">
								<I18nText source="git" />
							</span>
						</div>
						{gitRows.map((item) => {
							const action = item.action;
							const isCommitActionBusy =
								action?.kind === "commit" &&
								action.mode != null &&
								commitButtonMode === action.mode &&
								commitButtonState === "busy";
							const isSyncActionBusy = action?.kind === "sync" && syncPending;
							const isActionBusy = isCommitActionBusy || isSyncActionBusy;
							return (
								<div
									key={item.label}
									className={cn(
										"flex items-center gap-1.5 px-2.5 py-[3px]",
										INSPECTOR_ACTION_ROW_STATE_CLASS,
									)}
								>
									<StatusIcon status={item.status} />
									<span className="truncate">{item.label}</span>
									{action && (
										<button
											type="button"
											onClick={() => {
												if (
													(action.kind === "commit" && actionDisabled) ||
													(action.kind === "sync" && syncPending)
												) {
													return;
												}
												if (action.kind === "sync") {
													void handleSync();
													return;
												}
												void onCommitAction?.(action.mode!);
											}}
											className="ml-auto shrink-0 cursor-interactive text-micro text-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
											disabled={
												action.kind === "commit" ? actionDisabled : syncPending
											}
											aria-busy={isActionBusy ? true : undefined}
											aria-label={
												isActionBusy
													? t(loadingActionLabel(action.label))
													: undefined
											}
										>
											<span className="inline-flex items-center gap-1">
												{isActionBusy ? (
													<LoaderCircleIcon
														aria-hidden="true"
														className="size-3 animate-spin text-current opacity-70"
														strokeWidth={2}
													/>
												) : null}
												{isActionBusy ? null : t(action.label)}
											</span>
										</button>
									)}
								</div>
							);
						})}

						{reviewRows.length > 0 && (
							<>
								<div className="px-2.5 pb-1 pt-2.5">
									<span className="text-mini font-medium tracking-wide text-muted-foreground/70">
										<I18nText source="review2" />
									</span>
								</div>
								{reviewRows.map((item) => (
									<div
										key={item.label}
										className={cn(
											"flex items-center gap-1.5 px-2.5 py-[3px]",
											INSPECTOR_ACTION_ROW_STATE_CLASS,
										)}
									>
										<StatusIcon status={item.status} />
										<span className="truncate">{item.label}</span>
									</div>
								))}
							</>
						)}

						{sortedDeployments.length > 0 && (
							<>
								<div className="px-2.5 pb-1 pt-2.5">
									<span className="text-mini font-medium tracking-wide text-muted-foreground/70">
										<I18nText source="deployments" />
									</span>
								</div>
								{sortedDeployments.map((item) => (
									<ActionStatusRow key={item.id} item={item} />
								))}
							</>
						)}

						{sortedChecks.length > 0 && (
							<>
								<div className="px-2.5 pb-1 pt-2.5">
									<span className="text-mini font-medium tracking-wide text-muted-foreground/70">
										<I18nText source="checks" />
									</span>
								</div>
								{sortedChecks.map((item) => (
									<ActionStatusRow
										key={item.id}
										item={item}
										onInsertToComposer={handleInsertCheck}
									/>
								))}
							</>
						)}
					</ScrollArea>
				</div>
			)}
		</section>
	);
}

function ProviderIcon({ provider }: { provider: ActionProvider }) {
	if (provider === "vercel") {
		return (
			<TriangleIcon
				className="size-3 shrink-0 fill-current text-muted-foreground"
				strokeWidth={0}
			/>
		);
	}
	if (provider === "unknown") {
		return null;
	}
	if (provider === "gitlab") {
		return <GitlabBrandIcon size={12} className="text-muted-foreground" />;
	}
	return <GithubBrandIcon size={12} className="text-muted-foreground" />;
}

function StatusIcon({ status }: { status: ActionStatusKind }) {
	const { t } = useI18n();
	if (status === "success") {
		return (
			<CheckIcon
				aria-label={t("passed")}
				className="size-3 shrink-0 text-chart-2"
				strokeWidth={2.2}
			/>
		);
	}

	if (status === "skipped") {
		return (
			<CircleSlashIcon
				aria-label={t("skipped2")}
				className="size-3 shrink-0 text-muted-foreground"
				strokeWidth={2}
			/>
		);
	}

	const label =
		status === "running"
			? "running"
			: status === "failure"
				? "failed"
				: "pending";
	const color =
		status === "running"
			? "rgb(245, 158, 11)"
			: status === "failure"
				? "rgb(207, 34, 46)"
				: undefined;

	return (
		<span
			aria-label={t(label)}
			className="inline-flex size-3 shrink-0 items-center justify-center rounded-full border border-current text-muted-foreground"
			style={color ? { color } : undefined}
		>
			<span
				className={cn(
					"size-1.5 rounded-full",
					status === "pending" && "bg-muted-foreground",
				)}
				style={color ? { backgroundColor: color } : undefined}
			/>
		</span>
	);
}

function buildGitRows(
	gitStatus: WorkspaceGitActionStatus,
	workspaceRemote?: string | null,
): GitStatusItem[] {
	const uncommittedCount = gitStatus.uncommittedCount;
	const conflictCount = gitStatus.conflictCount;
	const syncTargetBranch = formatSyncTargetRef(
		workspaceRemote,
		gitStatus.syncTargetBranch,
	);

	return [
		uncommittedCount === 0
			? {
					label: translateSource("noUncommittedChanges"),
					status: "success",
				}
			: {
					label: formatSource("countUncommittedChangelabel", {
						count: uncommittedCount,
						changeLabel: uncommittedCount === 1 ? "change" : "changes",
					}),
					status: "pending",
					action: {
						// No remote → commit only (the prompt skips push too).
						label: workspaceRemote ? "commitPush" : "commit",
						kind: "commit",
						mode: "commit-and-push",
					},
				},
		...(workspaceRemote
			? ([
					gitStatus.pushStatus === "unpublished"
						? {
								label: translateSource("branchNotPublishedRemote"),
								status: "pending",
								action: {
									label: "push",
									kind: "commit",
									mode: "push",
								},
							}
						: (gitStatus.aheadOfRemoteCount ?? 0) > 0
							? {
									label: formatSource("inspectorCommitsAheadOf", {
										count: gitStatus.aheadOfRemoteCount,
										commitLabel:
											gitStatus.aheadOfRemoteCount === 1 ? "commit" : "commits",
										target: gitStatus.remoteTrackingRef ?? "upstream",
									}),
									status: "pending",
									action: {
										label: "push",
										kind: "commit",
										mode: "push",
									},
								}
							: {
									label: translateSource("branchFullyPushed"),
									status: "success",
								},
				] as GitStatusItem[])
			: []),
		conflictCount > 0
			? {
					label: translateSource("mergeConflictsDetected"),
					status: "failure",
					action: {
						label: "resolve",
						kind: "commit",
						mode: "resolve-conflicts",
					},
				}
			: gitStatus.syncStatus === "behind"
				? {
						label: formatSource("countCommitlabelBehindTarget", {
							count: gitStatus.behindTargetCount,
							commitLabel:
								gitStatus.behindTargetCount === 1 ? "commit" : "commits",
							target: syncTargetBranch,
						}),
						status: "pending",
						action: {
							label: "pull",
							kind: "sync",
						},
					}
				: gitStatus.syncStatus === "upToDate"
					? {
							label: formatSource("inspectorUpToDateWithTarget", {
								target: syncTargetBranch,
							}),
							status: "success",
						}
					: {
							label: translateSource("syncStatusUnavailable"),
							status: "pending",
						},
	];
}

function formatSyncTargetRef(
	workspaceRemote?: string | null,
	syncTargetBranch?: string | null,
): string {
	const branch = syncTargetBranch?.trim();
	if (!branch) {
		return translateSource("inspectorTargetBranch");
	}
	if (branch.includes("/")) {
		return branch;
	}
	const remote = workspaceRemote?.trim() || "origin";
	return `${remote}/${branch}`;
}

function buildReviewRows(
	forgeStatus: ForgeActionStatus,
	changeRequest: ChangeRequestInfo | null,
	changeRequestName = "PR",
	providerName = "Forge",
): GitStatusItem[] {
	const currentChangeRequest = forgeStatus.changeRequest ?? changeRequest;
	const isMerged = currentChangeRequest?.isMerged ?? false;
	const hasMergeConflict = forgeStatus.mergeable === "CONFLICTING";

	const rows: GitStatusItem[] = [];

	if (forgeStatus.remoteState === "unauthenticated") {
		rows.push({
			label: formatSource("inspectorProviderCliAuthRequired", {
				provider: providerName,
			}),
			status: "pending",
		});
	} else if (isMerged || forgeStatus.reviewDecision === "APPROVED") {
		rows.push({ label: translateSource("reviewApproved"), status: "success" });
	} else if (currentChangeRequest?.state === "CLOSED") {
		rows.push({
			label: formatSource("inspectorChangeRequestClosed", {
				name: changeRequestName,
			}),
			status: "failure",
		});
	} else if (forgeStatus.reviewDecision === "CHANGES_REQUESTED") {
		rows.push({
			label: translateSource("changesRequested"),
			status: "failure",
		});
	} else if (forgeStatus.remoteState !== "noPr") {
		rows.push({
			label: formatSource("inspectorWaitingForReview", {
				name: changeRequestName,
			}),
			status: "pending",
		});
	}

	if (hasMergeConflict) {
		rows.push({
			label: translateSource("mergeConflictsDetected"),
			status: "failure",
		});
	}

	return rows;
}

function ActionStatusRow({
	item,
	onInsertToComposer,
}: {
	item: ForgeActionItem;
	onInsertToComposer?: (
		item: ForgeActionItem,
	) => AppendContextPayloadResult | Promise<AppendContextPayloadResult>;
}) {
	const { t, f } = useI18n();
	const actionButtonClassName = cn(
		"size-5 rounded-sm text-muted-foreground opacity-55 transition-[opacity,color,background-color] hover:opacity-100 focus-visible:opacity-100 [&_svg]:size-3.5",
		INSPECTOR_ACTION_ICON_STATE_CLASS,
	);
	const appendActionButtonClassName = cn(
		"size-4 rounded-sm text-muted-foreground opacity-0 pointer-events-none group-hover/check-row:opacity-55 group-hover/check-row:pointer-events-auto group-focus-within/check-row:opacity-55 group-focus-within/check-row:pointer-events-auto hover:opacity-100 focus-visible:opacity-100 [&_svg]:size-3",
		INSPECTOR_ACTION_ICON_STATE_CLASS,
	);

	return (
		<div
			className={cn(
				"group/check-row flex items-center justify-between gap-3 px-2.5 py-[3px]",
				INSPECTOR_ACTION_ROW_STATE_CLASS,
			)}
		>
			<div className="flex min-w-0 flex-1 items-center gap-1.5">
				<StatusIcon status={item.status} />
				<ProviderIcon provider={item.provider} />
				<span
					className="min-w-0 truncate whitespace-nowrap text-muted-foreground"
					title={item.name}
				>
					{item.name}
				</span>
				{item.status === "skipped" ? (
					<span className="shrink-0 text-micro text-muted-foreground/70">
						<I18nText source={"skipped2"} />
					</span>
				) : (
					item.duration && (
						<span className="shrink-0 text-micro text-muted-foreground/70">
							{item.duration}
						</span>
					)
				)}
			</div>
			<div className="flex shrink-0 items-center justify-end gap-0">
				{onInsertToComposer && (
					<AppendContextButton
						subjectLabel={item.name}
						getPayload={() => onInsertToComposer(item)}
						errorTitle={t("inspectorCouldntInsertCheck")}
						className={appendActionButtonClassName}
					/>
				)}
				{item.url && (
					<Button
						type="button"
						variant="ghost"
						size="icon-xs"
						aria-label={f("inspectorOpenName", { name: item.name })}
						onClick={() => {
							if (!item.url) {
								return;
							}
							void openUrl(item.url);
						}}
						className={cn("shrink-0", actionButtonClassName)}
					>
						<ArrowUpRightIcon strokeWidth={1.8} />
					</Button>
				)}
			</div>
		</div>
	);
}

function sortActionItems(items: ForgeActionItem[]): ForgeActionItem[] {
	return [...items].sort((left, right) => {
		const statusDelta =
			actionPriority(left.status) - actionPriority(right.status);
		if (statusDelta !== 0) {
			return statusDelta;
		}

		const providerDelta = left.provider.localeCompare(right.provider);
		if (providerDelta !== 0) {
			return providerDelta;
		}

		return left.name.localeCompare(right.name);
	});
}

function sortStatusRows(items: GitStatusItem[]): GitStatusItem[] {
	return [...items].sort((left, right) => {
		const leftRank = statusRowPriority(left);
		const rightRank = statusRowPriority(right);
		if (leftRank !== rightRank) {
			return leftRank - rightRank;
		}

		const statusDelta =
			actionPriority(left.status) - actionPriority(right.status);
		if (statusDelta !== 0) {
			return statusDelta;
		}

		return left.label.localeCompare(right.label);
	});
}

function statusRowPriority(item: GitStatusItem): number {
	if (item.action) {
		return 0;
	}
	if (item.status !== "success") {
		return 1;
	}
	return 2;
}

function actionPriority(status: ActionStatusKind): number {
	switch (status) {
		case "failure":
			return 0;
		case "running":
			return 1;
		case "pending":
			return 2;
		case "success":
			return 3;
		case "skipped":
			return 4;
	}
}
