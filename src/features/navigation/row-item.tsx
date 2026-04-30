import { cva } from "class-variance-authority";
import {
	Archive,
	Circle,
	FolderOpen,
	GitBranch,
	LoaderCircle,
	Pin,
	PinOff,
	RotateCcw,
	Trash2,
} from "lucide-react";
import { memo, useEffect, useState } from "react";
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
import {
	branchToneClasses,
	GroupIcon,
	humanizeBranch,
	STATUS_OPTIONS,
} from "./shared";
import { WorkspaceHoverCard } from "./workspace-hover-card";

const rowVariants = cva(
	"group/row relative flex h-7.5 select-none items-center gap-2 rounded-md px-2.5 text-[13px] cursor-pointer",
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
	rowRef?: (element: HTMLDivElement | null) => void;
	onSelect?: (workspaceId: string) => void;
	onPrefetch?: (workspaceId: string) => void;
	onArchiveWorkspace?: (workspaceId: string) => void;
	onMarkWorkspaceUnread?: (workspaceId: string) => void;
	onOpenInFinder?: (workspaceId: string) => void;
	onRestoreWorkspace?: (workspaceId: string) => void;
	onDeleteWorkspace?: (workspaceId: string) => void;
	onTogglePin?: (workspaceId: string, currentlyPinned: boolean) => void;
	onSetWorkspaceStatus?: (workspaceId: string, status: WorkspaceStatus) => void;
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
		rowRef,
		onSelect,
		onPrefetch,
		onArchiveWorkspace,
		onMarkWorkspaceUnread: _onMarkWorkspaceUnread,
		onOpenInFinder,
		onRestoreWorkspace,
		onDeleteWorkspace,
		onTogglePin,
		onSetWorkspaceStatus,
		archivingWorkspaceIds,
		markingUnreadWorkspaceId,
		restoringWorkspaceId,
		workspaceActionsDisabled,
	}: WorkspaceRowItemProps) {
		useEffect(() => {
			recordSidebarRowRender(row.id);
		});
		const isRunScriptRunning = useIsRunScriptRunning(row.id);
		const actionLabel =
			row.state === "archived" ? "Restore workspace" : "Archive workspace";
		const isArchiving = archivingWorkspaceIds?.has(row.id) ?? false;
		const isMarkingUnread = markingUnreadWorkspaceId === row.id;
		const isRestoring = restoringWorkspaceId === row.id;
		const isRestoreAction = row.state === "archived";
		const isBusy = isArchiving || isMarkingUnread || isRestoring;
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
		const rowFadeStyle = hasTwoActions
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
		const displayTitle = row.branch ? humanizeBranch(row.branch) : row.title;

		const rowBody = (
			<div
				ref={rowRef}
				role="button"
				tabIndex={0}
				aria-label={displayTitle}
				data-workspace-row-id={row.id}
				data-has-unread={row.hasUnread ? "true" : "false"}
				data-busy={isBusy ? "true" : undefined}
				style={rowFadeStyle}
				onMouseEnter={() => {
					onPrefetch?.(row.id);
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
					!selected && row.state === "archived" && "opacity-50",
				)}
			>
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
						{isSending && !isInteractionRequired ? (
							<HelmorThinkingIndicator size={13} />
						) : (
							<GitBranch
								className={cn(
									"size-[13px] shrink-0",
									branchToneClasses[branchTone],
								)}
								strokeWidth={1.9}
							/>
						)}
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
					</div>
				</div>

				{hasActionHandler ? (
					<span
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
										} else {
											onArchiveWorkspace?.(row.id);
										}
									}}
									variant="ghost"
									size="icon-xs"
									className={cn(
										"size-5 rounded-md p-0 text-muted-foreground",
										workspaceActionsDisabled
											? "cursor-not-allowed opacity-60"
											: "cursor-pointer hover:text-foreground",
									)}
								>
									{actionIcon}
								</Button>
							);
							// Archived rows show restore + delete with no tooltips
							// (the icons are already self-explanatory and the
							// extra hover layer on a destructive control feels noisy).
							return isRestoreAction ? (
								actionButton
							) : (
								<Tooltip>
									<TooltipTrigger asChild>{actionButton}</TooltipTrigger>
									<TooltipContent
										side="top"
										sideOffset={4}
										className="flex h-[22px] items-center rounded-md px-1.5 text-[11px] leading-none"
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
										: "cursor-pointer hover:text-destructive",
								)}
							>
								<Trash2 className="size-3.5" strokeWidth={2.1} />
							</Button>
						) : null}
					</span>
				) : null}
			</div>
		);

		return (
			<ContextMenu>
				<WorkspaceHoverCard row={row} isSending={isSending}>
					<ContextMenuTrigger className="block">{rowBody}</ContextMenuTrigger>
				</WorkspaceHoverCard>
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
			previous.archivingWorkspaceIds === next.archivingWorkspaceIds &&
			previous.markingUnreadWorkspaceId === next.markingUnreadWorkspaceId &&
			previous.restoringWorkspaceId === next.restoringWorkspaceId &&
			previous.workspaceActionsDisabled === next.workspaceActionsDisabled
		);
	},
);
