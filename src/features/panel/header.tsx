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
	Laptop,
	Layers,
	MessageCircle,
	Pencil,
	Plus,
	RotateCcw,
	Trash2,
	X,
} from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
	AccountHoverCardContent,
	accountInfoFromForgeAccount,
} from "@/components/account-hover-card-content";
import { BranchPickerPopover } from "@/components/branch-picker";
import { CachedAvatar } from "@/components/cached-avatar";
import { TrafficLightSpacer } from "@/components/chrome/traffic-light-spacer";
import { HelmorThinkingIndicator } from "@/components/helmor-thinking-indicator";
import {
	ClaudeIcon,
	CursorIcon,
	KimiIcon,
	MiMoCodeIcon,
	OpenAIIcon,
	OpenCodeIcon,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	HoverCard,
	HoverCardContent,
	HoverCardTrigger,
} from "@/components/ui/hover-card";
import { HyperText } from "@/components/ui/hyper-text";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { InlineShortcutDisplay } from "@/features/shortcuts/shortcut-display";
import {
	type AgentProvider,
	type ChangeRequestInfo,
	isCodexProvider,
	listRemoteBranches,
	prefetchRemoteRefs,
	updateIntendedTargetBranch,
	type WorkspaceDetail,
	type WorkspaceSessionSummary,
} from "@/lib/api";
import { I18nText, useI18n } from "@/lib/i18n";
import { initialsFor } from "@/lib/initials";
import {
	helmorQueryKeys,
	workspaceAccountProfileQueryOptions,
	workspaceDetailQueryOptions,
	workspaceForgeActionStatusQueryOptions,
} from "@/lib/query-client";
import type { ContextCard } from "@/lib/sources/types";
import { cn } from "@/lib/utils";
import {
	getWorkspaceBranchTone,
	type WorkspaceBranchTone,
} from "@/lib/workspace-helpers";
import { useWorkspaceToast } from "@/lib/workspace-toast-context";
import { useBranchRename } from "./header/use-branch-rename";
import { useHiddenHistory } from "./header/use-hidden-history";
import { useSessionActions } from "./header/use-session-actions";
import { isSessionRunningStatus } from "./session-running";
import type { SessionCloseRequest } from "./use-confirm-session-close";

type WorkspacePanelHeaderProps = {
	workspace: WorkspaceDetail | null;
	changeRequest?: ChangeRequestInfo | null;
	sessions: WorkspaceSessionSummary[];
	selectedSessionId: string | null;
	sessionDisplayProviders?: Record<string, AgentProvider>;
	sending: boolean;
	busySessionIds?: Set<string>;
	interactionRequiredSessionIds?: Set<string>;
	loadingWorkspace: boolean;
	contextPreviewCard?: ContextCard | null;
	contextPreviewActive?: boolean;
	headerActions?: React.ReactNode;
	headerLeading?: React.ReactNode;
	onSelectSession?: (sessionId: string) => void;
	onSelectContextPreview?: () => void;
	onCloseContextPreview?: () => void;
	onPrefetchSession?: (sessionId: string) => void;
	onSessionsChanged?: () => void;
	onSessionRenamed?: (sessionId: string, title: string) => void;
	onWorkspaceChanged?: () => void;
	onRequestCloseSession?: (request: SessionCloseRequest) => void;
	/** Navigate to another workspace by id (used by the stacked-PR parent
	 *  chip). Wired from the shell's selection controller. */
	onSelectWorkspace?: (workspaceId: string) => void;
	newSessionShortcut?: string | null;
};

const SESSION_TITLE_TOOLTIP_MAX_CHARS = 240;
const SESSION_TITLE_TOOLTIP_CLASS =
	"pointer-events-none max-w-[22rem] whitespace-normal rounded-md px-2 py-1.5 text-left text-mini leading-snug";
const SESSION_TITLE_TOOLTIP_TEXT_CLASS =
	"block max-w-full whitespace-normal break-words [overflow-wrap:anywhere]";

