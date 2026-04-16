import { MarkGithubIcon } from "@primer/octicons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowUpRightIcon, CheckIcon, TriangleIcon } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import {
	AppendContextButton,
	type AppendContextPayloadResult,
} from "@/components/append-context-button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type {
	CommitButtonState,
	WorkspaceCommitButtonMode,
} from "@/features/commit/button";
import {
	type ActionProvider,
	type ActionStatusKind,
	getWorkspacePrCheckInsertText,
	type PullRequestInfo,
	syncWorkspaceWithTargetBranch,
	type WorkspaceGitActionStatus,
	type WorkspacePrActionItem,
	type WorkspacePrActionStatus,
} from "@/lib/api";
import { buildComposerPreviewPayload } from "@/lib/composer-insert";
import {
	helmorQueryKeys,
	workspaceGitActionStatusQueryOptions,
	workspacePrActionStatusQueryOptions,
} from "@/lib/query-client";
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

const EMPTY_GIT_ACTION_STATUS: WorkspaceGitActionStatus = {
	uncommittedCount: 0,
	conflictCount: 0,
	syncTargetBranch: null,
	syncStatus: "unknown",
	behindTargetCount: 0,
};

const EMPTY_PR_ACTION_STATUS: WorkspacePrActionStatus = {
	pr: null,
	reviewDecision: null,
	mergeable: null,
	deployments: [],
	checks: [],
	remoteState: "unavailable",
	message: null,
};

type ActionsSectionProps = {
	workspaceId: string | null;
	workspaceRemote?: string | null;
	sectionRef?: React.RefObject<HTMLElement | null>;
	bodyHeight: number;
	expanded: boolean;
	onCommitAction?: (mode: WorkspaceCommitButtonMode) => Promise<void>;
	commitButtonState?: CommitButtonState;
	prInfo: PullRequestInfo | null;
};

