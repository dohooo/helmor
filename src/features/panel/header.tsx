import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	AlertCircle,
	ArrowRight,
	Check,
	ChevronDown,
	Clock3,
	Copy,
	GitBranch,
	History,
	Pencil,
	Plus,
	RotateCcw,
	Trash2,
	X,
} from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { BranchPickerPopover } from "@/components/branch-picker";
import { HelmorThinkingIndicator } from "@/components/helmor-thinking-indicator";
import { ClaudeIcon, OpenAIIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { HyperText } from "@/components/ui/hyper-text";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import {
	type AgentProvider,
	createSession,
	deleteSession,
	listRemoteBranches,
	loadHiddenSessions,
	type PullRequestInfo,
	prefetchRemoteRefs,
	renameSession,
	renameWorkspaceBranch,
	unhideSession,
	updateIntendedTargetBranch,
	type WorkspaceDetail,
	type WorkspaceSessionSummary,
} from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import { cn } from "@/lib/utils";
import {
	getWorkspaceBranchTone,
	type WorkspaceBranchTone,
} from "@/lib/workspace-helpers";
import { useWorkspaceToast } from "@/lib/workspace-toast-context";
import { seedNewSessionInCache } from "./session-cache";
import { closeWorkspaceSession } from "./session-close";

type WorkspacePanelHeaderProps = {
	workspace: WorkspaceDetail | null;
	prInfo?: PullRequestInfo | null;
	sessions: WorkspaceSessionSummary[];
	selectedSessionId: string | null;
	sessionDisplayProviders?: Record<string, AgentProvider>;
	sending: boolean;
	sendingSessionIds?: Set<string>;
	completedSessionIds?: Set<string>;
	interactionRequiredSessionIds?: Set<string>;
	loadingWorkspace: boolean;
	headerActions?: React.ReactNode;
	headerLeading?: React.ReactNode;
	onSelectSession?: (sessionId: string) => void;
	onPrefetchSession?: (sessionId: string) => void;
	onSessionsChanged?: () => void;
	onSessionRenamed?: (sessionId: string, title: string) => void;
	onWorkspaceChanged?: () => void;
};

export const WorkspacePanelHeader = memo(function WorkspacePanelHeader({
	workspace,
	prInfo = null,
	sessions,
	selectedSessionId,
	sessionDisplayProviders,
	sending,
	sendingSessionIds,
	completedSessionIds,
	interactionRequiredSessionIds,
	loadingWorkspace,
	headerActions,
	headerLeading,
	onSelectSession,
	onPrefetchSession,
	onSessionsChanged,
	onSessionRenamed,
	onWorkspaceChanged,
}: WorkspacePanelHeaderProps) {
	const branchTone = getWorkspaceBranchTone({
		workspaceState: workspace?.state,
		manualStatus: workspace?.manualStatus,
		derivedStatus: workspace?.derivedStatus,
		prInfo,
	});
	const [showHistory, setShowHistory] = useState(false);
	const [hiddenSessions, setHiddenSessions] = useState<
		WorkspaceSessionSummary[]
	>([]);
	const pushToast = useWorkspaceToast();
	const queryClient = useQueryClient();
	const branchesQuery = useQuery({
		queryKey: ["remoteBranches", workspace?.id],
		queryFn: () => listRemoteBranches({ workspaceId: workspace!.id }),
		enabled: false,
		staleTime: 5 * 60 * 1000,
		gcTime: 10 * 60 * 1000,
	});
	const remoteBranches = branchesQuery.data ?? [];
	const loadingBranches = branchesQuery.isFetching;
	const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
	const [editingTitle, setEditingTitle] = useState("");
	const [editingBranch, setEditingBranch] = useState<string | null>(null);
	const [branchCopied, setBranchCopied] = useState(false);
	const tabsScrollRef = useRef<HTMLDivElement>(null);
	const [hasRightOverflow, setHasRightOverflow] = useState(false);

	const updateOverflow = useCallback(() => {
		const el = tabsScrollRef.current;
		if (!el) return;
		setHasRightOverflow(el.scrollWidth - el.scrollLeft - el.clientWidth > 1);
	}, []);

	useEffect(() => {
		const el = tabsScrollRef.current;
		if (!el) return;
		updateOverflow();
		const ro = new ResizeObserver(updateOverflow);
		ro.observe(el);
		return () => ro.disconnect();
	}, [updateOverflow, sessions.length]);

	const handleStartBranchRename = useCallback(() => {
		if (!workspace?.branch) {
			return;
		}
		setEditingBranch(workspace.branch);
	}, [workspace?.branch]);

	const handleCommitBranchRename = useCallback(async () => {
		if (editingBranch === null || !workspace) {
			return;
		}
		const trimmed = editingBranch.trim();
		if (trimmed && trimmed !== workspace.branch) {
			const detailKey = helmorQueryKeys.workspaceDetail(workspace.id);
			const previous = queryClient.getQueryData<WorkspaceDetail | null>(
				detailKey,
			);
			if (previous) {
				queryClient.setQueryData<WorkspaceDetail | null>(detailKey, {
					...previous,
					branch: trimmed,
				});
			}
			try {
				await renameWorkspaceBranch(workspace.id, trimmed);
				onWorkspaceChanged?.();
			} catch (error: unknown) {
				if (previous) {
					queryClient.setQueryData<WorkspaceDetail | null>(detailKey, previous);
				}
				pushToast(
					error instanceof Error ? error.message : String(error),
					"Branch rename failed",
					"destructive",
				);
			}
		}
		setEditingBranch(null);
	}, [editingBranch, onWorkspaceChanged, pushToast, queryClient, workspace]);

	const handleCancelBranchRename = useCallback(() => {
		setEditingBranch(null);
	}, []);

	const handleCreateSession = useCallback(async () => {
		if (!workspace) {
			return;
		}
		try {
			const result = await createSession(workspace.id);
			seedNewSessionInCache({
				queryClient,
				workspaceId: workspace.id,
				sessionId: result.sessionId,
				workspace,
				existingSessions: sessions,
				createdAt: new Date().toISOString(),
			});

			onSessionsChanged?.();
			onSelectSession?.(result.sessionId);
		} catch (error) {
			console.error("Failed to create session:", error);
		}
	}, [onSelectSession, onSessionsChanged, queryClient, sessions, workspace]);

	const handleHideSession = useCallback(
		async (sessionId: string, event: React.MouseEvent) => {
			event.stopPropagation();
			if (!workspace) {
				return;
			}

			await closeWorkspaceSession({
				queryClient,
				workspace,
				sessions,
				sessionId,
				onSelectSession,
				onSessionsChanged,
				pushToast,
			});
		},
		[
			onSelectSession,
			onSessionsChanged,
			pushToast,
			queryClient,
			sessions,
			workspace,
		],
	);

	const handleToggleHistory = useCallback(
		async (open: boolean) => {
			if (open && workspace) {
				const hidden = await loadHiddenSessions(workspace.id);
				setHiddenSessions(hidden);
			}
			setShowHistory(open);
		},
		[workspace],
	);

	const handleUnhide = useCallback(
		async (sessionId: string) => {
			await unhideSession(sessionId);
			setHiddenSessions((current) => {
				const next = current.filter((session) => session.id !== sessionId);
				if (next.length === 0) {
					setShowHistory(false);
				}
				return next;
			});
			onSessionsChanged?.();
			onSelectSession?.(sessionId);
		},
		[onSelectSession, onSessionsChanged],
	);

	const handleDelete = useCallback(
		async (sessionId: string) => {
			await deleteSession(sessionId);
			setHiddenSessions((current) => {
				const next = current.filter((session) => session.id !== sessionId);
				if (next.length === 0) {
					setShowHistory(false);
				}
				return next;
			});
			onSessionsChanged?.();
		},
		[onSessionsChanged],
	);

	const handleStartRename = useCallback(
		(session: WorkspaceSessionSummary, event: React.MouseEvent) => {
			event.stopPropagation();
			setEditingSessionId(session.id);
			setEditingTitle(displaySessionTitle(session));
		},
		[],
	);

	const handleCommitRename = useCallback(async () => {
		if (!editingSessionId) {
			return;
		}
		const trimmed = editingTitle.trim();
		if (trimmed) {
			await renameSession(editingSessionId, trimmed);
			onSessionRenamed?.(editingSessionId, trimmed);
		}
		setEditingSessionId(null);
		setEditingTitle("");
	}, [editingSessionId, editingTitle, onSessionRenamed]);

	const handleCancelRename = useCallback(() => {
		setEditingSessionId(null);
		setEditingTitle("");
	}, []);

	return (
		<header className="relative z-20">
			<div
				aria-label="Workspace header"
				className="flex h-9 items-center justify-between gap-3 px-[18px]"
				data-tauri-drag-region
			>
				<div className="flex min-w-0 items-center gap-2 text-[12.5px]">
					{headerLeading}
					<span className="group/branch relative inline-flex items-center gap-1 overflow-hidden px-1 py-0.5 font-medium text-foreground">
						<GitBranch
							className={cn(
								"size-3.5 shrink-0",
								getBranchToneClassName(branchTone),
							)}
							strokeWidth={1.9}
						/>
						{editingBranch !== null ? (
							<Input
								autoFocus
								value={editingBranch}
								onChange={(event) => setEditingBranch(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "Enter") {
										event.preventDefault();
										void handleCommitBranchRename();
									} else if (event.key === "Escape") {
										handleCancelBranchRename();
									}
								}}
								onBlur={() => void handleCommitBranchRename()}
								onClick={(event) => event.stopPropagation()}
								className="h-5 w-32 truncate rounded-md border-border bg-background px-1.5 py-0 text-[12.5px] font-medium text-foreground"
							/>
						) : (
							<>
								<HyperText
									key={workspace?.id}
									text={workspace?.branch ?? "No branch"}
									className="truncate"
								/>
								{workspace?.branch && workspace.state !== "archived" ? (
									<span className="pointer-events-none invisible absolute inset-y-0 right-0 flex items-center gap-0.5 bg-[linear-gradient(to_right,transparent_0%,var(--background)_35%,var(--background)_100%)] pl-5 pr-1 group-hover/branch:pointer-events-auto group-hover/branch:visible">
										<span
											role="button"
											aria-label="Rename branch"
											onClick={handleStartBranchRename}
											className="flex cursor-pointer items-center justify-center rounded-sm p-0.5 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
										>
											<Pencil className="size-3" strokeWidth={2} />
										</span>
										<span
											role="button"
											aria-label="Copy branch name"
											onClick={() => {
												if (!workspace.branch) {
													return;
												}
												void navigator.clipboard.writeText(workspace.branch);
												setBranchCopied(true);
												setTimeout(() => setBranchCopied(false), 1500);
											}}
											className="flex cursor-pointer items-center justify-center rounded-sm p-0.5 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
										>
											{branchCopied ? (
												<Check
													className="size-3 text-green-400"
													strokeWidth={2}
												/>
											) : (
												<Copy className="size-3" strokeWidth={2} />
											)}
										</span>
									</span>
								) : null}
							</>
						)}
					</span>
					{workspace?.intendedTargetBranch ? (
						<>
							<ArrowRight
								className="relative top-px size-3 shrink-0 self-center text-muted-foreground"
								strokeWidth={1.8}
							/>
							{workspace.state === "archived" ? (
								<span className="px-1 py-0.5 font-medium text-muted-foreground">
									{workspace.remote ?? "origin"}/
									{workspace.intendedTargetBranch}
								</span>
							) : (
								<BranchPicker
									currentBranch={workspace.intendedTargetBranch ?? ""}
									displayRemote={workspace.remote ?? "origin"}
									branches={remoteBranches}
									loading={loadingBranches}
									onOpen={() => {
										void branchesQuery.refetch();
										void prefetchRemoteRefs({ workspaceId: workspace.id })
											.then((result) => {
												if (result.fetched) {
													void branchesQuery.refetch();
												}
											})
											.catch(() => {});
									}}
									onSelect={(branch: string) => {
										if (branch === workspace.intendedTargetBranch) {
											return;
										}
										const detailKey = helmorQueryKeys.workspaceDetail(
											workspace.id,
										);
										const previousDetail =
											queryClient.getQueryData<WorkspaceDetail | null>(
												detailKey,
											);
										if (previousDetail) {
											queryClient.setQueryData<WorkspaceDetail | null>(
												detailKey,
												{
													...previousDetail,
													intendedTargetBranch: branch,
												},
											);
										}

										// Invalidate changes so diff section shows loading.
										if (workspace.rootPath) {
											void queryClient.invalidateQueries({
												queryKey: helmorQueryKeys.workspaceChanges(
													workspace.rootPath,
												),
											});
										}

										void updateIntendedTargetBranch(workspace.id, branch)
											.then(({ reset }) => {
												onWorkspaceChanged?.();
												if (workspace.rootPath) {
													void queryClient.invalidateQueries({
														queryKey: helmorQueryKeys.workspaceChanges(
															workspace.rootPath,
														),
													});
												}
												if (reset) {
													pushToast(
														`Local branch reset to ${workspace.remote ?? "origin"}/${branch}`,
														`Switched to ${branch}`,
														"default",
													);
												} else {
													pushToast(
														"Target branch updated",
														`Switched to ${branch}`,
														"default",
													);
												}
											})
											.catch((error: unknown) => {
												if (previousDetail) {
													queryClient.setQueryData<WorkspaceDetail | null>(
														detailKey,
														previousDetail,
													);
												}
												pushToast(
													error instanceof Error
														? error.message
														: String(error),
													"Branch switch failed",
													"destructive",
												);
											});
									}}
								/>
							)}
						</>
					) : null}
				</div>
				{headerActions ? (
					<div className="flex shrink-0 items-center gap-1">
						{headerActions}
					</div>
				) : null}
			</div>

			<div className="flex items-center px-4 pb-1">
				<div className="group/tabs-scroll relative min-w-0 flex-1">
					{hasRightOverflow && (
						<div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-12 bg-gradient-to-l from-background to-transparent" />
					)}
					<div
						ref={tabsScrollRef}
						onScroll={updateOverflow}
						className="scrollbar-none min-w-0 flex-1 overflow-x-auto"
					>
						{loadingWorkspace ? (
							<div className="flex h-[1.85rem] items-center gap-1.5 px-2 text-[12px] text-muted-foreground">
								<Clock3 className="size-3 animate-pulse" strokeWidth={1.8} />
								Loading
							</div>
						) : sessions.length > 0 ? (
							<Tabs
								value={selectedSessionId ?? sessions[0]?.id}
								onValueChange={(value) => {
									onSelectSession?.(value);
								}}
								className="min-w-max gap-0"
							>
								<TabsList
									aria-label="Sessions"
									className="inline-flex min-w-full w-max justify-start self-start"
								>
									{sessions.map((session) => {
										const selected = session.id === selectedSessionId;
										const isActivelySending = sendingSessionIds
											? sendingSessionIds.has(session.id)
											: selected && sending;
										const hasUnread = session.unreadCount > 0;
										const isCompleted =
											completedSessionIds?.has(session.id) ?? false;
										const isInteractionRequired =
											interactionRequiredSessionIds?.has(session.id) ?? false;
										const isActive =
											isActivelySending && !isInteractionRequired;
										const hasStatusDot =
											isInteractionRequired ||
											(!selected && (hasUnread || isCompleted));
										const isEditing = editingSessionId === session.id;

										return (
											<Tooltip key={session.id}>
												<TooltipTrigger asChild>
													<TabsTrigger
														value={session.id}
														onMouseEnter={() => {
															onPrefetchSession?.(session.id);
														}}
														onFocus={() => {
															onPrefetchSession?.(session.id);
														}}
														className="group/tab relative h-full w-auto max-w-[14rem] shrink-0 flex-none justify-start gap-1.5 overflow-hidden pr-5 text-[13px] text-muted-foreground data-[state=active]:text-foreground"
													>
														{/* Content wrapper: text fades out on the right when hovered so
														    the action icons can sit on the tab's own background. */}
														<span className="tab-content-fade flex min-w-0 flex-1 items-center gap-1.5">
															<SessionProviderIcon
																agentType={
																	sessionDisplayProviders?.[session.id] ??
																	session.agentType
																}
																active={isActive}
															/>
															{isEditing ? (
																<Input
																	autoFocus
																	value={editingTitle}
																	onChange={(event) =>
																		setEditingTitle(event.target.value)
																	}
																	onKeyDown={(event) => {
																		if (event.key === "Enter") {
																			event.preventDefault();
																			void handleCommitRename();
																		} else if (event.key === "Escape") {
																			handleCancelRename();
																		}
																	}}
																	onBlur={() => void handleCommitRename()}
																	onClick={(event) => event.stopPropagation()}
																	className="h-6 w-20 truncate rounded-md border-border bg-background px-1.5 py-0 text-[13px] font-medium text-foreground"
																/>
															) : (
																<span
																	className={cn(
																		"truncate font-medium",
																		hasStatusDot && !selected
																			? "text-foreground"
																			: undefined,
																	)}
																>
																	{displaySessionTitle(session)}
																</span>
															)}
															{hasStatusDot && !isEditing ? (
																<span
																	aria-label={
																		isInteractionRequired
																			? "Interaction required"
																			: isCompleted
																				? "Session completed"
																				: "Unread session"
																	}
																	className={cn(
																		"size-1.5 shrink-0 rounded-full",
																		isInteractionRequired
																			? "bg-yellow-500"
																			: "bg-chart-2",
																	)}
																/>
															) : null}
														</span>
														{!isEditing ? (
															<span className="pointer-events-none invisible absolute inset-y-0 right-0 flex items-center gap-0.5 pr-1 group-hover/tab:pointer-events-auto group-hover/tab:visible">
																<span
																	role="button"
																	aria-label="Rename session"
																	onClick={(event) =>
																		handleStartRename(session, event)
																	}
																	className="flex cursor-pointer items-center justify-center rounded-sm p-0.5 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
																>
																	<Pencil className="size-3" strokeWidth={2} />
																</span>
																<span
																	role="button"
																	aria-label="Close session"
																	onClick={(event) =>
																		handleHideSession(session.id, event)
																	}
																	className="flex cursor-pointer items-center justify-center rounded-sm p-0.5 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
																>
																	<X className="size-3" strokeWidth={2} />
																</span>
															</span>
														) : null}
													</TabsTrigger>
												</TooltipTrigger>
												<TooltipContent
													side="bottom"
													sideOffset={8}
													className="flex h-[22px] items-center rounded-md px-1.5 text-[11px] leading-none"
												>
													<span>{displaySessionTitle(session)}</span>
												</TooltipContent>
											</Tooltip>
										);
									})}
								</TabsList>
							</Tabs>
						) : (
							<div className="flex h-[1.85rem] items-center gap-1.5 px-2 text-[12px] text-muted-foreground">
								<AlertCircle className="size-3" strokeWidth={1.8} />
								No sessions
							</div>
						)}
					</div>
				</div>

				<Button
					aria-label="New session"
					onClick={handleCreateSession}
					variant="ghost"
					size="icon-sm"
					className="ml-0.5 shrink-0 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
				>
					<Plus className="size-3.5" strokeWidth={1.8} />
				</Button>

				<DropdownMenu open={showHistory} onOpenChange={handleToggleHistory}>
					<DropdownMenuTrigger asChild>
						<Button
							aria-label="Session history"
							variant="ghost"
							size="icon-sm"
							className={cn(
								"ml-1 shrink-0 text-muted-foreground hover:bg-accent/60 hover:text-foreground focus-visible:border-transparent focus-visible:ring-0",
								showHistory && "bg-accent/60 text-foreground",
							)}
						>
							<History className="size-3.5" strokeWidth={1.8} />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="w-56">
						{hiddenSessions.length > 0 ? (
							hiddenSessions.map((session) => (
								<Tooltip key={session.id}>
									<TooltipTrigger asChild>
										<div className="flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-[12px] text-muted-foreground hover:bg-accent/60">
											<div className="flex min-w-0 items-center gap-1.5">
												<SessionProviderIcon
													agentType={session.agentType}
													active={false}
												/>
												<span className="truncate">
													{displaySessionTitle(session)}
												</span>
											</div>
											<div className="flex shrink-0 items-center gap-0.5">
												<Button
													aria-label="Restore session"
													onClick={() => handleUnhide(session.id)}
													variant="ghost"
													size="icon-xs"
													className="text-muted-foreground hover:text-foreground"
												>
													<RotateCcw className="size-3" strokeWidth={1.8} />
												</Button>
												<Button
													aria-label="Delete session permanently"
													onClick={() => handleDelete(session.id)}
													variant="ghost"
													size="icon-xs"
													className="text-muted-foreground hover:text-destructive"
												>
													<Trash2 className="size-3" strokeWidth={1.8} />
												</Button>
											</div>
										</div>
									</TooltipTrigger>
									<TooltipContent
										side="left"
										sideOffset={8}
										className="flex h-[22px] items-center rounded-md px-1.5 text-[11px] leading-none"
									>
										<span>{displaySessionTitle(session)}</span>
									</TooltipContent>
								</Tooltip>
							))
						) : (
							<div className="px-2.5 py-1.5 text-[11px] text-muted-foreground">
								No hidden sessions
							</div>
						)}
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
		</header>
	);
});