export const WorkspacePanelHeader = memo(function WorkspacePanelHeader({
	workspace,
	changeRequest = null,
	sessions,
	selectedSessionId,
	sessionDisplayProviders,
	sending,
	busySessionIds,
	interactionRequiredSessionIds,
	loadingWorkspace,
	contextPreviewCard = null,
	contextPreviewActive = false,
	headerActions,
	headerLeading,
	onSelectSession,
	onSelectContextPreview,
	onCloseContextPreview,
	onPrefetchSession,
	onSessionsChanged,
	onSessionRenamed,
	onWorkspaceChanged,
	onRequestCloseSession,
	onSelectWorkspace,
	newSessionShortcut,
}: WorkspacePanelHeaderProps) {
	const { t, f } = useI18n();
	const branchTone = getWorkspaceBranchTone({
		workspaceState: workspace?.state,
		status: workspace?.status,
		changeRequest,
	});
	const contextTabValue = "__context_preview__";
	const tabsValue = contextPreviewActive
		? contextTabValue
		: (selectedSessionId ?? sessions[0]?.id);
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
	const accountProfileQuery = useQuery(
		workspaceAccountProfileQueryOptions(
			workspace?.forgeLogin ? (workspace?.id ?? null) : null,
		),
	);
	const accountProfile = accountProfileQuery.data ?? null;
	const accountLogin = accountProfile?.login ?? workspace?.forgeLogin ?? null;
	const accountDisplayName = accountProfile?.name?.trim() || accountLogin || "";
	// Mirror the inspector's Connect-CTA condition: when the workspace is
	// in `unauthenticated` state, the bound `forgeLogin` no longer has
	// access (token revoked / removed account / etc.). Suppress the
	// avatar so it doesn't masquerade as another account while the
	// right-side panel asks the user to reconnect.
	const forgeStatusQuery = useQuery({
		...workspaceForgeActionStatusQueryOptions(workspace?.id ?? ""),
		enabled: !!workspace?.id,
	});
	const forgeNeedsConnect =
		forgeStatusQuery.data?.remoteState === "unauthenticated";

	const branchRename = useBranchRename({
		workspace,
		queryClient,
		pushToast,
		onWorkspaceChanged,
	});
	const hiddenHistory = useHiddenHistory({
		workspace,
		onSelectSession,
		onSessionsChanged,
	});
	const sessionActions = useSessionActions({
		workspace,
		sessions,
		selectedSessionId,
		sessionDisplayProviders,
		queryClient,
		pushToast,
		onSelectSession,
		onSessionsChanged,
		onSessionRenamed,
		onRequestCloseSession,
		onAfterDelete: hiddenHistory.pruneFromHistory,
	});

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

	const stopTabActionPointerDown = useCallback((event: React.PointerEvent) => {
		event.preventDefault();
		event.stopPropagation();
	}, []);

	return (
		<header className="relative z-20">
			<div
				aria-label={t("workspaceHeader")}
				className="flex h-9 items-center justify-between gap-3 px-[18px]"
				data-tauri-drag-region
			>
				<div
					data-tauri-drag-region
					className="relative z-0 flex min-w-0 flex-1 items-center gap-2 overflow-hidden text-small"
				>
					<TrafficLightSpacer
						side="left"
						width={48}
						className="hidden max-[960px]:block"
					/>
					{headerLeading}
					{workspace?.mode === "chat" ? (
						<span className="inline-flex items-center gap-1.5 overflow-hidden px-1 py-0.5 font-medium text-foreground">
							<MessageCircle
								className="size-3.5 shrink-0 text-muted-foreground"
								strokeWidth={1.9}
							/>
							{/* `workspace.title` is computed server-side by
							 *  `helpers::display_title`, the same source the
							 *  sidebar row + hover card use. Keeps the three
							 *  surfaces visually in sync without rebuilding
							 *  the precedence rules in TS. */}
							<span className="min-w-0 truncate">{workspace.title}</span>
						</span>
					) : (
						<>
							<span className="group/branch relative inline-flex items-center gap-1.5 overflow-hidden px-1 py-0.5 font-medium text-foreground">
								{(() => {
									// Avatar always wins when we have a URL AND the
									// workspace's bound account is still valid (mirrors the
									// right-side Connect CTA). Otherwise fall back to a
									// mode-appropriate glyph: Laptop for local, GitBranch
									// for worktree.
									const FallbackIcon =
										workspace?.mode === "local" ? Laptop : GitBranch;
									const showAvatar =
										accountProfile?.avatarUrl && !forgeNeedsConnect;
									const hoverInfo = showAvatar
										? accountInfoFromForgeAccount(accountProfile)
										: null;
									if (!showAvatar || !hoverInfo) {
										return (
											<FallbackIcon
												className={cn(
													"size-3.5 shrink-0",
													getBranchToneClassName(branchTone),
												)}
												strokeWidth={1.9}
											/>
										);
									}
									return (
										<HoverCard openDelay={120} closeDelay={80}>
											<HoverCardTrigger asChild>
												<span className="inline-flex">
													<CachedAvatar
														className="size-4 shrink-0 cursor-default"
														src={accountProfile?.avatarUrl}
														alt={accountLogin ?? ""}
														fallback={initialsFor(accountDisplayName)}
														fallbackClassName="bg-muted text-nano font-semibold uppercase text-muted-foreground"
													/>
												</span>
											</HoverCardTrigger>
											<HoverCardContent
												side="bottom"
												align="start"
												sideOffset={8}
												className="w-auto max-w-[260px] p-3"
											>
												<AccountHoverCardContent account={hoverInfo} />
											</HoverCardContent>
										</HoverCard>
									);
								})()}
								{branchRename.editingBranch !== null ? (
									<Input
										autoFocus
										value={branchRename.editingBranch}
										onChange={(event) =>
											branchRename.setEditingBranch(event.target.value)
										}
										onKeyDown={(event) => {
											if (event.key === "Enter") {
												event.preventDefault();
												void branchRename.commitBranchRename();
											} else if (event.key === "Escape") {
												branchRename.cancelBranchRename();
											}
										}}
										onBlur={() => void branchRename.commitBranchRename()}
										onClick={(event) => event.stopPropagation()}
										className="h-5 w-32 truncate rounded-md border-border bg-background px-1.5 py-0 text-small font-medium text-foreground"
									/>
								) : (
									<>
										<HyperText
											key={workspace?.id}
											text={workspace?.branch ?? t("panelNoBranch")}
											className="truncate"
										/>
										{workspace?.branch && workspace.state !== "archived" ? (
											<span className="pointer-events-none invisible absolute inset-y-0 right-0 flex items-center gap-0.5 bg-[linear-gradient(to_right,transparent_0%,var(--background)_35%,var(--background)_100%)] pl-5 pr-1 group-hover/branch:pointer-events-auto group-hover/branch:visible">
												<span
													role="button"
													aria-label={t("renameBranch")}
													onClick={branchRename.startBranchRename}
													className="flex cursor-interactive items-center justify-center rounded-sm p-0.5 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
												>
													<Pencil className="size-3" strokeWidth={2} />
												</span>
												<span
													role="button"
													aria-label={t("copyBranchName")}
													onClick={branchRename.copyBranchName}
													className="flex cursor-interactive items-center justify-center rounded-sm p-0.5 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
												>
													{branchRename.branchCopied ? (
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
							{workspace?.parentWorkspaceId ? (
								<StackParentChip
									parentWorkspaceId={workspace.parentWorkspaceId}
									fallbackBranch={workspace.intendedTargetBranch}
									displayRemote={workspace.remote ?? "origin"}
									archived={workspace.state === "archived"}
									onSelectWorkspace={onSelectWorkspace}
								/>
							) : workspace?.intendedTargetBranch ? (
								<>
									<ArrowRight
										className="relative top-px size-3 shrink-0 self-center text-muted-foreground"
										strokeWidth={1.8}
									/>
									{workspace.state === "archived" ? (
										<span className="min-w-0 truncate px-1 py-0.5 font-medium text-muted-foreground">
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
														() => ({
															...previousDetail,
															intendedTargetBranch: branch,
														}),
													);
												}

												// Invalidate changes so diff section shows loading.
												if (workspace.rootPath) {
													void queryClient.invalidateQueries({
														queryKey: helmorQueryKeys.workspaceChanges(
															workspace.rootPath,
															workspace.id,
														),
													});
												}

												void updateIntendedTargetBranch(workspace.id, branch)
													.then(({ reset }) => {
														onWorkspaceChanged?.();
														// Recompute sync status vs. new target now; don't wait for 10s poll.
														void queryClient.invalidateQueries({
															queryKey:
																helmorQueryKeys.workspaceGitActionStatus(
																	workspace.id,
																),
														});
														if (workspace.rootPath) {
															void queryClient.invalidateQueries({
																queryKey: helmorQueryKeys.workspaceChanges(
																	workspace.rootPath,
																	workspace.id,
																),
															});
														}
														if (reset) {
															pushToast(
																f("panelLocalBranchReset", {
																	remote: workspace.remote ?? "origin",
																	branch,
																}),
																f("panelSwitchedToBranch", { branch }),
																"default",
															);
														} else {
															pushToast(
																t("panelTargetBranchUpdated"),
																f("panelSwitchedToBranch", { branch }),
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
															t("panelBranchSwitchFailed"),
															"destructive",
														);
													});
											}}
										/>
									)}
								</>
							) : null}
						</>
					)}
				</div>
				{headerActions ? (
					<div className="relative z-10 flex shrink-0 items-center gap-1 bg-background pl-1">
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
							<div className="flex h-[1.85rem] items-center gap-1.5 px-2 text-small text-muted-foreground">
								<Clock3 className="size-3 animate-pulse" strokeWidth={1.8} />
								<I18nText source="loading" />
							</div>
						) : sessions.length > 0 || contextPreviewCard ? (
							<Tabs
								value={tabsValue}
								onValueChange={(value) => {
									if (value === contextTabValue) {
										onSelectContextPreview?.();
										return;
									}
									onSelectSession?.(value);
								}}
								className="min-w-max gap-0"
							>
								<TabsList
									aria-label={t("sessions")}
									className="inline-flex min-w-full w-max justify-start self-start"
								>
									{contextPreviewCard ? (
										<Tooltip>
											<TooltipTrigger asChild>
												<TabsTrigger
													value={contextTabValue}
													aria-label={t("contextPreview")}
													onKeyDownCapture={(event) => {
														if (
															event.key.toLowerCase() !== "w" ||
															(!event.metaKey && !event.ctrlKey)
														) {
															return;
														}
														event.preventDefault();
														event.stopPropagation();
														onCloseContextPreview?.();
													}}
													className="group/tab relative h-full w-auto min-w-[6.5rem] max-w-[14rem] shrink-0 flex-none justify-start gap-1.5 overflow-hidden pr-5 text-ui text-muted-foreground data-[state=active]:text-foreground"
												>
													<span className="tab-content-fade flex min-w-0 flex-1 items-center gap-1.5">
														<Layers className="size-3.5" strokeWidth={1.8} />
														<span className="truncate font-medium">
															{contextPreviewCard.title}
														</span>
													</span>
													<span className="pointer-events-none invisible absolute inset-y-0 right-0 flex items-center pr-1 group-hover/tab:pointer-events-auto group-hover/tab:visible">
														<span
															role="button"
															aria-label={t("closeContextPreview")}
															onPointerDown={stopTabActionPointerDown}
															onClick={(event) => {
																event.preventDefault();
																event.stopPropagation();
																onCloseContextPreview?.();
															}}
															className="flex cursor-interactive items-center justify-center rounded-sm p-0.5 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
														>
															<X className="size-3" strokeWidth={2} />
														</span>
													</span>
												</TabsTrigger>
											</TooltipTrigger>
											<TooltipContent
												side="bottom"
												sideOffset={4}
												className={SESSION_TITLE_TOOLTIP_CLASS}
											>
												<span className={SESSION_TITLE_TOOLTIP_TEXT_CLASS}>
													{displayTooltipTitle(contextPreviewCard.title)}
												</span>
											</TooltipContent>
										</Tooltip>
									) : null}
									{sessions.map((session) => {
										const selected = session.id === selectedSessionId;
										const isActivelySending =
											busySessionIds?.has(session.id) === true ||
											isSessionRunningStatus(session.status) ||
											(selected && sending);
										const hasUnread = session.unreadCount > 0;
										const isInteractionRequired =
											interactionRequiredSessionIds?.has(session.id) ?? false;
										const isActive =
											isActivelySending && !isInteractionRequired;
										const hasStatusDot =
											isInteractionRequired || (!selected && hasUnread);
										const isEditing =
											sessionActions.editingSessionId === session.id;

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
														className="group/tab relative h-full w-auto min-w-[6.5rem] max-w-[14rem] shrink-0 flex-none justify-start gap-1.5 overflow-hidden pr-5 text-ui text-muted-foreground data-[state=active]:text-foreground"
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
																	value={sessionActions.editingTitle}
																	onChange={(event) =>
																		sessionActions.setEditingTitle(
																			event.target.value,
																		)
																	}
																	onKeyDown={(event) => {
																		if (event.key === "Enter") {
																			event.preventDefault();
																			void sessionActions.commitRename();
																		} else if (event.key === "Escape") {
																			sessionActions.cancelRename();
																		}
																	}}
																	onBlur={() =>
																		void sessionActions.commitRename()
																	}
																	onClick={(event) => event.stopPropagation()}
																	className="h-auto min-w-0 flex-1 truncate border-0 bg-transparent px-0 py-0 text-ui font-medium text-inherit shadow-none outline-none focus-visible:border-transparent focus-visible:ring-0 focus-visible:outline-none"
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
																			? t("interactionRequired")
																			: t("unreadSession")
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
																	aria-label={t("renameSession")}
																	onPointerDown={stopTabActionPointerDown}
																	onClick={(event) =>
																		sessionActions.startRename(session, event)
																	}
																	className="flex cursor-interactive items-center justify-center rounded-sm p-0.5 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
																>
																	<Pencil className="size-3" strokeWidth={2} />
																</span>
																<span
																	role="button"
																	aria-label={t("closeSession")}
																	onPointerDown={stopTabActionPointerDown}
																	onClick={(event) =>
																		sessionActions.hideSession(
																			session.id,
																			event,
																		)
																	}
																	className="flex cursor-interactive items-center justify-center rounded-sm p-0.5 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
																>
																	<X className="size-3" strokeWidth={2} />
																</span>
															</span>
														) : null}
													</TabsTrigger>
												</TooltipTrigger>
												{!isEditing ? (
													<TooltipContent
														side="bottom"
														sideOffset={4}
														className={SESSION_TITLE_TOOLTIP_CLASS}
													>
														<span className={SESSION_TITLE_TOOLTIP_TEXT_CLASS}>
															{displayTooltipTitle(
																displaySessionTitle(session),
															)}
														</span>
													</TooltipContent>
												) : null}
											</Tooltip>
										);
									})}
								</TabsList>
							</Tabs>
						) : (
							<div className="flex h-[1.85rem] items-center gap-1.5 px-2 text-small text-muted-foreground">
								<AlertCircle className="size-3" strokeWidth={1.8} />
								<I18nText source="noSessions" />
							</div>
						)}
					</div>
				</div>

				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							aria-label="newSession"
							onClick={() => void sessionActions.createSession()}
							variant="ghost"
							size="icon-sm"
							className="ml-0.5 shrink-0 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
						>
							<Plus className="size-3.5" strokeWidth={1.8} />
						</Button>
					</TooltipTrigger>
					<TooltipContent
						side="bottom"
						sideOffset={4}
						className="flex h-[24px] items-center gap-2 rounded-md px-2 text-small leading-none"
					>
						<span>
							<I18nText source="newSession" />
						</span>
						{newSessionShortcut ? (
							<InlineShortcutDisplay
								hotkey={newSessionShortcut}
								className="text-background/60"
							/>
						) : null}
					</TooltipContent>
				</Tooltip>

				<DropdownMenu
					open={hiddenHistory.showHistory}
					onOpenChange={hiddenHistory.toggleHistory}
				>
					<DropdownMenuTrigger asChild>
						<Button
							aria-label="sessionHistory"
							variant="ghost"
							size="icon-sm"
							className={cn(
								"ml-1 shrink-0 text-muted-foreground hover:bg-accent/60 hover:text-foreground focus-visible:border-transparent focus-visible:ring-0",
								hiddenHistory.showHistory && "bg-accent/60 text-foreground",
							)}
						>
							<History className="size-3.5" strokeWidth={1.8} />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent
						align="end"
						className="max-h-96 w-56 overscroll-contain"
					>
						{hiddenHistory.hiddenSessions.length > 0 ? (
							hiddenHistory.hiddenSessions.map((session) => (
								<Tooltip key={session.id}>
									<TooltipTrigger asChild>
										<div className="flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-small text-muted-foreground hover:bg-accent/60">
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
													aria-label="restoreSession"
													onClick={() => hiddenHistory.unhide(session.id)}
													variant="ghost"
													size="icon-xs"
													className="text-muted-foreground hover:text-foreground"
												>
													<RotateCcw className="size-3" strokeWidth={1.8} />
												</Button>
												<Button
													aria-label="deleteSessionPermanently"
													onClick={() =>
														sessionActions.deleteHiddenSession(session.id)
													}
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
										sideOffset={4}
										className={SESSION_TITLE_TOOLTIP_CLASS}
									>
										<span className={SESSION_TITLE_TOOLTIP_TEXT_CLASS}>
											{displayTooltipTitle(displaySessionTitle(session))}
										</span>
									</TooltipContent>
								</Tooltip>
							))
						) : (
							<div className="px-2.5 py-1.5 text-mini text-muted-foreground">
								<I18nText source="noHiddenSessions" />
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
	if (isCodexProvider(agentType)) {
		return <OpenAIIcon className="size-3 shrink-0 text-muted-foreground" />;
	}
	if (agentType === "cursor") {
		return <CursorIcon className="size-3 shrink-0 text-muted-foreground" />;
	}
	if (agentType === "opencode") {
		return <OpenCodeIcon className="size-3 shrink-0 text-muted-foreground" />;
	}
	if (agentType === "kimi") {
		return <KimiIcon className="size-3 shrink-0 text-muted-foreground" />;
	}
	if (agentType === "mimo") {
		return <MiMoCodeIcon className="size-3 shrink-0 text-muted-foreground" />;
	}
	return <ClaudeIcon className="size-3 shrink-0 text-muted-foreground" />;
}

function displaySessionTitle(session: WorkspaceSessionSummary): string {
	if (session.title && session.title !== "Untitled") {
		return session.title;
	}
	return "Untitled";
}

function displayTooltipTitle(title: string): string {
	const normalized = title.trim().replace(/\s+/g, " ");
	const chars = Array.from(normalized);
	if (chars.length <= SESSION_TITLE_TOOLTIP_MAX_CHARS) {
		return normalized;
	}
	return `${chars
		.slice(0, SESSION_TITLE_TOOLTIP_MAX_CHARS - 3)
		.join("")
		.trimEnd()}...`;
}

// StackParentChip: for a stacked-PR child, replaces the target-branch picker
// with a live "→ <parent workspace title>" chip that navigates to the parent.
// The parent's title comes from its own (cached, auto-invalidated) detail
// query, so renaming the parent updates this chip in place — and the click
// never points at a stale branch string the way the raw target name could.
function StackParentChip({
	parentWorkspaceId,
	fallbackBranch,
	displayRemote,
	archived,
	onSelectWorkspace,
}: {
	parentWorkspaceId: string;
	fallbackBranch?: string | null;
	displayRemote: string;
	archived: boolean;
	onSelectWorkspace?: (workspaceId: string) => void;
}) {
	const parentQuery = useQuery(workspaceDetailQueryOptions(parentWorkspaceId));
	const parent = parentQuery.data ?? null;
	const label = parent?.title?.trim() || fallbackBranch || "base";
	const branchHint = parent?.branch ?? fallbackBranch ?? null;
	const chipInner = (
		<>
			<Layers className="size-3 shrink-0" strokeWidth={1.8} />
			<span className="block min-w-0 truncate">{label}</span>
		</>
	);
	return (
		<>
			<ArrowRight
				className="relative top-px size-3 shrink-0 self-center text-muted-foreground"
				strokeWidth={1.8}
			/>
			<Tooltip>
				<TooltipTrigger asChild>
					{archived ? (
						<span className="inline-flex min-w-0 max-w-[200px] items-center gap-1 px-1 py-0.5 font-medium text-muted-foreground">
							{chipInner}
						</span>
					) : (
						<Button
							type="button"
							variant="ghost"
							size="xs"
							onClick={() => onSelectWorkspace?.(parentWorkspaceId)}
							className="h-6 min-w-0 max-w-[200px] gap-1 rounded-md px-1.5 text-ui font-medium text-muted-foreground hover:text-foreground"
						>
							{chipInner}
						</Button>
					)}
				</TooltipTrigger>
				<TooltipContent
					side="bottom"
					sideOffset={4}
					className="max-w-[260px] flex-col items-start rounded-md px-2 py-1.5 text-left text-mini leading-snug"
				>
					{branchHint ? (
						<span className="block text-background/70">
							Base branch {displayRemote}/{branchHint}
						</span>
					) : (
						<span className="block text-background/70">Stacked on {label}</span>
					)}
				</TooltipContent>
			</Tooltip>
		</>
	);
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
				className="h-6 min-w-0 max-w-[180px] gap-1 rounded-md px-1.5 text-ui font-medium text-muted-foreground hover:text-foreground"
			>
				<span className="block min-w-0 truncate">
					{displayRemote}/{currentBranch}
				</span>
				<ChevronDown data-icon="inline-end" strokeWidth={2} />
			</Button>
		</BranchPickerPopover>
	);
}
