import { cva } from "class-variance-authority";
import {
	Archive,
	Circle,
	GitBranch,
	LoaderCircle,
	Pin,
	PinOff,
	RotateCcw,
	Trash2,
} from "lucide-react";
import { memo, useEffect } from "react";
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
import type { WorkspaceRow } from "@/lib/api";
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

const rowVariants = cva(
	"group relative flex h-7.5 select-none items-center gap-2 rounded-md px-2.5 text-[13px] cursor-pointer",
	{
		variants: {
			active: {
				true: "bg-accent text-foreground",
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
	isCompleted?: boolean;
	isInteractionRequired?: boolean;
	rowRef?: (element: HTMLDivElement | null) => void;
	onSelect?: (workspaceId: string) => void;
	onPrefetch?: (workspaceId: string) => void;
	onArchiveWorkspace?: (workspaceId: string) => void;
	onMarkWorkspaceUnread?: (workspaceId: string) => void;
	onRestoreWorkspace?: (workspaceId: string) => void;
	onDeleteWorkspace?: (workspaceId: string) => void;
	onTogglePin?: (workspaceId: string, currentlyPinned: boolean) => void;
	onSetManualStatus?: (workspaceId: string, status: string | null) => void;
	archivingWorkspaceId?: string | null;
	markingUnreadWorkspaceId?: string | null;
	restoringWorkspaceId?: string | null;
	workspaceActionsDisabled?: boolean;
};

export const WorkspaceRowItem = memo(
	function WorkspaceRowItem({
		row,
		selected,
		isSending,
		isCompleted,
		isInteractionRequired,
		rowRef,
		onSelect,
		onPrefetch,
		onArchiveWorkspace,
		onMarkWorkspaceUnread: _onMarkWorkspaceUnread,
		onRestoreWorkspace,
		onDeleteWorkspace,
		onTogglePin,
		onSetManualStatus,
		archivingWorkspaceId,
		markingUnreadWorkspaceId,
		restoringWorkspaceId,
		workspaceActionsDisabled,
	}: WorkspaceRowItemProps) {
		useEffect(() => {
			recordSidebarRowRender(row.id);
		});
		const actionLabel =
			row.state === "archived" ? "Restore workspace" : "Archive workspace";
		const isArchiving = archivingWorkspaceId === row.id;
		const isMarkingUnread = markingUnreadWorkspaceId === row.id;
		const isRestoring = restoringWorkspaceId === row.id;
		const isRestoreAction = row.state === "archived";
		const isBusy = isArchiving || isMarkingUnread || isRestoring;
		const hasActionHandler = isRestoreAction
			? Boolean(onRestoreWorkspace)
			: Boolean(onArchiveWorkspace);
		const actionIcon = isBusy ? (
			<LoaderCircle className="size-3.5 animate-spin" strokeWidth={2.1} />
		) : isRestoreAction ? (
			<RotateCcw className="size-3.5" strokeWidth={2.1} />
		) : (
			<Archive className="size-3.5" strokeWidth={1.9} />
		);
		const isPinned = Boolean(row.pinnedAt);
		const effectiveStatus =
			row.manualStatus ?? row.derivedStatus ?? "in-progress";
		const branchTone = getWorkspaceBranchTone({
			workspaceState: row.state,
			manualStatus: row.manualStatus,
			derivedStatus: row.derivedStatus,
		});
		const actionOverlayWidthClassName =
			isRestoreAction && onDeleteWorkspace ? "w-16" : "w-9";
		const statusDotLabel = isInteractionRequired
			? "Interaction required"
			: isCompleted
				? "Session completed"
				: null;
		const statusDotClassName = isInteractionRequired
			? "bg-yellow-500"
			: "bg-chart-2";
		const showStatusDot =
			statusDotLabel !== null && (isInteractionRequired || !selected);

		const rowBody = (
			<div
				ref={rowRef}
				role="button"
				tabIndex={0}
				aria-label={row.title}
				data-workspace-row-id={row.id}
				data-has-unread={row.hasUnread ? "true" : "false"}
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
						title={row.title}
					/>
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
							"truncate leading-none",
							selected
								? row.hasUnread
									? "font-semibold text-foreground"
									: "font-medium text-foreground"
								: row.hasUnread
									? "font-semibold text-foreground"
									: "font-medium",
						)}
					>
						<HyperText
							text={row.branch ? humanizeBranch(row.branch) : row.title}
						/>
					</span>
					{showStatusDot ? (
						<span
							aria-label={statusDotLabel ?? undefined}
							className={cn(
								"size-1.5 shrink-0 rounded-full",
								statusDotClassName,
							)}
						/>
					) : null}
				</div>

				{hasActionHandler ? (
					<span
						className={cn(
							"pointer-events-none absolute inset-y-0 right-0 z-10 flex items-center justify-end opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100",
							actionOverlayWidthClassName,
							isBusy && "pointer-events-auto opacity-100",
						)}
					>
						<span className="absolute inset-y-0 right-0 w-full rounded-r-md bg-[linear-gradient(to_right,transparent_0%,var(--sidebar)_38%,var(--sidebar)_100%)]" />
						<span className="relative z-10 flex items-center gap-0.5 pr-1">
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										aria-label={actionLabel}
										disabled={Boolean(workspaceActionsDisabled)}
										onClick={(event) => {
											event.stopPropagation();
											if (workspaceActionsDisabled) return;
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
								</TooltipTrigger>
								<TooltipContent
									side="top"
									sideOffset={8}
									className="flex h-[22px] items-center rounded-md px-1.5 text-[11px] leading-none"
								>
									<span>{actionLabel}</span>
								</TooltipContent>
							</Tooltip>
							{isRestoreAction && onDeleteWorkspace ? (
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											aria-label="Delete permanently"
											disabled={Boolean(workspaceActionsDisabled)}
											onClick={(event) => {
												event.stopPropagation();
												if (workspaceActionsDisabled) return;
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
									</TooltipTrigger>
									<TooltipContent
										side="top"
										sideOffset={8}
										className="flex h-[22px] items-center rounded-md px-1.5 text-[11px] leading-none"
									>
										<span>Delete permanently</span>
									</TooltipContent>
								</Tooltip>
							) : null}
						</span>
					</span>
				) : null}
			</div>
		);

		return (
			<ContextMenu>
				<ContextMenuTrigger className="block">{rowBody}</ContextMenuTrigger>
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
									onClick={() => onSetManualStatus?.(row.id, opt.value)}
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
			previous.isCompleted === next.isCompleted &&
			previous.isInteractionRequired === next.isInteractionRequired &&
			previous.archivingWorkspaceId === next.archivingWorkspaceId &&
			previous.markingUnreadWorkspaceId === next.markingUnreadWorkspaceId &&
			previous.restoringWorkspaceId === next.restoringWorkspaceId &&
			previous.workspaceActionsDisabled === next.workspaceActionsDisabled
		);
	},
);
