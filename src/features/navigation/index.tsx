import { useVirtualizer } from "@tanstack/react-virtual";
import {
	Archive,
	ChevronDown,
	ChevronRight,
	CircleDot,
	Folder,
	FolderGit2,
	FolderPlus,
	Globe,
	History,
	LayoutDashboard,
	ListChecks,
	LoaderCircle,
	Plus,
} from "lucide-react";
import {
	memo,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { TrafficLightSpacer } from "@/components/chrome/traffic-light-spacer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { InlineShortcutDisplay } from "@/features/shortcuts/shortcut-display";
import type { WorkspaceGroup, WorkspaceRow, WorkspaceStatus } from "@/lib/api";
import { cn } from "@/lib/utils";
import { WorkspaceAvatar } from "./avatar";
import { CloneFromUrlDialog } from "./clone-from-url-dialog";
import {
	createInitialSectionOpenState,
	readStoredSectionOpenState,
	writeStoredSectionOpenState,
} from "./open-state";
import { WorkspaceRowItem } from "./row-item";
import {
	ARCHIVED_SECTION_ID,
	findSelectedSectionId,
	GroupIcon,
} from "./shared";
import type { RepositoryGroup } from "./sidebar-projection";

// ---------------------------------------------------------------------------
// Virtual list item types
// ---------------------------------------------------------------------------

type VirtualItem =
	| {
			kind: "group-header";
			groupId: string;
			group: WorkspaceGroup;
			canCollapse: boolean;
	  }
	| {
			kind: "repo-header";
			groupId: string;
			repo: RepositoryGroup;
			canCollapse: boolean;
	  }
	| { kind: "row"; groupId: string; row: WorkspaceRow; isArchived: boolean }
	| { kind: "group-gap"; size: number }
	| { kind: "bottom-padding" };

export type SidebarViewMode = "status" | "repositories";

const REPO_HEADER_HEIGHT = 36;

const HEADER_HEIGHT = 34; // unified header height for all groups
const ROW_HEIGHT = 32; // 30px (h-7.5) + 2px gap
const GROUP_GAP = 8; // tighter gap between populated groups
const EMPTY_GROUP_GAP = 8; // tighter spacing around empty groups
const BOTTOM_PADDING = 8;

function getGroupHeaderHeight(_hasRows: boolean) {
	return HEADER_HEIGHT;
}

function getGroupGapSize(previousHasRows: boolean, nextHasRows: boolean) {
	return previousHasRows && nextHasRows ? GROUP_GAP : EMPTY_GROUP_GAP;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const WorkspacesSidebar = memo(function WorkspacesSidebar({
	groups,
	repositoryGroups = [],
	archivedRows,
	addingRepository,
	selectedWorkspaceId,
	busyWorkspaceIds,
	interactionRequiredWorkspaceIds,
	newWorkspaceShortcut,
	addRepositoryShortcut,
	creatingWorkspaceRepoId,
	onAddRepository,
	onOpenCloneDialog,
	isCloneDialogOpen,
	onCloneDialogOpenChange,
	cloneDefaultDirectory,
	onSubmitClone,
	onSelectWorkspace,
	onPrefetchWorkspace,
	onOpenNewWorkspace,
	onArchiveWorkspace,
	onMoveLocalToWorktree,
	onMarkWorkspaceUnread,
	onRestoreWorkspace,
	onDeleteWorkspace,
	onOpenInFinder,
	onTogglePin,
	onSetWorkspaceStatus,
	archivingWorkspaceIds,
	markingUnreadWorkspaceId,
	restoringWorkspaceId,
}: {
	groups: WorkspaceGroup[];
	repositoryGroups?: RepositoryGroup[];
	archivedRows: WorkspaceRow[];
	addingRepository?: boolean;
	selectedWorkspaceId?: string | null;
	busyWorkspaceIds?: Set<string>;
	interactionRequiredWorkspaceIds?: Set<string>;
	newWorkspaceShortcut?: string | null;
	addRepositoryShortcut?: string | null;
	creatingWorkspaceRepoId?: string | null;
	onAddRepository?: () => void;
	onOpenCloneDialog?: () => void;
	isCloneDialogOpen?: boolean;
	onCloneDialogOpenChange?: (open: boolean) => void;
	cloneDefaultDirectory?: string | null;
	onSubmitClone?: (args: {
		gitUrl: string;
		cloneDirectory: string;
	}) => Promise<void>;
	onSelectWorkspace?: (workspaceId: string) => void;
	onPrefetchWorkspace?: (workspaceId: string) => void;
	onOpenNewWorkspace?: () => void;
	onArchiveWorkspace?: (workspaceId: string) => void;
	onMoveLocalToWorktree?: (workspaceId: string) => void;
	onMarkWorkspaceUnread?: (workspaceId: string) => void;
	onRestoreWorkspace?: (workspaceId: string) => void;
	onDeleteWorkspace?: (workspaceId: string) => void;
	onOpenInFinder?: (workspaceId: string) => void;
	onTogglePin?: (workspaceId: string, currentlyPinned: boolean) => void;
	onSetWorkspaceStatus?: (workspaceId: string, status: WorkspaceStatus) => void;
	archivingWorkspaceIds?: Set<string>;
	markingUnreadWorkspaceId?: string | null;
	restoringWorkspaceId?: string | null;
}) {
	const [isAddRepositoryMenuOpen, setIsAddRepositoryMenuOpen] = useState(false);
	const [isViewModeMenuOpen, setIsViewModeMenuOpen] = useState(false);
	const scrollContainerRef = useRef<HTMLDivElement>(null);
	// View mode is in-memory only — every fresh app start defaults to "status".
	const [viewMode, setViewMode] = useState<SidebarViewMode>("status");
	const [sectionOpenState, setSectionOpenState] = useState(() => ({
		...createInitialSectionOpenState(groups),
		...readStoredSectionOpenState(),
	}));
	const [repoOpenState, setRepoOpenState] = useState<Record<string, boolean>>(
		() => ({}),
	);

	useEffect(() => {
		setSectionOpenState((current) => {
			const next: Record<string, boolean> = {};
			let changed = false;

			for (const group of groups) {
				const nextValue = current[group.id] ?? true;
				next[group.id] = nextValue;
				if (current[group.id] !== nextValue) {
					changed = true;
				}
			}

			const archivedValue = current[ARCHIVED_SECTION_ID] ?? false;
			next[ARCHIVED_SECTION_ID] = archivedValue;
			if (current[ARCHIVED_SECTION_ID] !== archivedValue) {
				changed = true;
			}

			if (Object.keys(current).length !== Object.keys(next).length) {
				changed = true;
			}

			return changed ? next : current;
		});
	}, [archivedRows, groups]);

	useEffect(() => {
		writeStoredSectionOpenState(sectionOpenState);
	}, [sectionOpenState]);

	// Auto-expand the group containing the selected workspace, but ONLY when
	// the selection actually changes — not on every groups refetch (window
	// focus, invalidation, status change). Without this guard, collapsed
	// groups reopen whenever their data refreshes.
	const lastAutoExpandedIdRef = useRef<string | null>(null);
	useEffect(() => {
		if (
			!selectedWorkspaceId ||
			selectedWorkspaceId === lastAutoExpandedIdRef.current
		) {
			return;
		}

		const selectedSectionId = findSelectedSectionId(
			selectedWorkspaceId,
			groups,
			archivedRows,
		);

		if (!selectedSectionId) {
			return;
		}

		lastAutoExpandedIdRef.current = selectedWorkspaceId;
		setSectionOpenState((current) =>
			current[selectedSectionId]
				? current
				: { ...current, [selectedSectionId]: true },
		);
	}, [archivedRows, groups, selectedWorkspaceId]);

	// Auto-expand the repository containing the selected workspace when in
	// repository mode. Mirrors the status-mode auto-expand above.
	const lastAutoExpandedRepoIdRef = useRef<string | null>(null);
	useEffect(() => {
		if (viewMode !== "repositories") return;
		if (!selectedWorkspaceId) return;
		const cacheKey = `${selectedWorkspaceId}:repo`;
		if (lastAutoExpandedRepoIdRef.current === cacheKey) return;
		const containing = repositoryGroups.find((repo) =>
			repo.rows.some((row) => row.id === selectedWorkspaceId),
		);
		if (!containing) return;
		lastAutoExpandedRepoIdRef.current = cacheKey;
		setRepoOpenState((current) =>
			current[containing.id] === false
				? { ...current, [containing.id]: true }
				: current,
		);
	}, [repositoryGroups, selectedWorkspaceId, viewMode]);

	// ── Flatten groups into virtual items ──────────────────────────────
	const flatItems = useMemo(() => {
		const items: VirtualItem[] = [];
		let previousHasRows = false;

		if (viewMode === "status") {
			const visibleGroups = groups.filter(
				(g) => g.id !== "pinned" || g.rows.length > 0,
			);

			for (let gi = 0; gi < visibleGroups.length; gi++) {
				const group = visibleGroups[gi];
				if (gi > 0) {
					const previousGroup = visibleGroups[gi - 1];
					items.push({
						kind: "group-gap",
						size: getGroupGapSize(
							previousGroup.rows.length > 0,
							group.rows.length > 0,
						),
					});
				}

				const canCollapse = group.rows.length > 0;
				items.push({
					kind: "group-header",
					groupId: group.id,
					group,
					canCollapse,
				});

				if (sectionOpenState[group.id] !== false && group.rows.length > 0) {
					for (const row of group.rows) {
						items.push({
							kind: "row",
							groupId: group.id,
							row,
							isArchived: false,
						});
					}
				}
			}

			previousHasRows = (visibleGroups.at(-1)?.rows.length ?? 0) > 0;
		} else {
			// Repository mode
			for (let ri = 0; ri < repositoryGroups.length; ri++) {
				const repo = repositoryGroups[ri];
				if (ri > 0) {
					items.push({
						kind: "group-gap",
						size: getGroupGapSize(previousHasRows, repo.rows.length > 0),
					});
				}
				const canCollapse = repo.rows.length > 0;
				items.push({
					kind: "repo-header",
					groupId: repo.id,
					repo,
					canCollapse,
				});
				if (repoOpenState[repo.id] !== false && repo.rows.length > 0) {
					for (const row of repo.rows) {
						items.push({
							kind: "row",
							groupId: repo.id,
							row,
							isArchived: false,
						});
					}
				}
				previousHasRows = repo.rows.length > 0;
			}
		}

		// Archived section (shared across both view modes)
		items.push({
			kind: "group-gap",
			size: getGroupGapSize(previousHasRows, archivedRows.length > 0),
		});
		items.push({
			kind: "group-header",
			groupId: ARCHIVED_SECTION_ID,
			group: {
				id: ARCHIVED_SECTION_ID,
				label: "Archived",
				tone: "backlog" as WorkspaceGroup["tone"],
				rows: archivedRows,
			},
			canCollapse: archivedRows.length > 0,
		});

		if (sectionOpenState[ARCHIVED_SECTION_ID] && archivedRows.length > 0) {
			for (const row of archivedRows) {
				items.push({
					kind: "row",
					groupId: ARCHIVED_SECTION_ID,
					row,
					isArchived: true,
				});
			}
		}

		items.push({ kind: "bottom-padding" });
		return items;
	}, [
		groups,
		repositoryGroups,
		archivedRows,
		sectionOpenState,
		repoOpenState,
		viewMode,
	]);

	// ── Virtualizer ───────────────────────────────────────────────────
	const virtualizer = useVirtualizer({
		count: flatItems.length,
		getScrollElement: () => scrollContainerRef.current,
		estimateSize: (index) => {
			const item = flatItems[index];
			switch (item.kind) {
				case "group-header":
					return getGroupHeaderHeight(item.group.rows.length > 0);
				case "repo-header":
					return REPO_HEADER_HEIGHT;
				case "row":
					return ROW_HEIGHT;
				case "group-gap":
					return item.size;
				case "bottom-padding":
					return BOTTOM_PADDING;
			}
		},
		getItemKey: (index) => {
			const item = flatItems[index];
			switch (item.kind) {
				case "group-header":
					return `header-${item.groupId}`;
				case "repo-header":
					return `repo-${item.groupId}`;
				case "row":
					return `row-${item.groupId}-${item.row.id}`;
				case "group-gap":
					return `gap-${index}`;
				case "bottom-padding":
					return "bottom-padding";
			}
		},
		overscan: 12,
	});

	// ── Scroll selected into view ─────────────────────────────────────
	useLayoutEffect(() => {
		if (!selectedWorkspaceId) return;

		const targetIndex = flatItems.findIndex(
			(item) => item.kind === "row" && item.row.id === selectedWorkspaceId,
		);
		if (targetIndex === -1) return;

		virtualizer.scrollToIndex(targetIndex, { align: "auto" });
	}, [selectedWorkspaceId, sectionOpenState, flatItems, virtualizer]);

	const workspaceActionsBusy = Boolean(
		addingRepository || markingUnreadWorkspaceId || restoringWorkspaceId,
	);
	const createBusy = Boolean(creatingWorkspaceRepoId);
	const addRepositoryBusy = Boolean(addingRepository);

	useEffect(() => {
		const handleOpenNewWorkspace = () => {
			if (addRepositoryBusy || createBusy || workspaceActionsBusy) return;
			onOpenNewWorkspace?.();
		};

		window.addEventListener(
			"helmor:open-new-workspace",
			handleOpenNewWorkspace,
		);
		return () =>
			window.removeEventListener(
				"helmor:open-new-workspace",
				handleOpenNewWorkspace,
			);
	}, [addRepositoryBusy, createBusy, onOpenNewWorkspace, workspaceActionsBusy]);

	useEffect(() => {
		const handleOpenAddRepository = () => {
			if (addRepositoryBusy || createBusy || workspaceActionsBusy) return;
			setIsAddRepositoryMenuOpen(true);
		};

		window.addEventListener(
			"helmor:open-add-repository",
			handleOpenAddRepository,
		);
		return () =>
			window.removeEventListener(
				"helmor:open-add-repository",
				handleOpenAddRepository,
			);
	}, [addRepositoryBusy, createBusy, workspaceActionsBusy]);

	// ── Toggle section ────────────────────────────────────────────────
	const toggleSection = useCallback((groupId: string) => {
		setSectionOpenState((current) => ({
			...current,
			[groupId]: !current[groupId],
		}));
	}, []);

	const toggleRepo = useCallback((repoId: string) => {
		setRepoOpenState((current) => ({
			...current,
			[repoId]: current[repoId] === false,
		}));
	}, []);

	// ── Render a single virtual item ──────────────────────────────────
	const renderItem = useCallback(
		(item: VirtualItem) => {
			if (item.kind === "group-gap" || item.kind === "bottom-padding") {
				return null;
			}

			if (item.kind === "repo-header") {
				const isOpen = repoOpenState[item.groupId] !== false;
				const isEmptyGroup = item.repo.rows.length === 0;
				return (
					<button
						type="button"
						className={cn(
							"group/trigger flex w-full select-none items-center justify-between rounded-lg px-2 text-[13px] font-semibold text-foreground hover:bg-accent/60",
							"py-1.5",
							item.canCollapse ? "cursor-pointer" : "cursor-default",
						)}
						data-empty-group={isEmptyGroup ? "true" : "false"}
						data-repo-id={item.groupId}
						disabled={!item.canCollapse}
						onClick={() => toggleRepo(item.groupId)}
					>
						<span className="flex min-w-0 items-center gap-2">
							<WorkspaceAvatar
								repoIconSrc={item.repo.repoIconSrc}
								repoInitials={item.repo.repoInitials}
								repoName={item.repo.name}
								title={item.repo.name}
							/>
							<span className="truncate">{item.repo.name}</span>
						</span>

						{item.repo.rows.length > 0 ? (
							<span className="relative flex h-5 min-w-5 items-center justify-center">
								<Badge className="h-4 min-w-[16px] justify-center rounded-full border-transparent bg-sidebar-foreground/10 px-1 text-[9.5px] font-medium leading-none text-sidebar-foreground/70 transition-opacity group-hover/trigger:opacity-0">
									{item.repo.rows.length}
								</Badge>
								<ChevronRight
									className={cn(
										"absolute left-1/2 top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 text-muted-foreground opacity-0 transition-all group-hover/trigger:opacity-100",
										isOpen && "rotate-90",
									)}
									strokeWidth={2}
								/>
							</span>
						) : (
							<span className="text-[10px] font-normal text-muted-foreground/70">
								Empty
							</span>
						)}
					</button>
				);
			}

			if (item.kind === "group-header") {
				const isOpen =
					item.groupId === ARCHIVED_SECTION_ID
						? (sectionOpenState[item.groupId] ?? false)
						: (sectionOpenState[item.groupId] ?? true);
				const isArchived = item.groupId === ARCHIVED_SECTION_ID;
				const isEmptyGroup = item.group.rows.length === 0;

				return (
					<button
						type="button"
						className={cn(
							"group/trigger flex w-full select-none items-center justify-between rounded-lg px-2 text-[13px] font-semibold tracking-[-0.01em] text-foreground hover:bg-accent/60",
							"py-1",
							item.canCollapse ? "cursor-pointer" : "cursor-default",
						)}
						data-empty-group={isEmptyGroup ? "true" : "false"}
						disabled={!item.canCollapse}
						onClick={() => toggleSection(item.groupId)}
					>
						<span className="flex items-center gap-2">
							{isArchived ? (
								<Archive
									className="size-[14px] shrink-0 text-[var(--workspace-sidebar-status-backlog)]"
									strokeWidth={1.9}
								/>
							) : (
								<GroupIcon tone={item.group.tone} />
							)}
							<span>{item.group.label}</span>
						</span>

						{item.group.rows.length > 0 ? (
							<span className="relative flex h-5 min-w-5 items-center justify-center">
								<Badge className="h-4 min-w-[16px] justify-center rounded-full border-transparent bg-sidebar-foreground/10 px-1 text-[9.5px] font-medium leading-none text-sidebar-foreground/70 transition-opacity group-hover/trigger:opacity-0">
									{item.group.rows.length}
								</Badge>
								<ChevronRight
									className={cn(
										"absolute left-1/2 top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 text-muted-foreground opacity-0 transition-all group-hover/trigger:opacity-100",
										isOpen && "rotate-90",
									)}
									strokeWidth={2}
								/>
							</span>
						) : null}
					</button>
				);
			}

			// kind === "row"
			return (
				<div className="pl-2">
					<WorkspaceRowItem
						variant={
							viewMode === "repositories" && !item.isArchived
								? "repo"
								: "default"
						}
						row={item.row}
						selected={selectedWorkspaceId === item.row.id}
						isSending={busyWorkspaceIds?.has(item.row.id)}
						isInteractionRequired={interactionRequiredWorkspaceIds?.has(
							item.row.id,
						)}
						onSelect={onSelectWorkspace}
						onPrefetch={onPrefetchWorkspace}
						onArchiveWorkspace={onArchiveWorkspace}
						onMoveLocalToWorktree={onMoveLocalToWorktree}
						onMarkWorkspaceUnread={onMarkWorkspaceUnread}
						onOpenInFinder={onOpenInFinder}
						onTogglePin={onTogglePin}
						onSetWorkspaceStatus={onSetWorkspaceStatus}
						archivingWorkspaceIds={archivingWorkspaceIds}
						markingUnreadWorkspaceId={markingUnreadWorkspaceId}
						restoringWorkspaceId={restoringWorkspaceId}
						workspaceActionsDisabled={Boolean(
							markingUnreadWorkspaceId || restoringWorkspaceId,
						)}
						{...(item.isArchived
							? {
									onRestoreWorkspace,
									onDeleteWorkspace,
								}
							: {})}
					/>
				</div>
			);
		},
		[
			viewMode,
			sectionOpenState,
			repoOpenState,
			toggleSection,
			toggleRepo,
			selectedWorkspaceId,
			busyWorkspaceIds,
			interactionRequiredWorkspaceIds,
			onSelectWorkspace,
			onPrefetchWorkspace,
			onArchiveWorkspace,
			onMoveLocalToWorktree,
			onMarkWorkspaceUnread,
			onRestoreWorkspace,
			onDeleteWorkspace,
			onTogglePin,
			onSetWorkspaceStatus,
			archivingWorkspaceIds,
			markingUnreadWorkspaceId,
			restoringWorkspaceId,
			creatingWorkspaceRepoId,
		],
	);

	return (
		<div className="flex h-full min-h-0 flex-col overflow-hidden">
			<CloneFromUrlDialog
				open={isCloneDialogOpen ?? false}
				onOpenChange={(nextOpen) => onCloneDialogOpenChange?.(nextOpen)}
				defaultCloneDirectory={cloneDefaultDirectory ?? null}
				onSubmit={async (args) => {
					if (!onSubmitClone) {
						return;
					}
					await onSubmitClone(args);
				}}
			/>
			<div
				data-slot="window-safe-top"
				className="flex h-9 shrink-0 items-center pr-3"
			>
				<TrafficLightSpacer side="left" width={94} />
				<div data-tauri-drag-region className="h-full flex-1" />
			</div>

			<nav className="mt-1 flex flex-col gap-0.5 px-2">
				<SidebarNavItem icon={LayoutDashboard} label="Dashboard" />
				<SidebarNavItem icon={ListChecks} label="Tasks" />
				<SidebarNavItem icon={History} label="History" />
			</nav>

			<div className="mx-3 mt-2 h-px shrink-0 bg-sidebar-border/60" />

			<div className="mt-2 flex items-center justify-between px-3">
				<DropdownMenu
					open={isViewModeMenuOpen}
					onOpenChange={setIsViewModeMenuOpen}
				>
					<DropdownMenuTrigger asChild>
						<button
							type="button"
							aria-label="Change sidebar grouping"
							className="group/view-mode -ml-1 flex h-7 cursor-pointer items-center gap-1 rounded-md px-1.5 text-[14px] font-medium text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground data-[state=open]:bg-accent/60 data-[state=open]:text-foreground"
						>
							<span>{viewMode === "status" ? "Status" : "Workspaces"}</span>
							<ChevronDown
								className="size-3.5 text-muted-foreground/70 transition-transform duration-200 group-data-[state=open]/view-mode:rotate-180"
								strokeWidth={2}
							/>
						</button>
					</DropdownMenuTrigger>
					<DropdownMenuContent
						align="start"
						className="min-w-40 border-white/10 bg-popover/60 backdrop-blur-xl"
					>
						<DropdownMenuRadioGroup
							value={viewMode}
							onValueChange={(value) => {
								if (value === "status" || value === "repositories") {
									setViewMode(value);
								}
							}}
						>
							<DropdownMenuRadioItem value="status">
								<CircleDot className="size-3.5" strokeWidth={2} />
								<span>Status</span>
							</DropdownMenuRadioItem>
							<DropdownMenuRadioItem value="repositories">
								<FolderGit2 className="size-3.5" strokeWidth={2} />
								<span>Workspaces</span>
							</DropdownMenuRadioItem>
						</DropdownMenuRadioGroup>
					</DropdownMenuContent>
				</DropdownMenu>

				<div className="flex items-center gap-1 text-muted-foreground">
					<DropdownMenu
						open={isAddRepositoryMenuOpen}
						onOpenChange={setIsAddRepositoryMenuOpen}
					>
						<Tooltip>
							<TooltipTrigger asChild>
								<DropdownMenuTrigger asChild>
									<Button
										type="button"
										aria-label="Add repository"
										variant="ghost"
										size="icon-xs"
										disabled={
											addRepositoryBusy || createBusy || workspaceActionsBusy
										}
										className={cn(
											"text-muted-foreground",
											addRepositoryBusy || createBusy || workspaceActionsBusy
												? "cursor-not-allowed opacity-60"
												: undefined,
										)}
									>
										{addRepositoryBusy ? (
											<LoaderCircle
												className="size-4 animate-spin"
												strokeWidth={2.1}
											/>
										) : (
											<FolderPlus className="size-4" strokeWidth={2} />
										)}
									</Button>
								</DropdownMenuTrigger>
							</TooltipTrigger>
							<TooltipContent
								side="top"
								sideOffset={4}
								className="flex h-[24px] items-center gap-2 rounded-md px-2 text-[12px] leading-none"
							>
								<span>Add repository</span>
								{addRepositoryShortcut ? (
									<InlineShortcutDisplay
										hotkey={addRepositoryShortcut}
										className="text-background/60"
									/>
								) : null}
							</TooltipContent>
						</Tooltip>
						<DropdownMenuContent align="end" className="min-w-40">
							<DropdownMenuItem
								onSelect={() => {
									onAddRepository?.();
								}}
							>
								<Folder strokeWidth={2} />
								<span>Open project</span>
							</DropdownMenuItem>
							<DropdownMenuItem
								onSelect={() => {
									onOpenCloneDialog?.();
								}}
							>
								<Globe strokeWidth={2} />
								<span>Clone from URL</span>
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>

					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								aria-label="New workspace"
								variant="ghost"
								size="icon-xs"
								disabled={
									addRepositoryBusy || createBusy || workspaceActionsBusy
								}
								onClick={() => {
									if (addRepositoryBusy || createBusy || workspaceActionsBusy) {
										return;
									}

									onOpenNewWorkspace?.();
								}}
							>
								{createBusy ? (
									<LoaderCircle
										className="size-4 animate-spin"
										strokeWidth={2.1}
									/>
								) : (
									<Plus className="size-4" strokeWidth={2.4} />
								)}
							</Button>
						</TooltipTrigger>
						<TooltipContent
							side="top"
							sideOffset={4}
							className="flex h-[24px] items-center gap-2 rounded-md px-2 text-[12px] leading-none"
						>
							<span>Create new workspace</span>
							{newWorkspaceShortcut ? (
								<InlineShortcutDisplay
									hotkey={newWorkspaceShortcut}
									className="text-background/60"
								/>
							) : null}
						</TooltipContent>
					</Tooltip>
				</div>
			</div>

			{/* Virtualized workspace list */}
			<div
				ref={scrollContainerRef}
				data-slot="workspace-groups-scroll"
				className="scrollbar-stable relative mt-2 min-h-0 flex-1 overflow-y-auto pr-1 pl-2 [scrollbar-width:thin]"
			>
				<div
					key={viewMode}
					className="animate-in fade-in-0 slide-in-from-top-1 duration-200"
					style={{
						height: `${virtualizer.getTotalSize()}px`,
						width: "100%",
						position: "relative",
					}}
				>
					{virtualizer.getVirtualItems().map((vItem) => (
						<div
							key={vItem.key}
							style={{
								position: "absolute",
								top: 0,
								left: 0,
								width: "100%",
								height: `${vItem.size}px`,
								transform: `translateY(${vItem.start}px)`,
							}}
						>
							{renderItem(flatItems[vItem.index])}
						</div>
					))}
				</div>
			</div>
		</div>
	);
});

function SidebarNavItem({
	icon: Icon,
	label,
	onClick,
}: {
	icon: typeof LayoutDashboard;
	label: string;
	onClick?: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="group flex h-7 cursor-pointer items-center gap-2 rounded-md px-2 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
		>
			<Icon className="size-[15px] shrink-0" strokeWidth={1.9} />
			<span className="truncate">{label}</span>
		</button>
	);
}