function getBranchToneClassName(tone: WorkspaceBranchTone) {
	switch (tone) {
		case "open":
			return "text-[var(--workspace-branch-status-open)]";
		case "merged":
			return "text-[var(--workspace-branch-status-merged)]";
		case "closed":
			return "text-[var(--workspace-branch-status-closed)]";
		case "inactive":
			return "text-[var(--workspace-branch-status-inactive)]";
		default:
			return "text-[var(--workspace-branch-status-working)]";
	}
}

function SessionProviderIcon({
	agentType,
	active,
}: {
	agentType?: string | null;
	active: boolean;
}) {
	if (active) {
		return <HelmorThinkingIndicator size={14} />;
	}
	if (agentType === "codex") {
		return <OpenAIIcon className="size-3 shrink-0 text-muted-foreground" />;
	}
	return <ClaudeIcon className="size-3 shrink-0 text-muted-foreground" />;
}

function displaySessionTitle(session: WorkspaceSessionSummary): string {
	if (session.title && session.title !== "Untitled") {
		return session.title;
	}
	return "Untitled";
}

// BranchPicker: thin wrapper around shared BranchPickerPopover with header trigger styling.
function BranchPicker({
	currentBranch,
	displayRemote,
	branches,
	loading,
	onOpen,
	onSelect,
}: {
	currentBranch: string;
	displayRemote: string;
	branches: string[];
	loading: boolean;
	onOpen: () => void;
	onSelect: (branch: string) => void;
}) {
	return (
		<BranchPickerPopover
			currentBranch={currentBranch}
			branches={branches}
			loading={loading}
			onOpen={onOpen}
			onSelect={onSelect}
		>
			<Button
				type="button"
				variant="ghost"
				size="xs"
				className="h-6 max-w-[180px] gap-1 rounded-md px-1.5 text-[13px] font-medium text-muted-foreground hover:text-foreground"
			>
				<span className="truncate">
					{displayRemote}/{currentBranch}
				</span>
				<ChevronDown data-icon="inline-end" strokeWidth={2} />
			</Button>
		</BranchPickerPopover>
	);
}
