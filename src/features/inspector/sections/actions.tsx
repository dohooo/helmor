import { useQuery, useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
	ArrowUpRightIcon,
	CheckIcon,
	ChevronDown,
	EyeIcon,
	LoaderCircleIcon,
	TriangleIcon,
} from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
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
	INSPECTOR_SECTION_HEADER_HEIGHT,
	INSPECTOR_SECTION_TITLE_CLASS,
	TABS_ANIMATION_MS,
	TABS_EASING,
	TABS_EASING_CURVE,
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

function loadingActionLabel(label: string): string {
	switch (label) {
		case "Push":
			return "Pushing";
		case "Pull":
			return "Pulling";
		case "Resolve":
			return "Resolving";
		case "Commit and push":
			return "Committing";
		default:
			return "Loading";
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

type ActionsSectionProps = {
	workspaceId: string | null;
	workspaceState?: string | null;
	repoId?: string | null;
	workspaceRemote?: string | null;
	sectionRef?: React.RefObject<HTMLElement | null>;
	open: boolean;
	onToggle: () => void;
	bodyHeight: number;
	animatePanelToggle?: boolean;
	isResizing?: boolean;
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
	bodyHeight,
	animatePanelToggle = false,
	isResizing,
	onCommitAction,
	onReviewAction,
	currentSessionId,
	onQueuePendingPromptForSession,
	commitButtonMode,
	commitButtonState,
	changeRequest,
}: ActionsSectionProps) {
	const queryClient = useQueryClient();
	const [syncPending, setSyncPending] = useState(false);
	const [reviewPending, setReviewPending] = useState(false);
	const shouldReduceMotion = useReducedMotion();
	const panelTransition = {
		duration:
			animatePanelToggle && !isResizing && !shouldReduceMotion
				? TABS_ANIMATION_MS / 1000
				: 0,
		ease: TABS_EASING_CURVE,
	};
	const chevronTransitionMs =
		animatePanelToggle && !shouldReduceMotion ? TABS_ANIMATION_MS : 0;
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
				toast.success(`Pulled latest from ${target}`);
			} else if (result.outcome === "alreadyUpToDate") {
				toast(`Already up to date with ${target}`);
			} else {
				// conflict or stashPopConflict — both hand off to the agent
				// with a kind-specific narrow prompt.
				await queueSyncResolutionPrompt(result);
			}
		} catch (error) {
			const message =
				error instanceof Error
					? error.message
					: "Unable to pull target updates.";
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
		<motion.section
			ref={sectionRef}
			aria-label="Inspector section Actions"
			className={cn(
				"flex min-h-0 shrink-0 flex-col overflow-hidden border-b border-border/60 bg-sidebar transition-colors",
			)}
			initial={false}
			animate={{
				height: INSPECTOR_SECTION_HEADER_HEIGHT + (open ? bodyHeight : 0),
			}}
			transition={panelTransition}
			style={{
				willChange: isResizing ? undefined : "height",
			}}
		>
			<div
				className={cn(
					INSPECTOR_SECTION_HEADER_CLASS,
					"transition-colors",
					!open && "border-b-transparent",
				)}
			>
				<span className={INSPECTOR_SECTION_TITLE_CLASS}>Actions</span>
				<Button
					type="button"
					aria-label="Toggle inspector actions section"
					onClick={onToggle}
					variant="ghost"
					size="icon-sm"
					className="shrink-0 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
				>
					<ChevronDown
						className="size-3.5"
						strokeWidth={1.9}
						style={{
							transform: open ? "rotate(0deg)" : "rotate(-90deg)",
							transition: `transform ${chevronTransitionMs}ms ${TABS_EASING}`,
						}}
					/>
				</Button>
			</div>

			{open && (
				<div className="min-h-0">
					<ScrollArea
						aria-label="Actions panel body"
						className="min-h-0 bg-muted/18 text-[11.5px]"
						style={{ height: `${bodyHeight}px` }}
					>
						{showHelpersGroup && (
							<>
								<div className="px-2.5 pb-1 pt-2">
									<span className="text-[10.5px] font-medium tracking-wide text-muted-foreground">
										Helpers
									</span>
								</div>
								{showReviewHelper && (
									<div className="flex items-center gap-1.5 px-2.5 py-[3px] text-muted-foreground transition-colors hover:bg-accent/60">
										<EyeIcon
											aria-hidden="true"
											className="size-3 shrink-0"
											strokeWidth={2}
										/>
										<span className="truncate">Review changes</span>
										<button
											type="button"
											onClick={() => void handleReviewChanges()}
											disabled={reviewPending || workspaceId === null}
											aria-busy={reviewPending ? true : undefined}
											aria-label={reviewPending ? "Reviewing" : undefined}
											className="ml-auto shrink-0 cursor-interactive text-[10.5px] text-primary transition-colors hover:text-primary/80 disabled:cursor-not-allowed disabled:opacity-50"
										>
											<span className="inline-flex items-center gap-1">
												{reviewPending ? (
													<LoaderCircleIcon
														aria-hidden="true"
														className="size-3 animate-spin text-current opacity-70"
														strokeWidth={2}
													/>
												) : null}
												{reviewPending ? null : "Review"}
											</span>
										</button>
									</div>
								)}
							</>
						)}
						<div className="px-2.5 pb-1 pt-2">
							<span className="text-[10.5px] font-medium tracking-wide text-muted-foreground">
								Git
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
									className="flex items-center gap-1.5 px-2.5 py-[3px] text-muted-foreground transition-colors hover:bg-accent/60"
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
											className="ml-auto shrink-0 cursor-interactive text-[10.5px] text-primary transition-colors hover:text-primary/80 disabled:cursor-not-allowed disabled:opacity-50"
											disabled={
												action.kind === "commit" ? actionDisabled : syncPending
											}
											aria-busy={isActionBusy ? true : undefined}
											aria-label={
												isActionBusy
													? loadingActionLabel(action.label)
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
												{isActionBusy ? null : action.label}
											</span>
										</button>
									)}
								</div>
							);
						})}

						{reviewRows.length > 0 && (
							<>
								<div className="px-2.5 pb-1 pt-2.5">
									<span className="text-[10.5px] font-medium tracking-wide text-muted-foreground">
										Review
									</span>
								</div>
								{reviewRows.map((item) => (
									<div
										key={item.label}
										className="flex items-center gap-1.5 px-2.5 py-[3px] text-muted-foreground transition-colors hover:bg-accent/60"
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
									<span className="text-[10.5px] font-medium tracking-wide text-muted-foreground">
										Deployments
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
									<span className="text-[10.5px] font-medium tracking-wide text-muted-foreground">
										Checks
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
		</motion.section>
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
	if (status === "success") {
		return (
			<CheckIcon
				aria-label="Passed"
				className="size-3 shrink-0 text-chart-2"
				strokeWidth={2.2}
			/>
		);
	}

	const label =
		status === "running"
			? "Running"
			: status === "failure"
				? "Failed"
				: "Pending";
	const color =
		status === "running"
			? "rgb(245, 158, 11)"
			: status === "failure"
				? "rgb(207, 34, 46)"
				: undefined;

	return (
		<span
			aria-label={label}
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
					label: "No uncommitted changes",
					status: "success",
				}
			: {
					label:
						uncommittedCount === 1
							? "1 uncommitted change"
							: `${uncommittedCount} uncommitted changes`,
					status: "pending",
					action: {
						label: "Commit and push",
						kind: "commit",
						mode: "commit-and-push",
					},
				},
		gitStatus.pushStatus === "unpublished"
			? {
					label: "Branch not published to remote",
					status: "pending",
					action: {
						label: "Push",
						kind: "commit",
						mode: "push",
					},
				}
			: (gitStatus.aheadOfRemoteCount ?? 0) > 0
				? {
						label:
							gitStatus.aheadOfRemoteCount === 1
								? `1 commit ahead of ${gitStatus.remoteTrackingRef ?? "upstream"}`
								: `${gitStatus.aheadOfRemoteCount} commits ahead of ${gitStatus.remoteTrackingRef ?? "upstream"}`,
						status: "pending",
						action: {
							label: "Push",
							kind: "commit",
							mode: "push",
						},
					}
				: {
						label: "Branch fully pushed",
						status: "success",
					},
		conflictCount > 0
			? {
					label: "Merge conflicts detected",
					status: "failure",
					action: {
						label: "Resolve",
						kind: "commit",
						mode: "resolve-conflicts",
					},
				}
			: gitStatus.syncStatus === "behind"
				? {
						label:
							gitStatus.behindTargetCount === 1
								? `1 commit behind ${syncTargetBranch}`
								: `${gitStatus.behindTargetCount} commits behind ${syncTargetBranch}`,
						status: "pending",
						action: {
							label: "Pull",
							kind: "sync",
						},
					}
				: gitStatus.syncStatus === "upToDate"
					? {
							label: `Up to date with ${syncTargetBranch}`,
							status: "success",
						}
					: {
							label: "Sync status unavailable",
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
		return "target branch";
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
			label: `${providerName} CLI authentication required`,
			status: "pending",
		});
	} else if (isMerged || forgeStatus.reviewDecision === "APPROVED") {
		rows.push({ label: "Review approved", status: "success" });
	} else if (currentChangeRequest?.state === "CLOSED") {
		rows.push({ label: `${changeRequestName} closed`, status: "failure" });
	} else if (forgeStatus.reviewDecision === "CHANGES_REQUESTED") {
		rows.push({ label: "Changes requested", status: "failure" });
	} else if (forgeStatus.remoteState !== "noPr") {
		rows.push({
			label: `Waiting for ${changeRequestName} review`,
			status: "pending",
		});
	}

	if (hasMergeConflict) {
		rows.push({
			label: "Merge conflicts detected",
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
	const actionButtonClassName =
		"size-5 rounded-sm text-muted-foreground opacity-55 transition-[opacity,color,background-color] hover:bg-accent/60 hover:text-primary hover:opacity-100 focus-visible:opacity-100 [&_svg]:size-3.5";
	const appendActionButtonClassName =
		"size-4 rounded-sm text-muted-foreground opacity-0 pointer-events-none group-hover/check-row:opacity-55 group-hover/check-row:pointer-events-auto group-focus-within/check-row:opacity-55 group-focus-within/check-row:pointer-events-auto hover:bg-accent/60 hover:text-primary hover:opacity-100 focus-visible:opacity-100 [&_svg]:size-3";

	return (
		<div className="group/check-row flex items-center justify-between gap-3 px-2.5 py-[3px] text-muted-foreground transition-colors hover:bg-accent/60">
			<div className="flex min-w-0 flex-1 items-center gap-1.5">
				<StatusIcon status={item.status} />
				<ProviderIcon provider={item.provider} />
				<span
					className="min-w-0 truncate whitespace-nowrap text-primary"
					title={item.name}
				>
					{item.name}
				</span>
				{item.duration && (
					<span className="shrink-0 text-[10.5px] text-muted-foreground">
						{item.duration}
					</span>
				)}
			</div>
			<div className="flex shrink-0 items-center justify-end gap-0">
				{onInsertToComposer && (
					<AppendContextButton
						subjectLabel={item.name}
						getPayload={() => onInsertToComposer(item)}
						errorTitle="Couldn't insert check"
						className={appendActionButtonClassName}
					/>
				)}
				{item.url && (
					<Button
						type="button"
						variant="ghost"
						size="icon-xs"
						aria-label={`Open ${item.name}`}
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
	}
}
