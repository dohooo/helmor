import {
	ArrowDownAZ,
	Calendar,
	Check,
	ChevronsUpDown,
	Clock3,
	Folder,
	FolderGit2,
	GripVertical,
	ListFilter,
	type LucideIcon,
	Rows3,
} from "lucide-react";
import { useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import {
	CommandEmpty,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import { CommandPopoverContent } from "@/components/ui/command-popover";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { InlineShortcutDisplay } from "@/features/shortcuts/shortcut-display";
import type { RepositoryCreateOption } from "@/lib/api";
import type { SidebarGrouping, SidebarSort } from "@/lib/settings";
import { WorkspaceAvatar } from "./avatar";

interface SidebarSortOption {
	value: SidebarSort;
	label: string;
	icon: LucideIcon;
}

interface SidebarRepoFilterPickerProps {
	repositories: RepositoryCreateOption[];
	selectedRepoIds: string[];
	onRepoFilterChange?: (repoIds: string[]) => void;
}

interface SidebarViewPopoverProps {
	repositories: RepositoryCreateOption[];
	grouping: SidebarGrouping;
	selectedRepoIds: string[];
	sort: SidebarSort;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	shortcut?: string | null;
	onGroupingChange?: (grouping: SidebarGrouping) => void;
	onRepoFilterChange?: (repoIds: string[]) => void;
	onSortChange?: (sort: SidebarSort) => void;
}

const SIDEBAR_SORT_OPTIONS: SidebarSortOption[] = [
	{ value: "custom", label: "Draggable order", icon: GripVertical },
	{ value: "repoName", label: "Repository name", icon: ArrowDownAZ },
	{ value: "updatedAt", label: "Last updated", icon: Clock3 },
	{ value: "createdAt", label: "Created time", icon: Calendar },
];

function repoFilterLabel(
	repositories: RepositoryCreateOption[],
	selectedRepoIds: string[],
) {
	if (selectedRepoIds.length === 0) return "All repositories";
	if (selectedRepoIds.length === 1) {
		return (
			repositories.find((repo) => repo.id === selectedRepoIds[0])?.name ??
			"1 selected"
		);
	}
	return `${selectedRepoIds.length} selected`;
}

function SidebarRepoFilterPicker({
	repositories,
	selectedRepoIds,
	onRepoFilterChange,
}: SidebarRepoFilterPickerProps) {
	const sortedRepositories = useMemo(
		() =>
			[...repositories].sort((left, right) =>
				left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
			),
		[repositories],
	);
	const selectedRepoIdSet = useMemo(
		() => new Set(selectedRepoIds),
		[selectedRepoIds],
	);
	const label = repoFilterLabel(sortedRepositories, selectedRepoIds);

	const toggleRepository = useCallback(
		(repoId: string) => {
			const next = new Set(selectedRepoIds);
			if (next.has(repoId)) {
				next.delete(repoId);
			} else {
				next.add(repoId);
			}
			onRepoFilterChange?.(Array.from(next));
		},
		[onRepoFilterChange, selectedRepoIds],
	);

	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button
					type="button"
					variant="outline"
					className="h-8 w-full justify-between rounded-md border-border/70 bg-background/40 px-2 text-[13px] font-normal"
				>
					<span className="truncate">{label}</span>
					<ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
				</Button>
			</PopoverTrigger>
			<CommandPopoverContent
				align="start"
				sideOffset={4}
				className="w-(--radix-popover-trigger-width)"
				commandClassName="max-h-[320px]"
			>
				<CommandInput placeholder="Search repositories" />
				<CommandList>
					<CommandEmpty>No repositories found.</CommandEmpty>
					<CommandItem
						value="all repositories"
						data-checked={selectedRepoIds.length === 0}
						onSelect={() => onRepoFilterChange?.([])}
					>
						<Folder className="size-4 shrink-0 text-muted-foreground" />
						<span className="truncate">All repositories</span>
					</CommandItem>
					{sortedRepositories.map((repo) => {
						const checked = selectedRepoIdSet.has(repo.id);
						return (
							<CommandItem
								key={repo.id}
								value={repo.name}
								data-checked={checked}
								onSelect={() => toggleRepository(repo.id)}
							>
								<WorkspaceAvatar
									repoIconSrc={repo.repoIconSrc}
									repoInitials={repo.repoInitials ?? null}
									repoName={repo.name}
									title={repo.name}
								/>
								<span className="truncate">{repo.name}</span>
							</CommandItem>
						);
					})}
				</CommandList>
			</CommandPopoverContent>
		</Popover>
	);
}

export function SidebarViewPopover({
	repositories,
	grouping,
	selectedRepoIds,
	sort,
	open,
	onOpenChange,
	shortcut,
	onGroupingChange,
	onRepoFilterChange,
	onSortChange,
}: SidebarViewPopoverProps) {
	return (
		<Popover open={open} onOpenChange={onOpenChange}>
			<Tooltip>
				<TooltipTrigger asChild>
					<PopoverTrigger asChild>
						<Button
							type="button"
							aria-label="Filter and sort sidebar"
							variant="ghost"
							size="icon-xs"
							className="text-muted-foreground"
						>
							<ListFilter className="size-4" strokeWidth={2} />
						</Button>
					</PopoverTrigger>
				</TooltipTrigger>
				<TooltipContent
					side="top"
					sideOffset={4}
					className="flex h-[24px] items-center gap-2 rounded-md px-2 text-[12px] leading-none"
				>
					<span>Filter and sort</span>
					{shortcut ? (
						<InlineShortcutDisplay
							hotkey={shortcut}
							className="text-background/60"
						/>
					) : null}
				</TooltipContent>
			</Tooltip>
			<PopoverContent align="start" className="w-[260px] gap-2 p-2">
				<div className="grid gap-1 px-1">
					<div className="text-[12px] font-medium text-muted-foreground">
						Repository
					</div>
					<SidebarRepoFilterPicker
						repositories={repositories}
						selectedRepoIds={selectedRepoIds}
						onRepoFilterChange={onRepoFilterChange}
					/>
				</div>
				<div className="h-px bg-border/60" />
				<div className="px-1 text-[12px] font-medium text-muted-foreground">
					Group by
				</div>
				<div className="grid gap-0.5">
					{[
						{ value: "status", label: "Status", icon: Rows3 },
						{ value: "repo", label: "Repository", icon: FolderGit2 },
					].map((option) => {
						const Icon = option.icon;
						const checked = grouping === option.value;
						return (
							<button
								key={option.value}
								type="button"
								role="radio"
								aria-checked={checked}
								className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-1.5 text-left text-[13px] hover:bg-accent/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
								onClick={() =>
									onGroupingChange?.(option.value as SidebarGrouping)
								}
							>
								<Icon className="size-3.5 shrink-0 text-muted-foreground" />
								<span className="min-w-0 flex-1 truncate">{option.label}</span>
								{checked ? (
									<Check className="size-3.5" strokeWidth={2.2} />
								) : null}
							</button>
						);
					})}
				</div>
				<div className="h-px bg-border/60" />
				<div className="px-1 text-[12px] font-medium text-muted-foreground">
					Sort by
				</div>
				<div className="grid gap-0.5">
					{SIDEBAR_SORT_OPTIONS.map((option) => {
						const Icon = option.icon;
						const checked = sort === option.value;
						return (
							<button
								key={option.value}
								type="button"
								role="radio"
								aria-checked={checked}
								className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-1.5 text-left text-[13px] hover:bg-accent/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
								onClick={() => onSortChange?.(option.value)}
							>
								<Icon className="size-3.5 shrink-0 text-muted-foreground" />
								<span className="min-w-0 flex-1 truncate">{option.label}</span>
								{checked ? (
									<Check className="size-3.5" strokeWidth={2.2} />
								) : null}
							</button>
						);
					})}
				</div>
			</PopoverContent>
		</Popover>
	);
}
