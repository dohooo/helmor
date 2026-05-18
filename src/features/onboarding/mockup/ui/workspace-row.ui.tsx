import { cva } from "class-variance-authority";
import {
	Archive,
	GitBranch,
	LoaderCircle,
	RotateCcw,
	Trash2,
} from "lucide-react";
import type { ReactNode } from "react";
import { HelmorThinkingIndicator } from "@/components/helmor-thinking-indicator";
import { Button } from "@/components/ui/button";
import { HyperText } from "@/components/ui/hyper-text";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
	branchToneClasses,
	WorkspaceAvatarUI,
	type WorkspaceBranchTone,
} from "./shared";

/**
 * Frozen snapshot of the workspace sidebar row visual, copied from the
 * production `features/navigation/workspace-row.ui.tsx` at the time the
 * onboarding mockup was last hand-synced. Only consumed by the mockup —
 * change here without changing the real container, and vice versa.
 *
 * Original commentary preserved for context:
 * - the real `WorkspaceRowItem` container, which wraps this in a ContextMenu
 *   and feeds it live workspace state
 * - the onboarding mockup, which feeds it static mock data
 */
export type WorkspaceRowUIProps = {
	displayTitle: string;
	repoInitials?: string | null;
	repoName?: string | null;
	hasUnread?: boolean;
	isArchived?: boolean;
	selected?: boolean;
	isSending?: boolean;
	isInteractionRequired?: boolean;
	branchTone: WorkspaceBranchTone;
	dataWorkspaceRowId?: string;
	rowRef?: (element: HTMLDivElement | null) => void;
	onClick?: () => void;
	onMouseEnter?: () => void;
	onFocus?: () => void;
	onKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void;
	/** Optional hover action cluster — rendered absolutely on the right edge. */
	hoverActions?: ReactNode;
	/** Tweaks the text fade so two-icon hover clusters don't leave a gap. */
	hasTwoActions?: boolean;
	isBusy?: boolean;
};

const rowVariants = cva(
	"group/row relative flex h-7.5 select-none items-center gap-2 rounded-md px-2.5 text-[13px] cursor-interactive",
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

export function WorkspaceRowUI({
	displayTitle,
	repoInitials,
	repoName,
	hasUnread = false,
	isArchived = false,
	selected = false,
	isSending = false,
	isInteractionRequired = false,
	branchTone,
	dataWorkspaceRowId,
	rowRef,
	onClick,
	onMouseEnter,
	onFocus,
	onKeyDown,
	hoverActions,
	hasTwoActions = false,
	isBusy = false,
}: WorkspaceRowUIProps) {
	const statusDotLabel = isInteractionRequired
		? "Interaction required"
		: hasUnread
			? "Unread"
			: null;
	const statusDotClassName = isInteractionRequired
		? "bg-yellow-500"
		: "bg-chart-2";
	const showStatusDot = statusDotLabel !== null;

	const rowFadeStyle = hasTwoActions
		? ({
				"--row-fade-transparent": "2.6rem",
				"--row-fade-solid": "3.4rem",
			} as React.CSSProperties)
		: undefined;

	return (
		<div
			ref={rowRef}
			role="button"
			tabIndex={0}
			aria-label={displayTitle}
			data-workspace-row-id={dataWorkspaceRowId}
			data-has-unread={hasUnread ? "true" : "false"}
			data-busy={isBusy ? "true" : undefined}
			style={rowFadeStyle}
			onMouseEnter={onMouseEnter}
			onFocus={onFocus}
			onClick={onClick}
			onKeyDown={onKeyDown}
			className={cn(
				rowVariants({ active: selected }),
				"w-full text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50",
				!selected && isArchived && "opacity-50",
			)}
		>
			<div className="flex min-w-0 flex-1 items-center gap-2">
				<WorkspaceAvatarUI
					repoInitials={repoInitials}
					repoName={repoName}
					title={displayTitle}
					badgeClassName={showStatusDot ? statusDotClassName : null}
					badgeAriaLabel={statusDotLabel ?? undefined}
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
								? hasUnread
									? "font-semibold text-foreground"
									: "font-medium text-foreground"
								: hasUnread
									? "font-semibold text-foreground"
									: "font-medium",
						)}
					>
						<HyperText text={displayTitle} className="inline" />
					</span>
				</div>
			</div>
			{hoverActions}
		</div>
	);
}

/**
 * Optional hover-action cluster rendered on the row's right edge. The real
 * container composes this with archive/restore/delete handlers; the mockup
 * does not render hover actions at all, so it simply omits the slot.
 */
export function WorkspaceRowHoverActionsUI({
	actionLabel,
	isRestoreAction,
	isBusy,
	disabled,
	onPrimaryAction,
	onDelete,
}: {
	actionLabel: string;
	isRestoreAction: boolean;
	isBusy: boolean;
	disabled: boolean;
	onPrimaryAction: () => void;
	onDelete?: () => void;
}) {
	const primaryIcon = isBusy ? (
		<LoaderCircle className="size-3.5 animate-spin" strokeWidth={2.1} />
	) : isRestoreAction ? (
		<RotateCcw className="size-3.5" strokeWidth={2.1} />
	) : (
		<Archive className="size-3.5" strokeWidth={1.9} />
	);
	return (
		<span
			className={cn(
				"pointer-events-none absolute inset-y-0 right-0 flex items-center gap-0.5 pr-2.5",
				"opacity-0 group-hover/row:pointer-events-auto group-hover/row:opacity-100 group-focus-within/row:pointer-events-auto group-focus-within/row:opacity-100",
				isBusy && "pointer-events-auto opacity-100",
			)}
		>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						aria-label={actionLabel}
						disabled={disabled || isBusy}
						onClick={(event) => {
							event.stopPropagation();
							if (disabled || isBusy) return;
							onPrimaryAction();
						}}
						variant="ghost"
						size="icon-xs"
						className={cn(
							"size-5 rounded-md p-0 text-muted-foreground",
							disabled
								? "cursor-not-allowed opacity-60"
								: "cursor-interactive hover:text-foreground",
						)}
					>
						{primaryIcon}
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
			{isRestoreAction && onDelete ? (
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							aria-label="Delete permanently"
							disabled={disabled || isBusy}
							onClick={(event) => {
								event.stopPropagation();
								if (disabled || isBusy) return;
								onDelete();
							}}
							variant="ghost"
							size="icon-xs"
							className={cn(
								"size-5 rounded-md p-0 text-muted-foreground",
								disabled
									? "cursor-not-allowed opacity-60"
									: "cursor-interactive hover:text-destructive",
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
	);
}