export function ActionsSection({
	workspaceId,
	workspaceRemote,
	sectionRef,
	bodyHeight,
	expanded,
	onCommitAction,
	commitButtonState,
	prInfo,
}: ActionsSectionProps) {
	const queryClient = useQueryClient();
	const [syncPending, setSyncPending] = useState(false);
	const gitStatusQuery = useQuery({
		...workspaceGitActionStatusQueryOptions(workspaceId ?? "__none__"),
		enabled: workspaceId !== null,
	});
	const prStatusQuery = useQuery({
		...workspacePrActionStatusQueryOptions(workspaceId ?? "__none__"),
		enabled: workspaceId !== null,
	});
	const gitStatus = gitStatusQuery.data ?? EMPTY_GIT_ACTION_STATUS;
	const prStatus = prStatusQuery.data ?? EMPTY_PR_ACTION_STATUS;
	const gitRows = buildGitRows(gitStatus, workspaceRemote);
	const reviewRows = buildReviewRows(prStatus, prInfo);
	const actionDisabled = commitButtonState === "busy";
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
				toast.error(`Conflicts detected while pulling ${target}`);
			}
		} catch (error) {
			const message =
				error instanceof Error
					? error.message
					: "Unable to pull target updates.";
			toast.error(message);
		} finally {
			await Promise.all([
				queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.workspaceGitActionStatus(workspaceId),
				}),
				queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.workspacePr(workspaceId),
				}),
				queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.workspacePrActionStatus(workspaceId),
				}),
				queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.workspaceDetail(workspaceId),
				}),
				queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.workspaceGroups,
				}),
				queryClient.invalidateQueries({ queryKey: ["workspaceChanges"] }),
			]);
			setSyncPending(false);
		}
	}, [queryClient, syncPending, workspaceId]);
	const handleInsertCheck = useCallback(
		async (item: WorkspacePrActionItem) => {
			if (!workspaceId) {
				return;
			}
			const submitText = await getWorkspacePrCheckInsertText(
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
			aria-label="Inspector section Actions"
			className={cn(
				"flex min-h-0 flex-col overflow-hidden border-b border-border/60 bg-sidebar",
				expanded && "flex-1",
			)}
		>
			<div className={INSPECTOR_SECTION_HEADER_CLASS}>
				<span className={INSPECTOR_SECTION_TITLE_CLASS}>Actions</span>
			</div>

			<ScrollArea
				aria-label="Actions panel body"
				className={cn("bg-muted/18 text-[11.5px]", expanded && "flex-1")}
				style={expanded ? undefined : { height: `${bodyHeight}px` }}
			>
				<div className="px-2.5 pb-1 pt-2">
					<span className="text-[10.5px] font-medium tracking-wide text-muted-foreground">
						Git
					</span>
				</div>
				{gitRows.map((item) => {
					const action = item.action;
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
									className="ml-auto shrink-0 cursor-pointer text-[10.5px] text-primary transition-colors hover:text-primary/80 disabled:cursor-not-allowed disabled:opacity-50"
									disabled={
										action.kind === "commit" ? actionDisabled : syncPending
									}
								>
									{action.kind === "sync" && syncPending
										? "Pulling..."
										: action.label}
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

				{prStatus.deployments.length > 0 && (
					<>
						<div className="px-2.5 pb-1 pt-2.5">
							<span className="text-[10.5px] font-medium tracking-wide text-muted-foreground">
								Deployments
							</span>
						</div>
						{prStatus.deployments.map((item) => (
							<ActionStatusRow key={item.id} item={item} />
						))}
					</>
				)}

				{prStatus.checks.length > 0 && (
					<>
						<div className="px-2.5 pb-1 pt-2.5">
							<span className="text-[10.5px] font-medium tracking-wide text-muted-foreground">
								Checks
							</span>
						</div>
						{prStatus.checks.map((item) => (
							<ActionStatusRow
								key={item.id}
								item={item}
								onInsertToComposer={handleInsertCheck}
							/>
						))}
					</>
				)}
			</ScrollArea>
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
	return (
		<MarkGithubIcon size={12} className="shrink-0 text-muted-foreground" />
	);
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
	prStatus: WorkspacePrActionStatus,
	prInfo: PullRequestInfo | null,
): GitStatusItem[] {
	const pr = prStatus.pr ?? prInfo;
	const isMerged = pr?.isMerged ?? false;
	const hasMergeConflict = prStatus.mergeable === "CONFLICTING";

	const rows: GitStatusItem[] = [];

	if (isMerged || prStatus.reviewDecision === "APPROVED") {
		rows.push({ label: "Review approved", status: "success" });
	} else if (pr?.state === "CLOSED") {
		rows.push({ label: "PR closed", status: "failure" });
	} else if (prStatus.reviewDecision === "CHANGES_REQUESTED") {
		rows.push({ label: "Changes requested", status: "failure" });
	} else if (prStatus.remoteState !== "noPr") {
		rows.push({ label: "Waiting for PR review", status: "pending" });
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
	item: WorkspacePrActionItem;
	onInsertToComposer?: (
		item: WorkspacePrActionItem,
	) => AppendContextPayloadResult | Promise<AppendContextPayloadResult>;
}) {
	return (
		<div className="group/check-row flex items-center justify-between gap-3 px-2.5 py-[3px] text-muted-foreground transition-colors hover:bg-accent/60">
			<div className="flex min-w-0 items-center gap-1.5">
				<StatusIcon status={item.status} />
				<ProviderIcon provider={item.provider} />
				<span className="truncate text-primary">{item.name}</span>
				{item.duration && (
					<span className="shrink-0 text-[10.5px] text-muted-foreground">
						{item.duration}
					</span>
				)}
			</div>
			<div className="flex shrink-0 items-center justify-end gap-1.5">
				{onInsertToComposer && (
					<AppendContextButton
						subjectLabel={item.name}
						getPayload={() => onInsertToComposer(item)}
						errorTitle="Couldn't insert check"
						className={cn(
							"text-primary hover:bg-accent/60 hover:text-primary",
							"opacity-0 group-hover/check-row:opacity-100 focus-visible:opacity-100",
						)}
					/>
				)}
				{item.url && (
					<button
						type="button"
						aria-label={`Open ${item.name}`}
						onClick={() => {
							if (!item.url) {
								return;
							}
							void openUrl(item.url);
						}}
						className="shrink-0 text-muted-foreground transition-colors hover:text-primary"
					>
						<ArrowUpRightIcon className="size-3" strokeWidth={1.8} />
					</button>
				)}
			</div>
		</div>
	);
}
