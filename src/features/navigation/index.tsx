import { useVirtualizer } from "@tanstack/react-virtual";
import {
	Archive,
	ChevronRight,
	FolderPlus,
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Command,
	CommandEmpty,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import {
	Popover,
	PopoverAnchor,
	PopoverContent,
} from "@/components/ui/popover";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import type {
	RepositoryCreateOption,
	WorkspaceGroup,
	WorkspaceRow,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { WorkspaceAvatar } from "./avatar";
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
	  }
	| { kind: "row"; groupId: string; row: WorkspaceRow; isArchived: boolean }
	| { kind: "group-gap"; size: number }
	| { kind: "bottom-padding" };

const HEADER_HEIGHT = 34; // tighter header + minimal gap below
const EMPTY_HEADER_HEIGHT = 24; // tighter header for empty groups
const ROW_HEIGHT = 32; // 30px (h-7.5) + 2px gap
const GROUP_GAP = 8; // tighter gap between populated groups
const EMPTY_GROUP_GAP = 8; // tighter spacing around empty groups
const BOTTOM_PADDING = 24; // pb-6

function getGroupHeaderHeight(hasRows: boolean) {
	return hasRows ? HEADER_HEIGHT : EMPTY_HEADER_HEIGHT;
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
	completedWorkspaceIds,
	interactionRequiredWorkspaceIds,
	creatingWorkspaceRepoId,
	onAddRepository,
	onSelectWorkspace,
	onPrefetchWorkspace,
	onCreateWorkspace,
	onArchiveWorkspace,
	onMarkWorkspaceUnread,
	onRestoreWorkspace,
	onDeleteWorkspace,
	onTogglePin,
	onSetManualStatus,
	archivingWorkspaceId,
	markingUnreadWorkspaceId,
	restoringWorkspaceId,
}: {
	groups: WorkspaceGroup[];
	archivedRows: WorkspaceRow[];
	availableRepositories?: RepositoryCreateOption[];
	addingRepository?: boolean;
	selectedWorkspaceId?: string | null;
	sendingWorkspaceIds?: Set<string>;
	completedWorkspaceIds?: Set<string>;
	interactionRequiredWorkspaceIds?: Set<string>;
	creatingWorkspaceRepoId?: string | null;
	onAddRepository?: () => void;
	onSelectWorkspace?: (workspaceId: string) => void;
	onPrefetchWorkspace?: (workspaceId: string) => void;
	onCreateWorkspace?: (repoId: string) => void;
	onArchiveWorkspace?: (workspaceId: string) => void;
	onMarkWorkspaceUnread?: (workspaceId: string) => void;
	onRestoreWorkspace?: (workspaceId: string) => void;
	onDeleteWorkspace?: (workspaceId: string) => void;
	onTogglePin?: (workspaceId: string, currentlyPinned: boolean) => void;
	onSetManualStatus?: (workspaceId: string, status: string | null) => void;
	archivingWorkspaceId?: string | null;
	markingUnreadWorkspaceId?: string | null;
	restoringWorkspaceId?: string | null;
}) {
	const [isRepoPickerOpen, setIsRepoPickerOpen] = useState(false);
	const scrollContainerRef = useRef<HTMLDivElement>(null);
	const [sectionOpenState, setSectionOpenState] = useState(() => ({
		...createInitialSectionOpenState(groups),
		...readStoredSectionOpenState(),
	}));

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

	useEffect(() => {
		const selectedSectionId = findSelectedSectionId(
			selectedWorkspaceId,
			groups,
			archivedRows,
		);

		if (!selectedSectionId) {
			return;
		}

		setSectionOpenState((current) =>
			current[selectedSectionId]
				? current
				: { ...current, [selectedSectionId]: true },
		);
	}, [archivedRows, groups, selectedWorkspaceId]);

	// ── Flatten groups into virtual items ──────────────────────────────
	const flatItems = useMemo(() => {
		const items: VirtualItem[] = [];
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

		// Archived section
		const previousGroup = visibleGroups.at(-1);
		items.push({
			kind: "group-gap",
			size: getGroupGapSize(
				(previousGroup?.rows.length ?? 0) > 0,
				archivedRows.length > 0,
			),
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
	}, [groups, archivedRows, sectionOpenState]);

	// ── Virtualizer ───────────────────────────────────────────────────
	const virtualizer = useVirtualizer({
		count: flatItems.length,
		getScrollElement: () => scrollContainerRef.current,
		estimateSize: (index) => {
			const item = flatItems[index];
			switch (item.kind) {
				case "group-header":
					return getGroupHeaderHeight(item.group.rows.length > 0);
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
				case "row":
					return `row-${item.row.id}`;
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
		addingRepository ||
			archivingWorkspaceId ||
			markingUnreadWorkspaceId ||
			restoringWorkspaceId,
	);
	const createBusy = Boolean(creatingWorkspaceRepoId);
	const addRepositoryBusy = Boolean(addingRepository);
	const repositories = availableRepositories ?? [];

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
							isEmptyGroup ? "py-0.5" : "py-1",
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
			return (
				<div className="pl-2">
					<WorkspaceRowItem
						row={item.row}
						selected={selectedWorkspaceId === item.row.id}
						isSending={sendingWorkspaceIds?.has(item.row.id)}
						isCompleted={completedWorkspaceIds?.has(item.row.id)}
						isInteractionRequired={interactionRequiredWorkspaceIds?.has(
							item.row.id,
						)}
						onSelect={onSelectWorkspace}
						onPrefetch={onPrefetchWorkspace}
						onArchiveWorkspace={onArchiveWorkspace}
						onMarkWorkspaceUnread={onMarkWorkspaceUnread}
						onTogglePin={onTogglePin}
						onSetManualStatus={onSetManualStatus}
						archivingWorkspaceId={archivingWorkspaceId}
						markingUnreadWorkspaceId={markingUnreadWorkspaceId}
						restoringWorkspaceId={restoringWorkspaceId}
						workspaceActionsDisabled={Boolean(
							creatingWorkspaceRepoId ||
								archivingWorkspaceId ||
								markingUnreadWorkspaceId ||
								restoringWorkspaceId,
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
			completedWorkspaceIds,
			interactionRequiredWorkspaceIds,
			onSelectWorkspace,
			onPrefetchWorkspace,
			onArchiveWorkspace,
			onMarkWorkspaceUnread,
			onRestoreWorkspace,
			onDeleteWorkspace,
			onTogglePin,
			onSetManualStatus,
			archivingWorkspaceId,
			markingUnreadWorkspaceId,
			restoringWorkspaceId,
			creatingWorkspaceRepoId,
		],
	);

	return (
		<div className="flex h-full min-h-0 flex-col overflow-hidden pb-4">
			<div
				data-slot="window-safe-top"
				className="flex h-9 shrink-0 items-center pr-3"
			>
				<div data-tauri-drag-region className="h-full w-[94px] shrink-0" />
				<div data-tauri-drag-region className="h-full flex-1" />
			</div>

			<div className="flex items-center justify-between px-3">
				<h2 className="text-[13px] font-medium tracking-[-0.01em] text-muted-foreground">
					Workspaces
				</h2>

				<div className="flex items-center gap-1 text-muted-foreground">
					<Tooltip>
						<TooltipTrigger asChild>
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
								onClick={() => {
									if (addRepositoryBusy || createBusy || workspaceActionsBusy) {
										return;
									}

									setIsRepoPickerOpen(false);
									onAddRepository?.();
								}}
							>
								{addRepositoryBusy ? (
									<LoaderCircle className="animate-spin" strokeWidth={2.1} />
								) : (
									<FolderPlus strokeWidth={2} />
								)}
							</Button>
						</TooltipTrigger>
						<TooltipContent
							side="top"
							sideOffset={8}
							className="flex h-[22px] items-center rounded-md px-1.5 text-[11px] leading-none"
						>
							<span>Add repository</span>
						</TooltipContent>
					</Tooltip>

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
													className="animate-spin"
													strokeWidth={2.1}
												/>
											) : (
												<Plus strokeWidth={2.4} />
											)}
										</Button>
									</TooltipTrigger>
									<TooltipContent
										side="top"
										sideOffset={8}
										className="flex h-[22px] items-center rounded-md px-1.5 text-[11px] leading-none"
									>
										<span>Add workspace</span>
									</TooltipContent>
								</Tooltip>
							</span>
						</PopoverAnchor>
						<PopoverContent
							align="end"
							sideOffset={8}
							className="w-[296px] p-0"
						>
							<Command>
								<CommandList className="max-h-64">
									<CommandEmpty>No repositories found.</CommandEmpty>
									{repositories.map((repository) => (
										<CommandItem
											key={repository.id}
											value={`${repository.name} ${repository.defaultBranch ?? ""}`}
											onSelect={() => {
												setIsRepoPickerOpen(false);
												onCreateWorkspace?.(repository.id);
											}}
											className="rounded-lg"
										>
											<WorkspaceAvatar
												repoIconSrc={repository.repoIconSrc}
												repoInitials={repository.repoInitials}
												repoName={repository.name}
												title={repository.name}
												className="size-5 rounded-md"
												fallbackClassName="text-[8px]"
											/>
											<span className="min-w-0 flex-1 truncate font-medium">
												{repository.name}
											</span>
											{repository.defaultBranch ? (
												<span className="shrink-0 text-xs text-muted-foreground">
													{repository.remote ?? "origin"}/
													{repository.defaultBranch.toLowerCase()}
												</span>
											) : null}
										</CommandItem>
									))}
								</CommandList>
							</Command>
						</PopoverContent>
					</Popover>
				</div>
			</div>

			{/* Virtualized workspace list */}
			<div
				ref={scrollContainerRef}
				data-slot="workspace-groups-scroll"
				className="scrollbar-stable relative mt-4 min-h-0 flex-1 overflow-y-auto px-2 pr-1"
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
