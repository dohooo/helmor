import { cva } from "class-variance-authority";
import {
	Archive,
	Circle,
	FolderOpen,
	GitBranch,
	Laptop,
	LoaderCircle,
	Pin,
	PinOff,
	RotateCcw,
	Split,
	Trash2,
} from "lucide-react";
import {
	memo,
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { HelmorThinkingIndicator } from "@/components/helmor-thinking-indicator";
import { Button } from "@/components/ui/button";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { HyperText } from "@/components/ui/hyper-text";
import { ShineBorder } from "@/components/ui/shine-border";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import {
	getScriptState,
	subscribeStatus,
} from "@/features/inspector/script-store";
import type { WorkspaceRow, WorkspaceStatus } from "@/lib/api";
import { recordSidebarRowRender } from "@/lib/dev-render-debug";
import { cn } from "@/lib/utils";
import { getWorkspaceBranchTone } from "@/lib/workspace-helpers";
import { WorkspaceAvatar } from "./avatar";
import { MoveToWorktreeDialog } from "./move-to-worktree-dialog";
import {
	branchToneClasses,
	GroupIcon,
	humanizeBranch,
	STATUS_OPTIONS,
} from "./shared";
import { WorkspaceHoverCard } from "./workspace-hover-card";

const rowVariants = cva(
	"group/row relative flex h-7.5 select-none items-center gap-2 rounded-md px-2.5 text-ui cursor-interactive",
	{
		variants: {
			active: {
				true: "workspace-row-selected text-foreground",
				false: "text-foreground/80 hover:bg-accent/60",
			},
		},
		defaultVariants: {
			active: false,
		},
	},
);

export type WorkspaceRowItemProps = {
	row: WorkspaceRow;
	selected: boolean;
	isSending?: boolean;
	isInteractionRequired?: boolean;
	/** Drop the per-row repo avatar — used when the surrounding group header
	 *  already shows it (i.e. rows inside a real repo bucket in repo
	 *  grouping mode), where rendering it again on every row is pure
	 *  noise. The branch icon takes over the leading slot AND becomes
	 *  the carrier for the unread / interaction-required status dot and
	 *  the run-script ShineBorder, so those affordances aren't lost when
	 *  the avatar is hidden. */
	hideRepoAvatar?: boolean;
	rowRef?: (element: HTMLDivElement | null) => void;
	onSelect?: (workspaceId: string) => void;
	onPrefetch?: (workspaceId: string) => void;
	onArchiveWorkspace?: (workspaceId: string) => void;
	onMoveLocalToWorktree?: (workspaceId: string) => void;
	onMarkWorkspaceUnread?: (workspaceId: string) => void;
	onOpenInFinder?: (workspaceId: string) => void;
	onRestoreWorkspace?: (workspaceId: string) => void;
	onDeleteWorkspace?: (workspaceId: string) => void;
	onTogglePin?: (workspaceId: string, currentlyPinned: boolean) => void;
	onSetWorkspaceStatus?: (workspaceId: string, status: WorkspaceStatus) => void;
	/** Live group id — flows through props so no stale closure on grouping flip. */
	groupId?: string;
	onDragPointerDown?: (args: {
		event: ReactPointerEvent<HTMLElement>;
		row: WorkspaceRow;
		groupId: string;
		title: string;
	}) => void;
	disableHoverCard?: boolean;
	dragPreview?: boolean;
	archivingWorkspaceIds?: Set<string>;
	markingUnreadWorkspaceId?: string | null;
	restoringWorkspaceId?: string | null;
	workspaceActionsDisabled?: boolean;
};

/**
 * Subscribes to this workspace's `run`-script status via the module-level
 * script-store used by the inspector. Returns true only while the script is
 * actively executing (not "idle" or "exited"). Per-row subscription keeps the
 * re-render fan-out narrow — only rows whose status flipped re-render.
 */
function useIsRunScriptRunning(workspaceId: string): boolean {
	const [running, setRunning] = useState(
		() => getScriptState(workspaceId, "run")?.status === "running",
	);
	useEffect(() => {
		// Re-sync when the row is reused for a different workspace (virtual list).
		setRunning(getScriptState(workspaceId, "run")?.status === "running");
		return subscribeStatus(workspaceId, "run", (status) => {
			setRunning(status === "running");
		});
	}, [workspaceId]);
	return running;
}

export const WorkspaceRowItem = memo(
	function WorkspaceRowItem({
		row,
		selected,
		isSending,
		isInteractionRequired,
		hideRepoAvatar = false,
		rowRef,
		onSelect,
		onPrefetch,
		onArchiveWorkspace,
		onMoveLocalToWorktree,
		onMarkWorkspaceUnread: _onMarkWorkspaceUnread,
		onOpenInFinder,
		onRestoreWorkspace,
		onDeleteWorkspace,
		onTogglePin,
		onSetWorkspaceStatus,
		groupId,
		onDragPointerDown,
		disableHoverCard,
		dragPreview,
		archivingWorkspaceIds,
		markingUnreadWorkspaceId,
		restoringWorkspaceId,
		workspaceActionsDisabled,
	}: WorkspaceRowItemProps) {
		useEffect(() => {
			recordSidebarRowRender(row.id);
		}, [row.id]);
		const isRunScriptRunning = useIsRunScriptRunning(row.id);

		// Hover-intent debounce: skip prefetch when the mouse just sweeps over
		// the row. ~120ms is short enough that the data is still warm by the
		// time HoverCard's 400ms openDelay elapses, but long enough to absorb
		// fast cursor movement across a long sidebar.
		const prefetchTimerRef = useRef<number | null>(null);
		const cancelPendingPrefetch = useCallback(() => {
			if (prefetchTimerRef.current !== null) {
				window.clearTimeout(prefetchTimerRef.current);
				prefetchTimerRef.current = null;
			}
		}, []);
		const handlePointerEnter = useCallback(() => {
			if (disableHoverCard || dragPreview) {
				return;
			}
			cancelPendingPrefetch();
			const id = row.id;
			prefetchTimerRef.current = window.setTimeout(() => {
				prefetchTimerRef.current = null;
				onPrefetch?.(id);
			}, 120);
		}, [
			cancelPendingPrefetch,
			disableHoverCard,
			dragPreview,
			onPrefetch,
			row.id,
		]);
		useEffect(() => cancelPendingPrefetch, [cancelPendingPrefetch]);
		const [moveDialogOpen, setMoveDialogOpen] = useState(false);
		const [archiveConfirming, setArchiveConfirming] = useState(false);
		const resetArchiveConfirm = useCallback(() => {
			setArchiveConfirming(false);
		}, []);
		const startArchiveConfirm = useCallback(() => {
			setArchiveConfirming(true);
		}, []);
		const handleRowPointerLeave = useCallback(() => {
			cancelPendingPrefetch();
			resetArchiveConfirm();
		}, [cancelPendingPrefetch, resetArchiveConfirm]);
		const actionLabel =
			row.state === "archived"
				? "Restore workspace"
				: archiveConfirming
					? "Confirm archive workspace"
					: "Archive workspace";
		const isArchiving = archivingWorkspaceIds?.has(row.id) ?? false;
		const isMarkingUnread = markingUnreadWorkspaceId === row.id;
		const isRestoring = restoringWorkspaceId === row.id;
		const isRestoreAction = row.state === "archived";
		const isBusy = isArchiving || isMarkingUnread || isRestoring;
		useEffect(() => resetArchiveConfirm, [resetArchiveConfirm]);
		useEffect(() => {
			resetArchiveConfirm();
		}, [
			resetArchiveConfirm,
			row.id,
			isRestoreAction,
			isBusy,
			workspaceActionsDisabled,
		]);
		const hasActionHandler = isRestoreAction
			? Boolean(onRestoreWorkspace)
			: Boolean(onArchiveWorkspace);
		// Width of the hover action cluster drives the text fade mask. Single icon
		// uses the CSS default (transparent 1.2rem, solid 2rem). Two icons span
		// ~3.25rem from the row's right edge (pr-2.5 + size-5 + gap-0.5 + size-5),
		// so push the fade to end just past that so text hugs the leftmost icon
		// instead of leaving a visible gap.
		const hasTwoActions =
			hasActionHandler && isRestoreAction && Boolean(onDeleteWorkspace);
		const isArchiveConfirmVisible =
			archiveConfirming && !isRestoreAction && !isBusy;
		const rowFadeStyle = isArchiveConfirmVisible
			? ({
					"--row-fade-transparent": "3.9rem",
					"--row-fade-solid": "4.8rem",
				} as React.CSSProperties)
			: hasTwoActions
				? ({
						"--row-fade-transparent": "2.6rem",
						"--row-fade-solid": "3.4rem",
					} as React.CSSProperties)
				: undefined;
		const actionIcon = isBusy ? (
			<LoaderCircle className="size-3.5 animate-spin" strokeWidth={2.1} />
		) : isRestoreAction ? (
			<RotateCcw className="size-3.5" strokeWidth={2.1} />
		) : (
			<Archive className="size-3.5" strokeWidth={1.9} />
		);
		const isPinned = Boolean(row.pinnedAt);
		const effectiveStatus = row.status ?? "in-progress";
		const branchTone = getWorkspaceBranchTone({
			workspaceState: row.state,
			status: row.status,
		});
		const statusDotLabel = isInteractionRequired
			? "Interaction required"
			: row.hasUnread
				? "Unread"
				: null;
		const statusDotClassName = isInteractionRequired
			? "bg-yellow-500"
			: "bg-chart-2";
		const showStatusDot = statusDotLabel !== null;
		// Local & Chat workspaces don't carry a meaningful per-row branch
		// label (locals share the repo's HEAD; chats have no branch at
		// all), so always fall back to the auto-titled session title.
		const displayTitle =
			row.mode === "local" || row.mode === "chat"
				? row.title
				: row.branch
					? humanizeBranch(row.branch)
					: row.title;

		const rowBody = (
			<div
				ref={rowRef}
				role="button"
				tabIndex={0}
				aria-label={displayTitle}
				data-workspace-row-id={row.id}
				data-workspace-row-body="true"
				data-has-unread={row.hasUnread ? "true" : "false"}
				data-busy={isBusy ? "true" : undefined}
				style={rowFadeStyle}
				onPointerEnter={handlePointerEnter}
				onPointerLeave={handleRowPointerLeave}
				onPointerDown={(event) => {
					cancelPendingPrefetch();
					if (onDragPointerDown && groupId) {
						onDragPointerDown({ event, row, groupId, title: displayTitle });
					}
				}}
				onFocus={() => {
					onPrefetch?.(row.id);
				}}
				onClick={() => {
					onSelect?.(row.id);
				}}
				onKeyDown={(event) => {
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						onSelect?.(row.id);
					}
				}}
				className={cn(
					rowVariants({ active: selected }),
					"w-full text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50",
					dragPreview && "bg-accent/70 opacity-80 hover:bg-accent/70",
					!selected && row.state === "archived" && "opacity-50",
				)}
			>
				{(() => {
					const branchIcon =
						isSending && !isInteractionRequired ? (
							<HelmorThinkingIndicator size={13} />
						) : row.mode === "local" ? (
							<Laptop
								className={cn(
									"size-[13px] shrink-0",
									branchToneClasses[branchTone],
								)}
								strokeWidth={1.9}
							/>
						) : row.mode ===
							"chat" ? // Chat rows are bucketed under the dedicated
						// "Chats" group header (which carries the
						// MessageCircle glyph) — drawing the same icon on
						// every row would just be noise. Keep the slot
						// invisible so unread / status indicators still
						// have a stable carrier.
						null : (
							<GitBranch
								className={cn(
									"size-[13px] shrink-0",
									branchToneClasses[branchTone],
								)}
								strokeWidth={1.9}
							/>
						);
					// When the repo avatar is suppressed (rows inside a repo
					// bucket), the branch icon takes over as the carrier for
					// unread / interaction-required / running indicators —
					// otherwise those signals would silently vanish in repo
					// grouping mode.
					const branchSlot = hideRepoAvatar ? (
						<span className="relative inline-flex shrink-0">
							{branchIcon}
							{showStatusDot ? (
								<span
									aria-label={statusDotLabel ?? undefined}
									className={cn(
										"pointer-events-none absolute -top-1 -right-1 size-1.5 rounded-full ring-2 ring-sidebar",
										statusDotClassName,
									)}
								/>
							) : null}
							{isRunScriptRunning ? (
								<ShineBorder
									borderWidth={1}
									duration={6}
									shineColor={["#A07CFE", "#FE8FB5", "#FFBE7B"]}
									style={{
										inset: "-2px",
										width: "calc(100% + 4px)",
										height: "calc(100% + 4px)",
										borderRadius: "6px",
									}}
								/>
							) : null}
						</span>
					) : (
						branchIcon
					);
					const titleSlot = (
						<span
							className={cn(
								// leading-tight (1.25) instead of leading-none so descenders
								// (g/j/p/q/y) aren't clipped by truncate's overflow:hidden
								// when the page is zoomed out (Cmd+-).
								"truncate leading-tight",
								selected
									? row.hasUnread
										? "font-semibold text-foreground"
										: "font-medium text-foreground"
									: row.hasUnread
										? "font-semibold text-foreground"
										: "font-medium",
							)}
						>
							<HyperText text={displayTitle} className="inline" />
						</span>
					);
					// Chat workspaces have no real repo, so skip the avatar
					// slot entirely — the branch icon (MessageCircle in
					// chat mode) carries the leading visual identity. Falls
					// through to the same layout used when an outer repo
					// bucket already shows the avatar.
					if (hideRepoAvatar || row.mode === "chat") {
						return (
							<div className="flex min-w-0 flex-1 items-center gap-2">
								{branchSlot}
								<div className="row-content-fade flex min-w-0 flex-1 items-center gap-2">
									{titleSlot}
								</div>
							</div>
						);
					}
					return (
						<div className="flex min-w-0 flex-1 items-center gap-2">
							<WorkspaceAvatar
								repoIconSrc={row.repoIconSrc}
								repoInitials={row.repoInitials ?? row.avatar ?? null}
								repoName={row.repoName}
								title={displayTitle}
								badgeClassName={showStatusDot ? statusDotClassName : null}
								badgeAriaLabel={statusDotLabel ?? undefined}
								isRunning={isRunScriptRunning}
							/>
							{/* Fade is on an inner wrapper so the avatar's overflowing badge isn't clipped by mask-image. */}
							<div className="row-content-fade flex min-w-0 flex-1 items-center gap-2">
								{branchSlot}
								{titleSlot}
							</div>
						</div>
					);
				})()}

				{/* Chat rows have no branch icon / avatar to carry the unread or
				 * interaction-required dot, so park it absolute-positioned over
				 * the archive icon slot. On hover/focus it fades out and the
				 * actions cluster fades in, so the archive icon visually
				 * replaces it without any layout shift. */}
				{row.mode === "chat" && showStatusDot && !hideRepoAvatar ? (
					<span
						aria-hidden="false"
						className={cn(
							"pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2.5",
							hasActionHandler &&
								"group-hover/row:hidden group-focus-within/row:hidden",
							isBusy && "hidden",
						)}
					>
						<span className="flex size-5 items-center justify-center">
							<span
								aria-label={statusDotLabel ?? undefined}
								className={cn("size-1.5 rounded-full", statusDotClassName)}
							/>
						</span>
					</span>
				) : null}

				{hasActionHandler ? (
					<span
						data-workspace-row-actions="true"
						className={cn(
							"pointer-events-none absolute inset-y-0 right-0 flex items-center gap-0.5 pr-2.5",
							"opacity-0 group-hover/row:pointer-events-auto group-hover/row:opacity-100 group-focus-within/row:pointer-events-auto group-focus-within/row:opacity-100",
							isBusy && "pointer-events-auto opacity-100",
						)}
					>
						{(() => {
							const actionButton = (
								<Button
									aria-label={actionLabel}
									disabled={Boolean(workspaceActionsDisabled || isBusy)}
									onClick={(event) => {
										event.stopPropagation();
										if (workspaceActionsDisabled || isBusy) return;
										if (isRestoreAction) {
											onRestoreWorkspace?.(row.id);
										} else if (archiveConfirming) {
											resetArchiveConfirm();
											onArchiveWorkspace?.(row.id);
										} else {
											startArchiveConfirm();
										}
									}}
									variant={isArchiveConfirmVisible ? "destructive" : "ghost"}
									size="icon-xs"
									className={cn(
										"size-5 rounded-md p-0",
										!isArchiveConfirmVisible && "text-muted-foreground",
										isArchiveConfirmVisible &&
											"h-5 w-auto min-w-11 px-1.5 text-mini font-medium leading-none transition-colors duration-100 hover:bg-destructive/10 hover:text-destructive active:not-aria-[haspopup]:translate-y-0 dark:hover:bg-destructive/20",
										workspaceActionsDisabled
											? "cursor-not-allowed opacity-60"
											: isArchiveConfirmVisible
												? "cursor-interactive"
												: "cursor-interactive hover:text-foreground",
									)}
								>
									{isArchiveConfirmVisible ? "Confirm" : actionIcon}
								</Button>
							);
							// Archived rows show restore + delete with no tooltips
							// (the icons are already self-explanatory and the
							// extra hover layer on a destructive control feels noisy).
							return isRestoreAction ? (
								actionButton
							) : isArchiveConfirmVisible ? (
								actionButton
							) : (
								<Tooltip>
									<TooltipTrigger asChild>{actionButton}</TooltipTrigger>
									<TooltipContent
										side="top"
										sideOffset={4}
										className="flex h-[22px] items-center rounded-md px-1.5 text-mini leading-none"
									>
										<span>{actionLabel}</span>
									</TooltipContent>
								</Tooltip>
							);
						})()}
						{isRestoreAction && onDeleteWorkspace ? (
							<Button
								aria-label="Delete permanently"
								disabled={Boolean(workspaceActionsDisabled || isBusy)}
								onClick={(event) => {
									event.stopPropagation();
									if (workspaceActionsDisabled || isBusy) return;
									onDeleteWorkspace(row.id);
								}}
								variant="ghost"
								size="icon-xs"
								className={cn(
									"size-5 rounded-md p-0 text-muted-foreground",
									workspaceActionsDisabled
										? "cursor-not-allowed opacity-60"
										: "cursor-interactive hover:text-destructive",
								)}
							>
								<Trash2 className="size-3.5" strokeWidth={2.1} />
							</Button>
						) : null}
					</span>
				) : null}
			</div>
		);

		if (dragPreview) {
			return rowBody;
		}

		const contextTrigger = (
			<ContextMenuTrigger className="block">{rowBody}</ContextMenuTrigger>
		);

		return (
			<>
				<ContextMenu>
					{disableHoverCard ? (
						contextTrigger
					) : (
						<WorkspaceHoverCard row={row} isSending={isSending}>
							{contextTrigger}
						</WorkspaceHoverCard>
					)}
					<ContextMenuContent className="min-w-48">
						<ContextMenuItem onClick={() => onTogglePin?.(row.id, isPinned)}>
							{isPinned ? (
								<PinOff className="size-4 shrink-0" strokeWidth={1.6} />
							) : (
								<Pin className="size-4 shrink-0" strokeWidth={1.6} />
							)}
							<span>{isPinned ? "Unpin" : "Pin"}</span>
						</ContextMenuItem>

						<ContextMenuSub>
							<ContextMenuSubTrigger>
								<Circle className="size-4 shrink-0" strokeWidth={1.6} />
								<span>Set status</span>
							</ContextMenuSubTrigger>
							<ContextMenuSubContent>
								{STATUS_OPTIONS.map((opt) => (
									<ContextMenuItem
										key={opt.value}
										onClick={() => onSetWorkspaceStatus?.(row.id, opt.value)}
									>
										<GroupIcon tone={opt.tone} />
										<span className="flex-1">{opt.label}</span>
										{effectiveStatus === opt.value ? (
											<span className="ml-auto text-foreground">✓</span>
										) : null}
									</ContextMenuItem>
								))}
							</ContextMenuSubContent>
						</ContextMenuSub>

						{_onMarkWorkspaceUnread ? (
							<ContextMenuItem
								disabled={
									row.hasUnread || isBusy || Boolean(workspaceActionsDisabled)
								}
								onClick={() => _onMarkWorkspaceUnread(row.id)}
							>
								<Circle className="size-4 shrink-0" strokeWidth={1.6} />
								<span>Mark as unread</span>
							</ContextMenuItem>
						) : null}

						{onOpenInFinder && !isRestoreAction ? (
							<ContextMenuItem
								disabled={isBusy || Boolean(workspaceActionsDisabled)}
								onClick={() => onOpenInFinder(row.id)}
							>
								<FolderOpen className="size-4 shrink-0" strokeWidth={1.6} />
								<span>Open in Finder</span>
							</ContextMenuItem>
						) : null}

						{row.mode === "local" &&
						onMoveLocalToWorktree &&
						!isRestoreAction ? (
							<ContextMenuItem
								disabled={isBusy || Boolean(workspaceActionsDisabled)}
								onClick={() => setMoveDialogOpen(true)}
							>
								<Split
									className="size-4 shrink-0 rotate-90"
									strokeWidth={1.6}
								/>
								<span>Move into a new worktree</span>
							</ContextMenuItem>
						) : null}

						<ContextMenuSeparator />

						{isRestoreAction ? (
							<ContextMenuItem
								disabled={isBusy || workspaceActionsDisabled}
								onClick={() => onRestoreWorkspace?.(row.id)}
							>
								<RotateCcw className="size-4 shrink-0" strokeWidth={1.6} />
								<span>Restore</span>
							</ContextMenuItem>
						) : (
							<ContextMenuItem
								disabled={isBusy || workspaceActionsDisabled}
								onClick={() => onArchiveWorkspace?.(row.id)}
							>
								<Archive className="size-4 shrink-0" strokeWidth={1.6} />
								<span>Archive</span>
							</ContextMenuItem>
						)}
					</ContextMenuContent>
				</ContextMenu>
				{onMoveLocalToWorktree ? (
					<MoveToWorktreeDialog
						open={moveDialogOpen}
						onOpenChange={setMoveDialogOpen}
						workspaceTitle={displayTitle}
						onConfirm={() => onMoveLocalToWorktree(row.id)}
					/>
				) : null}
			</>
		);
	},
	function areWorkspaceRowItemPropsEqual(
		previous: WorkspaceRowItemProps,
		next: WorkspaceRowItemProps,
	) {
		return (
			previous.row === next.row &&
			previous.selected === next.selected &&
			previous.isSending === next.isSending &&
			previous.isInteractionRequired === next.isInteractionRequired &&
			previous.hideRepoAvatar === next.hideRepoAvatar &&
			previous.archivingWorkspaceIds === next.archivingWorkspaceIds &&
			previous.markingUnreadWorkspaceId === next.markingUnreadWorkspaceId &&
			previous.restoringWorkspaceId === next.restoringWorkspaceId &&
			previous.workspaceActionsDisabled === next.workspaceActionsDisabled &&
			previous.disableHoverCard === next.disableHoverCard &&
			previous.dragPreview === next.dragPreview &&
			// pinned/backlog rows keep their key across grouping flips —
			// without these two compares they'd hold a stale policy closure.
			previous.groupId === next.groupId &&
			previous.onDragPointerDown === next.onDragPointerDown
		);
	},
);
