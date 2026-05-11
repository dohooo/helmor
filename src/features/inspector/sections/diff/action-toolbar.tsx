import {
	Check,
	ChevronDown,
	GitFork,
	GitPullRequest,
	Inbox,
	ListTree,
	RotateCw,
} from "lucide-react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ChangeRequestInfo } from "@/lib/api";
import { cn } from "@/lib/utils";

export type ChangesFilter = "all" | "uncommitted";

const FILTER_LABELS: Record<ChangesFilter, string> = {
	all: "All changes",
	uncommitted: "Uncommitted changes",
};

interface DiffActionToolbarProps {
	changeRequest: ChangeRequestInfo | null;
	/** Workspace branch name; rendered on the right of the toolbar
	 *  alongside the PR badge so the user always knows which branch the
	 *  Diff sub-tab is reading. */
	workspaceBranch: string | null;
	treeView: boolean;
	onToggleTreeView: () => void;
	onRefreshChanges: () => void;
	/** Open the change-base-branch menu. Stub for now — see follow-up. */
	onChangeBaseBranch?: () => void;
	/** Open the stash menu. Stub for now — see follow-up. */
	onStash?: () => void;
	onOpenChangeRequest?: () => void;
	filter: ChangesFilter;
	onFilterChange: (next: ChangesFilter) => void;
}

/**
 * Top action row on the Diff sub-tab. Four mono icons on the left
 * (change base branch / stash / tree-or-list view toggle / refresh) and
 * a `#<n>` PR badge on the right that links out to the change request
 * on the forge. The icons borrow their visual weight from
 * `lucide-react`'s default 1.8 stroke so they read crisp against the
 * dark `#1B1716` body the sub-tab sits over.
 */
export function DiffActionToolbar({
	changeRequest,
	workspaceBranch,
	treeView,
	onToggleTreeView,
	onRefreshChanges,
	onChangeBaseBranch,
	onStash,
	onOpenChangeRequest,
	filter,
	onFilterChange,
}: DiffActionToolbarProps) {
	const filterOptions: ChangesFilter[] = ["all", "uncommitted"];
	return (
		<div className="flex h-9 shrink-0 items-center justify-between border-b border-border/50 px-2.5">
			<div className="flex items-center gap-1">
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<button
							type="button"
							className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-md px-1.5 text-[11.5px] text-foreground/85 hover:bg-foreground/[0.07] hover:text-foreground"
						>
							<span className="truncate">{FILTER_LABELS[filter]}</span>
							<ChevronDown className="size-3" strokeWidth={2} />
						</button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="start" className="min-w-44">
						{filterOptions.map((option) => (
							<DropdownMenuItem
								key={option}
								onClick={() => onFilterChange(option)}
								className="flex items-center gap-2"
							>
								<Check
									className={cn(
										"size-3.5 shrink-0",
										option === filter ? "opacity-100" : "opacity-0",
									)}
									strokeWidth={2}
								/>
								<span>{FILTER_LABELS[option]}</span>
							</DropdownMenuItem>
						))}
					</DropdownMenuContent>
				</DropdownMenu>
				<span className="mx-1 h-4 w-px bg-border/60" aria-hidden />
				<ToolbarIconButton
					label="Change base branch"
					disabled={!onChangeBaseBranch}
					onClick={onChangeBaseBranch}
					icon={<GitFork className="size-3.5" strokeWidth={1.8} />}
				/>
				<ToolbarIconButton
					label="Stash changes"
					disabled={!onStash}
					onClick={onStash}
					icon={<Inbox className="size-3.5" strokeWidth={1.8} />}
				/>
				<ToolbarIconButton
					label={treeView ? "Switch to flat list" : "Switch to tree view"}
					onClick={onToggleTreeView}
					active={treeView}
					icon={<ListTree className="size-3.5" strokeWidth={1.8} />}
				/>
				<ToolbarIconButton
					label="Refresh changes"
					onClick={onRefreshChanges}
					icon={<RotateCw className="size-3.5" strokeWidth={1.8} />}
				/>
			</div>
			<div className="flex min-w-0 items-center gap-2 pl-2">
				{changeRequest ? (
					<button
						type="button"
						onClick={onOpenChangeRequest}
						title={workspaceBranch ?? undefined}
						className="group/pr flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
					>
						<GitPullRequest
							className="size-4 text-purple-400"
							strokeWidth={1.8}
						/>
						<span className="tabular-nums text-foreground/85">
							#{changeRequest.number}
						</span>
					</button>
				) : workspaceBranch ? (
					<span
						title={workspaceBranch}
						className="truncate font-mono tabular-nums text-[11.5px] text-foreground/85"
					>
						#{extractBranchNumber(workspaceBranch) ?? workspaceBranch}
					</span>
				) : null}
			</div>
		</div>
	);
}

/**
 * Pulls a ticket / issue number out of a branch name. Matches the common
 * conventions: `feature/123-foo`, `fix-456`, `pr-789`, or a bare leading
 * number. Returns `null` when no number can be identified — the caller
 * falls back to the raw branch name (with tooltip) in that case.
 */
function extractBranchNumber(branch: string): string | null {
	const match = branch.match(/(?:^|[/_-])(\d{2,})(?:[/_-]|$)/);
	return match ? match[1] : null;
}

function ToolbarIconButton({
	label,
	icon,
	onClick,
	disabled = false,
	active = false,
}: {
	label: string;
	icon: React.ReactNode;
	onClick?: () => void;
	disabled?: boolean;
	active?: boolean;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					aria-label={label}
					aria-pressed={active}
					onClick={onClick}
					disabled={disabled}
					className={cn(
						"flex size-6 cursor-pointer items-center justify-center rounded-md text-foreground/85 transition-colors hover:bg-foreground/[0.07] hover:text-foreground",
						active && "bg-foreground/[0.10] text-foreground",
						disabled &&
							"cursor-not-allowed text-muted-foreground/50 hover:bg-transparent hover:text-muted-foreground/50",
					)}
				>
					{icon}
				</button>
			</TooltipTrigger>
			<TooltipContent
				side="bottom"
				sideOffset={4}
				className="flex h-[22px] items-center rounded-md px-1.5 text-[11px] leading-none"
			>
				{label}
			</TooltipContent>
		</Tooltip>
	);
}
