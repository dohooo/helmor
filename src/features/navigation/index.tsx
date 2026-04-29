import { useVirtualizer } from "@tanstack/react-virtual";
import {
	Archive,
	Check,
	ChevronRight,
	Folder,
	FolderPlus,
	Globe,
	LayoutList,
	ListTree,
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
	CommandEmpty,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import { CommandPopoverContent } from "@/components/ui/command-popover";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverAnchor } from "@/components/ui/popover";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { InlineShortcutDisplay } from "@/features/shortcuts/shortcut-display";
import type {
	RepositoryCreateOption,
	WorkspaceGroup,
	WorkspaceRow,
	WorkspaceStatus,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { WorkspaceAvatar } from "./avatar";
import { CloneFromUrlDialog } from "./clone-from-url-dialog";
import {
	findSelectedRepoSection,
	groupByRepo,
	type RepoGroup,
	repoStatusSectionId,
} from "./group-by-repo";
import {
	readStoredGroupingMode,
	type SidebarGroupingMode,
	writeStoredGroupingMode,
} from "./grouping-mode";
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

// ---------------------------------------------------------------------------
// Virtual list item types
// ---------------------------------------------------------------------------

type VirtualItem =
	| {
			kind: "group-header";
			groupId: string;
			group: WorkspaceGroup;
			canCollapse: boolean;
			indent?: number;
	  }
	| {
			kind: "repo-header";
			sectionId: string;
			repo: RepoGroup;
			canCollapse: boolean;
	  }
	| {
			kind: "row";
			groupId: string;
			row: WorkspaceRow;
			isArchived: boolean;
			indent?: number;
	  }
	| { kind: "group-gap"; size: number }
	| { kind: "bottom-padding" };

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
	archivedRows,
	availableRepositories,
	addingRepository,
	selectedWorkspaceId,
	sendingWorkspaceIds,
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
	onCreateWorkspace,
	onArchiveWorkspace,
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
	archivedRows: WorkspaceRow[];
	availableRepositories?: RepositoryCreateOption[];
	addingRepository?: boolean;
	selectedWorkspaceId?: string | null;
	sendingWorkspaceIds?: Set<string>;
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
	onCreateWorkspace?: (repoId: string) => void;
	onArchiveWorkspace?: (workspaceId: string) => void;
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
	const [isRepoPickerOpen, setIsRepoPickerOpen] = useState(false);
	const [isAddRepositoryMenuOpen, setIsAddRepositoryMenuOpen] = useState(false);
	const [isGroupingMenuOpen, setIsGroupingMenuOpen] = useState(false);
	const [groupingMode, setGroupingModeState] = useState<SidebarGroupingMode>(
		readStoredGroupingMode,
	);
	const scrollContainerRef = useRef<HTMLDivElement>(null);
	const repoCommandListRef = useRef<HTMLDivElement | null>(null);
	const [sectionOpenState, setSectionOpenState] = useState(() => ({
		...createInitialSectionOpenState(groups),
		...readStoredSectionOpenState(),
	}));

	const setGroupingMode = useCallback((mode: SidebarGroupingMode) => {
		setGroupingModeState(mode);
		writeStoredGroupingMode(mode);
	}, []);

	// ── Re-bucketed view when "by-repo" mode is active ─────────────────
	const repoView = useMemo(
		() => (groupingMode === "by-repo" ? groupByRepo(groups) : null),
		[groupingMode, groups],
	);

	useEffect(() => {
		setSectionOpenState((current) => {
			const next: Record<string, boolean> = { ...current };
			let changed = false;

			const ensure = (key: string, fallback: boolean) => {
				if (next[key] === undefined) {
					next[key] = fallback;
					changed = true;
				}
			};

			for (const group of groups) {
				ensure(group.id, true);
			}

			if (repoView) {
				for (const repo of repoView.repos) {
					ensure(repo.id, true);
					for (const statusGroup of repo.statusGroups) {
						ensure(repoStatusSectionId(repo.repoKey, statusGroup.id), true);
					}
				}
			}

			ensure(ARCHIVED_SECTION_ID, false);

			return changed ? next : current;
		});
	}, [archivedRows, groups, repoView]);

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

		const sectionsToOpen: string[] = [];

		if (repoView) {
			const match = findSelectedRepoSection(
				selectedWorkspaceId,
				repoView.repos,
			);
			if (match) {
				sectionsToOpen.push(match.repoSectionId, match.statusSectionId);
			}
		}

		if (sectionsToOpen.length === 0) {
			const fallbackSectionId = findSelectedSectionId(
				selectedWorkspaceId,
				groups,
				archivedRows,
			);
			if (fallbackSectionId) {
				sectionsToOpen.push(fallbackSectionId);
			}
		}

		if (sectionsToOpen.length === 0) {
			return;
		}

		lastAutoExpandedIdRef.current = selectedWorkspaceId;
		setSectionOpenState((current) => {
			let next = current;
			for (const sectionId of sectionsToOpen) {
				if (!next[sectionId]) {
					next = { ...next, [sectionId]: true };
				}
			}
			return next;
		});
	}, [archivedRows, groups, repoView, selectedWorkspaceId]);

	// ── Flatten groups into virtual items ──────────────────────────────
	const flatItems = useMemo(() => {
		const items: VirtualItem[] = [];
		let lastSectionHadRows = false;

		const pushGap = (nextHasRows: boolean) => {
			items.push({
				kind: "group-gap",
				size: getGroupGapSize(lastSectionHadRows, nextHasRows),
			});
		};

		if (repoView) {
			// 1. Pinned group always renders at the top when non-empty.
			if (repoView.pinned && repoView.pinned.rows.length > 0) {
				const pinnedGroup = repoView.pinned;
				items.push({
					kind: "group-header",
					groupId: pinnedGroup.id,
					group: pinnedGroup,
					canCollapse: true,
				});
				if (sectionOpenState[pinnedGroup.id] !== false) {
					for (const row of pinnedGroup.rows) {
						items.push({
							kind: "row",
							groupId: pinnedGroup.id,
							row,
							isArchived: false,
						});
					}
				}
				lastSectionHadRows = pinnedGroup.rows.length > 0;
			}

			// 2. Each repository as a top-level section, with status sub-groups.
			for (const repo of repoView.repos) {
				if (items.length > 0) {
					pushGap(repo.totalCount > 0);
				}
				items.push({
					kind: "repo-header",
					sectionId: repo.id,
					repo,
					canCollapse: repo.totalCount > 0,
				});

				const repoOpen = sectionOpenState[repo.id] !== false;
				if (repoOpen) {
					for (const statusGroup of repo.statusGroups) {
						if (statusGroup.rows.length === 0) {
							continue;
						}
						const nestedSectionId = repoStatusSectionId(
							repo.repoKey,
							statusGroup.id,
						);
						items.push({
							kind: "group-header",
							groupId: nestedSectionId,
							group: statusGroup,
							canCollapse: true,
							indent: 1,
						});
						if (sectionOpenState[nestedSectionId] !== false) {
							for (const row of statusGroup.rows) {
								items.push({
									kind: "row",
									groupId: nestedSectionId,
									row,
									isArchived: false,
									indent: 1,
								});
							}
						}
					}
				}
				lastSectionHadRows = repo.totalCount > 0;
			}
		} else {
			const visibleGroups = groups.filter(
				(g) => g.id !== "pinned" || g.rows.length > 0,
			);

			for (let gi = 0; gi < visibleGroups.length; gi++) {
				const group = visibleGroups[gi];
				if (gi > 0) {
					pushGap(group.rows.length > 0);
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
				lastSectionHadRows = group.rows.length > 0;
			}
		}

		// Archived section (always at the bottom regardless of mode)
		items.push({
			kind: "group-gap",
			size: getGroupGapSize(lastSectionHadRows, archivedRows.length > 0),
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
	}, [groups, archivedRows, sectionOpenState, repoView]);

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
					return HEADER_HEIGHT;
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
					return `repo-header-${item.sectionId}`;
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
	const repositories = availableRepositories ?? [];

	useEffect(() => {
		const handleOpenNewWorkspace = () => {
			if (addRepositoryBusy || createBusy || workspaceActionsBusy) return;
			setIsRepoPickerOpen(true);
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
	}, [addRepositoryBusy, createBusy, workspaceActionsBusy]);

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

	// ── Render a single virtual item ──────────────────────────────────
	const renderItem = useCallback(
		(item: VirtualItem) => {
			if (item.kind === "group-gap" || item.kind === "bottom-padding") {
				return null;
			}

			if (item.kind === "repo-header") {
				const isOpen = sectionOpenState[item.sectionId] ?? true;
				const isEmptyGroup = item.repo.totalCount === 0;

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
						onClick={() => toggleSection(item.sectionId)}
					>
						<span className="flex min-w-0 items-center gap-2">
							<WorkspaceAvatar
								repoIconSrc={item.repo.repoIconSrc}
								repoInitials={item.repo.repoInitials}
								repoName={item.repo.label}
								title={item.repo.label}
								className="size-[14px] rounded-[4px]"
								fallbackClassName="text-[7px]"
							/>
							<span className="truncate">{item.repo.label}</span>
						</span>

						{item.repo.totalCount > 0 ? (
							<span className="relative flex h-5 min-w-5 items-center justify-center">
								<Badge
									variant="secondary"
									className="h-4 min-w-[16px] justify-center rounded-full px-1 text-[9.5px] leading-none transition-opacity group-hover/trigger:opacity-0"
								>
									{item.repo.totalCount}
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

			if (item.kind === "group-header") {
				const isOpen =
					item.groupId === ARCHIVED_SECTION_ID
						? (sectionOpenState[item.groupId] ?? false)
						: (sectionOpenState[item.groupId] ?? true);
				const isArchived = item.groupId === ARCHIVED_SECTION_ID;
				const isEmptyGroup = item.group.rows.length === 0;
				const isNested = Boolean(item.indent && item.indent > 0);

				return (
					<button
						type="button"
						className={cn(
							"group/trigger flex select-none items-center justify-between rounded-lg px-2 text-[13px] tracking-[-0.01em] text-foreground hover:bg-accent/60",
							"py-1",
							isNested
								? "ml-4 w-[calc(100%-1rem)] font-medium text-[12px]"
								: "w-full font-semibold",
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
								<Badge
									variant="secondary"
									className="h-4 min-w-[16px] justify-center rounded-full px-1 text-[9.5px] leading-none transition-opacity group-hover/trigger:opacity-0"
								>
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
			const rowIndentClass = item.indent && item.indent > 0 ? "pl-6" : "pl-2";
			return (
				<div className={rowIndentClass}>
					<WorkspaceRowItem
						row={item.row}
						selected={selectedWorkspaceId === item.row.id}
						isSending={sendingWorkspaceIds?.has(item.row.id)}
						isInteractionRequired={interactionRequiredWorkspaceIds?.has(
							item.row.id,
						)}
						onSelect={onSelectWorkspace}
						onPrefetch={onPrefetchWorkspace}
						onArchiveWorkspace={onArchiveWorkspace}
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
			sectionOpenState,
			toggleSection,
			selectedWorkspaceId,
			sendingWorkspaceIds,
			interactionRequiredWorkspaceIds,
			onSelectWorkspace,
			onPrefetchWorkspace,
			onArchiveWorkspace,
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

			<div className="flex items-center justify-between px-3">
				<h2 className="text-[14px] font-medium tracking-[-0.01em] text-muted-foreground">
					Workspaces
				</h2>

				<div className="flex items-center gap-1 text-muted-foreground">
					<DropdownMenu
						open={isGroupingMenuOpen}
						onOpenChange={setIsGroupingMenuOpen}
					>
						<Tooltip>
							<TooltipTrigger asChild>
								<DropdownMenuTrigger asChild>
									<Button
										type="button"
										aria-label="Change grouping"
										variant="ghost"
										size="icon-xs"
										className="text-muted-foreground"
									>
										{groupingMode === "by-repo" ? (
											<ListTree className="size-4" strokeWidth={2} />
										) : (
											<LayoutList className="size-4" strokeWidth={2} />
										)}
									</Button>
								</DropdownMenuTrigger>
							</TooltipTrigger>
							<TooltipContent
								side="top"
								sideOffset={4}
								className="flex h-[24px] items-center gap-2 rounded-md px-2 text-[12px] leading-none"
							>
								<span>
									{groupingMode === "by-repo"
										? "Grouped by repository"
										: "Grouped by status"}
								</span>
							</TooltipContent>
						</Tooltip>
						<DropdownMenuContent align="end" className="min-w-44">
							<DropdownMenuItem
								onSelect={() => {
									setGroupingMode("by-status");
								}}
							>
								<Check
									className={cn(
										"size-4",
										groupingMode === "by-status" ? "opacity-100" : "opacity-0",
									)}
									strokeWidth={2.4}
								/>
								<span>Group by status</span>
							</DropdownMenuItem>
							<DropdownMenuItem
								onSelect={() => {
									setGroupingMode("by-repo");
								}}
							>
								<Check
									className={cn(
										"size-4",
										groupingMode === "by-repo" ? "opacity-100" : "opacity-0",
									)}
									strokeWidth={2.4}
								/>
								<span>Group by repository</span>
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>

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
									setIsRepoPickerOpen(false);
									onAddRepository?.();
								}}
							>
								<Folder strokeWidth={2} />
								<span>Open project</span>
							</DropdownMenuItem>
							<DropdownMenuItem
								onSelect={() => {
									setIsRepoPickerOpen(false);
									onOpenCloneDialog?.();
								}}
							>
								<Globe strokeWidth={2} />
								<span>Clone from URL</span>
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>

					<Popover open={isRepoPickerOpen} onOpenChange={setIsRepoPickerOpen}>
						<PopoverAnchor asChild>
							<span className="inline-flex">
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											type="button"
											aria-label="New workspace"
											aria-expanded={isRepoPickerOpen}
											aria-haspopup="dialog"
											variant="ghost"
											size="icon-xs"
											disabled={
												addRepositoryBusy || createBusy || workspaceActionsBusy
											}
											onClick={() => {
												if (
													addRepositoryBusy ||
													createBusy ||
													workspaceActionsBusy
												) {
													return;
												}

												setIsRepoPickerOpen((open) => !open);
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
							</span>
						</PopoverAnchor>
						<CommandPopoverContent
							align="end"
							sideOffset={4}
							className="w-fit min-w-[220px] max-w-[min(90vw,28rem)]"
							onOpenAutoFocus={(event) => {
								event.preventDefault();
								window.requestAnimationFrame(() =>
									repoCommandListRef.current?.focus(),
								);
							}}
						>
							<CommandList
								ref={repoCommandListRef}
								tabIndex={0}
								className="max-h-64 outline-none"
							>
								<CommandEmpty>No repositories found.</CommandEmpty>
								{repositories.map((repository) => (
									<CommandItem
										key={repository.id}
										value={`${repository.name} ${repository.defaultBranch ?? ""}`}
										onSelect={() => {
											setIsRepoPickerOpen(false);
											onCreateWorkspace?.(repository.id);
										}}
										className="rounded-lg [&>svg:last-child]:hidden"
									>
										<div className="flex min-w-0 flex-1 items-center justify-between gap-3">
											<div className="flex min-w-0 items-center gap-2">
												<WorkspaceAvatar
													repoIconSrc={repository.repoIconSrc}
													repoInitials={repository.repoInitials}
													repoName={repository.name}
													title={repository.name}
													className="size-5 rounded-md"
													fallbackClassName="text-[8px]"
												/>
												<span className="truncate font-medium">
													{repository.name}
												</span>
											</div>
											{repository.defaultBranch ? (
												<span className="shrink-0 text-right whitespace-nowrap text-xs text-muted-foreground">
													{repository.remote ?? "origin"}/
													{repository.defaultBranch.toLowerCase()}
												</span>
											) : null}
										</div>
									</CommandItem>
								))}
							</CommandList>
						</CommandPopoverContent>
					</Popover>
				</div>
			</div>

			{/* Virtualized workspace list */}
			<div
				ref={scrollContainerRef}
				data-slot="workspace-groups-scroll"
				className="scrollbar-stable relative mt-2 min-h-0 flex-1 overflow-y-auto pr-1 pl-2 [scrollbar-width:thin]"
			>
				<div
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
