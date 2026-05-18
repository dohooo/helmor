import { useVirtualizer } from "@tanstack/react-virtual";
import {
	Archive,
	ChevronRight,
	Folder,
	FolderPlus,
	Globe,
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
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import type { SidebarGrouping, SidebarSort } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { workspaceStatusFromGroupId } from "@/lib/workspace-helpers";
import { useShellEvent } from "@/shell/event-bus";
import { WorkspaceAvatar } from "./avatar";
import { CloneFromUrlDialog } from "./clone-from-url-dialog";
import { RepoDragGhost, WorkspaceDragGhost } from "./dnd/drag-ghosts";
import { useRepoDnd } from "./dnd/use-repo-dnd";
import {
	useWorkspaceDnd,
	type WorkspaceDndPolicy,
} from "./dnd/use-workspace-dnd";
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
import { repoIdFromGroupId } from "./sidebar-projection";
import { SidebarViewPopover } from "./sidebar-view-popover";

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
	| {
			kind: "drop-placeholder";
			groupId: string;
			beforeWorkspaceId: string | null;
	  }
	// Drop slot for a repo drag — height = full moving-group height,
	// inserted before `beforeRepoId`. Mirrors `drop-placeholder` for
	// workspace drag: dynamic key (so each new target is a fresh mount),
	// invisible, just makes way for other groups whose keys stay stable.
	| {
			kind: "repo-drop-placeholder";
			beforeRepoId: string | null;
			height: number;
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
	availableRepositories = [],
	sidebarGrouping = "status",
	sidebarRepoFilterIds = [],
	sidebarSort = "custom",
	onSidebarGroupingChange,
	onSidebarRepoFilterChange,
	onSidebarSortChange,
	addingRepository,
	selectedWorkspaceId,
	busyWorkspaceIds,
	interactionRequiredWorkspaceIds,
	newWorkspaceShortcut,
	addRepositoryShortcut,
	sidebarFilterShortcut,
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
	onCreateWorkspaceForRepo,
	onArchiveWorkspace,
	onMoveLocalToWorktree,
	onMarkWorkspaceUnread,
	onRestoreWorkspace,
	onDeleteWorkspace,
	onOpenInFinder,
	onTogglePin,
	onMoveWorkspaceInSidebar,
	onMoveRepositoryInSidebar,
	onSetWorkspaceStatus,
	archivingWorkspaceIds,
	markingUnreadWorkspaceId,
	restoringWorkspaceId,
}: {
	groups: WorkspaceGroup[];
	archivedRows: WorkspaceRow[];
	availableRepositories?: RepositoryCreateOption[];
	sidebarGrouping?: SidebarGrouping;
	sidebarRepoFilterIds?: string[];
	sidebarSort?: SidebarSort;
	onSidebarGroupingChange?: (grouping: SidebarGrouping) => void;
	onSidebarRepoFilterChange?: (repoIds: string[]) => void;
	onSidebarSortChange?: (sort: SidebarSort) => void;
	addingRepository?: boolean;
	selectedWorkspaceId?: string | null;
	busyWorkspaceIds?: Set<string>;
	interactionRequiredWorkspaceIds?: Set<string>;
	newWorkspaceShortcut?: string | null;
	addRepositoryShortcut?: string | null;
	sidebarFilterShortcut?: string | null;
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
	/** Open the start page with this repo preselected. Wired on repo
	 *  group headers in `repo` grouping mode. */
	onCreateWorkspaceForRepo?: (repoId: string) => void;
	onArchiveWorkspace?: (workspaceId: string) => void;
	onMoveLocalToWorktree?: (workspaceId: string) => void;
	onMarkWorkspaceUnread?: (workspaceId: string) => void;
	onRestoreWorkspace?: (workspaceId: string) => void;
	onDeleteWorkspace?: (workspaceId: string) => void;
	onOpenInFinder?: (workspaceId: string) => void;
	onTogglePin?: (workspaceId: string, currentlyPinned: boolean) => void;
	onMoveWorkspaceInSidebar?: (
		workspaceId: string,
		targetGroupId: string,
		beforeWorkspaceId: string | null,
	) => void;
	onMoveRepositoryInSidebar?: (
		repoId: string,
		beforeRepoId: string | null,
	) => void;
	onSetWorkspaceStatus?: (workspaceId: string, status: WorkspaceStatus) => void;
	archivingWorkspaceIds?: Set<string>;
	markingUnreadWorkspaceId?: string | null;
	restoringWorkspaceId?: string | null;
}) {
	const [isAddRepositoryMenuOpen, setIsAddRepositoryMenuOpen] = useState(false);
	const [isSidebarViewPopoverOpen, setIsSidebarViewPopoverOpen] =
		useState(false);
	const scrollContainerRef = useRef<HTMLDivElement>(null);
	const dndPolicy = useMemo<WorkspaceDndPolicy>(
		() =>
			sidebarGrouping === "repo"
				? {
						// Repo mode: same-bucket reorder + drag-to-pin /
						// drag-to-backlog + the inverse (un-pin / un-backlog) back
						// to the row's own repo bucket. No cross-repo moves.
						canDragRow: (_row, sourceGroupId) =>
							sourceGroupId === "pinned" ||
							sourceGroupId === "backlog" ||
							repoIdFromGroupId(sourceGroupId) !== null,
						canDropIntoGroup: (
							sourceGroupId,
							targetGroupId,
							{ sourceRepoId },
						) => {
							if (targetGroupId === "pinned") return true;
							if (targetGroupId === "backlog") return true;
							const targetRepoId = repoIdFromGroupId(targetGroupId);
							if (targetRepoId === null) return false;
							if (sourceGroupId === targetGroupId) return true;
							// pinned / backlog → repo bucket: only the row's own repo.
							if (
								(sourceGroupId === "pinned" || sourceGroupId === "backlog") &&
								sourceRepoId === targetRepoId
							)
								return true;
							return false;
						},
					}
				: {
						// Status mode: any lane + pinned (drag to pin / unpin).
						canDragRow: (_row, sourceGroupId) =>
							sourceGroupId === "pinned" ||
							workspaceStatusFromGroupId(sourceGroupId) !== null,
						canDropIntoGroup: (_sourceGroupId, targetGroupId) =>
							targetGroupId === "pinned" ||
							workspaceStatusFromGroupId(targetGroupId) !== null,
					},
		[sidebarGrouping],
	);
	// Drag-to-reorder is only meaningful under custom sort: the dragged
	// position would otherwise be immediately overruled by the active sort
	// key. Disable the gesture entirely instead of pretending it works.
	const dragReorderEnabled = sidebarSort === "custom";
	const { dragState, dropTarget, startDragGesture } = useWorkspaceDnd({
		onMoveWorkspace: dragReorderEnabled ? onMoveWorkspaceInSidebar : undefined,
		policy: dndPolicy,
	});
	const {
		dragState: repoDragState,
		dropIndicator: repoDropIndicator,
		startRepoDragGesture,
	} = useRepoDnd({
		onMoveRepo: dragReorderEnabled ? onMoveRepositoryInSidebar : undefined,
	});
	const activeRepoDragId = repoDragState?.repoId ?? null;
	const repoDropBeforeId = repoDropIndicator?.beforeRepoId ?? null;
	const activeDragWorkspaceId = dragState?.workspaceId ?? null;
	const dropTargetGroupId = dropTarget?.groupId ?? null;
	const dropTargetBeforeWorkspaceId = dropTarget?.beforeWorkspaceId ?? null;
	// Stable derived booleans — dragState/repoDragState get a new ref
	// every pointermove frame; using these keeps downstream memos hot.
	const isWorkspaceDragging = dragState !== null;
	const isRepoDragging = repoDragState !== null;
	const isAnyDragging = isWorkspaceDragging || isRepoDragging;
	const activeDragRow = useMemo(() => {
		if (!activeDragWorkspaceId) return null;
		for (const group of groups) {
			const row = group.rows.find((item) => item.id === activeDragWorkspaceId);
			if (row) return row;
		}
		return archivedRows.find((row) => row.id === activeDragWorkspaceId) ?? null;
	}, [activeDragWorkspaceId, archivedRows, groups]);
	/** Group currently under repo-drag — rows feed the ghost. */
	const repoDragGroup = useMemo(() => {
		if (!activeRepoDragId) return null;
		const groupId = `repo:${activeRepoDragId}`;
		return groups.find((g) => g.id === groupId) ?? null;
	}, [activeRepoDragId, groups]);
	// Empty `pinned` reveals only after the user drags near the top of the
	// list (avoids a visible jump on every drag start), and is sticky for
	// the rest of the drag — once shown it stays shown until release, so
	// dragging back down doesn't flicker the slot away.
	const [pinnedSlotReady, setPinnedSlotReady] = useState(false);
	useEffect(() => {
		if (!dragState) {
			setPinnedSlotReady(false);
			return;
		}
		setPinnedSlotReady((current) => {
			if (current) return current;
			const sidebar = scrollContainerRef.current;
			if (!sidebar) return current;
			const sidebarTop = sidebar.getBoundingClientRect().top;
			const ghostCentre =
				dragState.clientY - dragState.offsetY + dragState.height / 2;
			return ghostCentre < sidebarTop + HEADER_HEIGHT + ROW_HEIGHT;
		});
	}, [dragState]);
	const [sectionOpenState, setSectionOpenState] = useState(() => ({
		...createInitialSectionOpenState(groups),
		...readStoredSectionOpenState(sidebarGrouping),
	}));

	// Each grouping mode (status / repo) keeps its own expand-collapse
	// memory under a distinct localStorage key. Switching modes
	// re-hydrates from the new key; subsequent edits flow back to that
	// key. The rehydrate + write are intentionally in the SAME effect
	// (`return` after rehydrate, write on the fallthrough branch) so
	// they can't race: on the render that bumps `sidebarGrouping`, the
	// effect rehydrates and bails out — the next render then runs the
	// write branch with the freshly-loaded state. Splitting these into
	// two effects briefly persists the previous mode's state under the
	// new key, and any hot-reload / crash inside that window corrupts
	// the persisted blob.
	const previousGroupingRef = useRef(sidebarGrouping);
	useEffect(() => {
		if (previousGroupingRef.current !== sidebarGrouping) {
			previousGroupingRef.current = sidebarGrouping;
			setSectionOpenState({
				...createInitialSectionOpenState(groups),
				...readStoredSectionOpenState(sidebarGrouping),
			});
			return;
		}
		writeStoredSectionOpenState(sidebarGrouping, sectionOpenState);
	}, [groups, sidebarGrouping, sectionOpenState]);

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

	// ── Flatten groups into virtual items ──────────────────────────────
	const flatItems = useMemo(() => {
		const items: VirtualItem[] = [];
		// Reveal empty pinned only when the user drags up to it, to avoid
		// a layout jump on every drag start.
		const showEmptyPinned = pinnedSlotReady;
		const visibleGroups = groups.filter(
			(g) => g.id !== "pinned" || g.rows.length > 0 || showEmptyPinned,
		);

		// Repo drag works the same way as workspace drag now: don't reorder
		// `visibleGroups`. Instead, skip the moving group entirely and
		// inject a single repo-drop-placeholder before whichever group
		// `repoDropBeforeId` points at. Other groups keep their stable
		// (key, position) pair so CSS transitions trigger reliably in both
		// directions.
		const draggingGroupId = activeRepoDragId
			? `repo:${activeRepoDragId}`
			: null;
		const movingGroupHeight = ((): number => {
			if (!draggingGroupId) return 0;
			const moving = visibleGroups.find((g) => g.id === draggingGroupId);
			if (!moving) return 0;
			const isOpen = sectionOpenState[moving.id] !== false;
			return HEADER_HEIGHT + (isOpen ? moving.rows.length * ROW_HEIGHT : 0);
		})();
		const repoDropTargetGroupId =
			activeRepoDragId && repoDropBeforeId ? `repo:${repoDropBeforeId}` : null;
		let repoPlaceholderEmitted = false;

		for (let gi = 0; gi < visibleGroups.length; gi++) {
			const group = visibleGroups[gi];

			// Skip the group being dragged entirely — its visual lives in
			// the floating ghost.
			if (group.id === draggingGroupId) {
				continue;
			}

			// Emit the repo-drop placeholder before this group when this is
			// the chosen drop target. `repoDropBeforeId === null` means "after
			// the last repo bucket"; the natural anchor for that is right
			// before the Backlog header — emitting it later (after the loop)
			// would push the placeholder past Backlog and make Backlog appear
			// to shift up by the moving group's height.
			const isExplicitTarget =
				repoDropTargetGroupId !== null && group.id === repoDropTargetGroupId;
			const isEndOfReposAnchor =
				activeRepoDragId !== null &&
				repoDropBeforeId === null &&
				group.id === "backlog";
			if (
				activeRepoDragId &&
				!repoPlaceholderEmitted &&
				(isExplicitTarget || isEndOfReposAnchor)
			) {
				if (items.length > 0) {
					items.push({ kind: "group-gap", size: GROUP_GAP });
				}
				items.push({
					kind: "repo-drop-placeholder",
					beforeRepoId: repoDropBeforeId,
					height: movingGroupHeight,
				});
				repoPlaceholderEmitted = true;
			}

			if (items.length > 0) {
				// Walk previous non-placeholder/gap item to decide gap size.
				const lastReal = [...items]
					.reverse()
					.find((it) => it.kind !== "group-gap");
				const previousHasRows =
					lastReal?.kind === "row" ||
					(lastReal?.kind === "group-header" && lastReal.group.rows.length > 0);
				items.push({
					kind: "group-gap",
					size: getGroupGapSize(previousHasRows, group.rows.length > 0),
				});
			}

			const canCollapse = group.rows.length > 0;
			items.push({
				kind: "group-header",
				groupId: group.id,
				group,
				canCollapse,
			});

			const isGroupOpen = sectionOpenState[group.id] !== false;
			if (isGroupOpen && group.rows.length > 0) {
				for (const row of group.rows) {
					if (
						dropTargetGroupId === group.id &&
						dropTargetBeforeWorkspaceId === row.id
					) {
						items.push({
							kind: "drop-placeholder",
							groupId: group.id,
							beforeWorkspaceId: row.id,
						});
					}
					if (activeDragWorkspaceId === row.id) {
						continue;
					}
					items.push({
						kind: "row",
						groupId: group.id,
						row,
						isArchived: false,
					});
				}
			}
			if (
				dropTargetGroupId === group.id &&
				dropTargetBeforeWorkspaceId === null
			) {
				items.push({
					kind: "drop-placeholder",
					groupId: group.id,
					beforeWorkspaceId: null,
				});
			}
		}

		// Repo drag dropping to the very end (after the last repo bucket).
		if (
			activeRepoDragId &&
			repoDropBeforeId === null &&
			!repoPlaceholderEmitted
		) {
			items.push({ kind: "group-gap", size: GROUP_GAP });
			items.push({
				kind: "repo-drop-placeholder",
				beforeRepoId: null,
				height: movingGroupHeight,
			});
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
	}, [
		groups,
		archivedRows,
		sectionOpenState,
		activeDragWorkspaceId,
		dropTargetGroupId,
		dropTargetBeforeWorkspaceId,
		pinnedSlotReady,
		activeRepoDragId,
		repoDropBeforeId,
		sidebarGrouping,
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
				case "row":
					return ROW_HEIGHT;
				case "drop-placeholder":
					return ROW_HEIGHT;
				case "repo-drop-placeholder":
					return item.height;
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
					return `row-${item.groupId}-${item.row.id}`;
				case "drop-placeholder":
					return `drop-${item.groupId}-${item.beforeWorkspaceId ?? "__end__"}`;
				case "repo-drop-placeholder":
					// Dynamic key like `drop-placeholder` — each new target
					// is a fresh mount; the placeholder is invisible so
					// the lack of transition doesn't matter.
					return `repo-drop-${item.beforeRepoId ?? "__end__"}`;
				case "group-gap":
					return `gap-${index}`;
				case "bottom-padding":
					return "bottom-padding";
			}
		},
		// Boost overscan while dragging so items that the reorder shifts into
		// view are already mounted — a freshly-mounted item has no previous
		// transform to interpolate from and would otherwise "jump" into its
		// new slot instead of sliding. Asymmetric because reorder only pulls
		// new items into view in one direction (the side the placeholder is
		// moving toward).
		overscan: isAnyDragging ? 200 : 12,
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

	useShellEvent("open-sidebar-filter", () => {
		setIsSidebarViewPopoverOpen(true);
	});

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
			if (
				item.kind === "group-gap" ||
				item.kind === "bottom-padding" ||
				item.kind === "repo-drop-placeholder"
			) {
				return null;
			}

			if (item.kind === "drop-placeholder") {
				// Empty ROW_HEIGHT slot — makes neighbours give way and lets
				// hit-test still resolve the group via the data attr.
				return (
					<div className="h-full" data-workspace-drop-group-id={item.groupId} />
				);
			}

			if (item.kind === "group-header") {
				const isOpen =
					item.groupId === ARCHIVED_SECTION_ID
						? (sectionOpenState[item.groupId] ?? false)
						: (sectionOpenState[item.groupId] ?? true);
				const isArchived = item.groupId === ARCHIVED_SECTION_ID;
				const isEmptyGroup = item.group.rows.length === 0;
				const repoId = repoIdFromGroupId(item.groupId);
				const isRepoGroup = repoId !== null;
				const repoSampleRow: WorkspaceRow | undefined = isRepoGroup
					? item.group.rows[0]
					: undefined;

				const headerLabel = (
					<span className="flex items-center gap-2">
						{isArchived ? (
							<Archive
								className="size-[14px] shrink-0 text-[var(--workspace-sidebar-status-backlog)]"
								strokeWidth={1.9}
							/>
						) : isRepoGroup ? (
							<WorkspaceAvatar
								repoIconSrc={repoSampleRow?.repoIconSrc}
								repoInitials={repoSampleRow?.repoInitials ?? null}
								repoName={item.group.label}
								title={item.group.label}
							/>
						) : (
							<GroupIcon tone={item.group.tone} />
						)}
						<span>{item.group.label}</span>
					</span>
				);

				const headerClassName = cn(
					"group/trigger flex w-full select-none items-center justify-between rounded-lg px-2 text-[13px] font-semibold tracking-[-0.01em] text-foreground hover:bg-accent/60 py-1",
				);

				// Repo header: no chevron/badge, but the header still toggles
				// the section; hover reveals `+` for new workspace.
				// `role="button"` because the `+` is a nested button.
				if (isRepoGroup && repoId) {
					const repoToggleSection = () => {
						if (item.canCollapse) toggleSection(item.groupId);
					};
					const repoDndHandleEnabled =
						Boolean(onMoveRepositoryInSidebar) && dragReorderEnabled;
					return (
						<div
							role="button"
							tabIndex={item.canCollapse ? 0 : -1}
							aria-expanded={item.canCollapse ? isOpen : undefined}
							aria-disabled={item.canCollapse ? undefined : true}
							data-repo-dnd-handle={repoDndHandleEnabled ? "true" : undefined}
							data-repo-dnd-id={repoId}
							className={cn(
								headerClassName,
								item.canCollapse ? "cursor-interactive" : "cursor-default",
								"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50",
							)}
							data-empty-group={isEmptyGroup ? "true" : "false"}
							onPointerDown={(event) => {
								if (!repoDndHandleEnabled) return;
								startRepoDragGesture({
									event,
									repoId,
									label: item.group.label,
								});
							}}
							onClick={repoToggleSection}
							onKeyDown={(event) => {
								if (event.key === "Enter" || event.key === " ") {
									event.preventDefault();
									repoToggleSection();
								}
							}}
						>
							{headerLabel}
							{onCreateWorkspaceForRepo ? (
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											type="button"
											aria-label={`New workspace in ${item.group.label}`}
											variant="ghost"
											size="icon-xs"
											className="size-5 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/trigger:opacity-100 focus-visible:opacity-100"
											onClick={(event) => {
												event.stopPropagation();
												onCreateWorkspaceForRepo(repoId);
											}}
										>
											<Plus className="size-3.5" strokeWidth={2.2} />
										</Button>
									</TooltipTrigger>
									<TooltipContent
										side="top"
										sideOffset={4}
										className="flex h-[24px] items-center rounded-md px-2 text-[12px] leading-none"
									>
										New workspace in {item.group.label}
									</TooltipContent>
								</Tooltip>
							) : null}
						</div>
					);
				}

				return (
					<button
						type="button"
						className={cn(
							headerClassName,
							item.canCollapse ? "cursor-interactive" : "cursor-default",
						)}
						data-empty-group={isEmptyGroup ? "true" : "false"}
						data-workspace-drop-group-id={item.groupId}
						disabled={!item.canCollapse}
						onClick={() => toggleSection(item.groupId)}
					>
						{headerLabel}

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
				<div
					className="pl-2"
					data-workspace-drop-group-id={item.groupId}
					data-workspace-dnd-row="true"
					data-workspace-dnd-row-id={item.row.id}
					data-workspace-dnd-group-id={item.groupId}
				>
					<WorkspaceRowItem
						row={item.row}
						selected={selectedWorkspaceId === item.row.id}
						isSending={busyWorkspaceIds?.has(item.row.id)}
						isInteractionRequired={interactionRequiredWorkspaceIds?.has(
							item.row.id,
						)}
						// Hide per-row avatar inside a real repo bucket — header
						// already shows it. Pinned/backlog/archived keep theirs.
						hideRepoAvatar={repoIdFromGroupId(item.groupId) !== null}
						onSelect={onSelectWorkspace}
						onPrefetch={onPrefetchWorkspace}
						onArchiveWorkspace={onArchiveWorkspace}
						onMoveLocalToWorktree={onMoveLocalToWorktree}
						onMarkWorkspaceUnread={onMarkWorkspaceUnread}
						onOpenInFinder={onOpenInFinder}
						onTogglePin={onTogglePin}
						onSetWorkspaceStatus={onSetWorkspaceStatus}
						groupId={item.groupId}
						onDragPointerDown={
							dragReorderEnabled ? startDragGesture : undefined
						}
						disableHoverCard={isAnyDragging}
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
			sidebarGrouping,
			toggleSection,
			selectedWorkspaceId,
			busyWorkspaceIds,
			interactionRequiredWorkspaceIds,
			onCreateWorkspaceForRepo,
			onSelectWorkspace,
			onPrefetchWorkspace,
			onArchiveWorkspace,
			onMoveLocalToWorktree,
			onMarkWorkspaceUnread,
			onRestoreWorkspace,
			onDeleteWorkspace,
			onTogglePin,
			onMoveWorkspaceInSidebar,
			onMoveRepositoryInSidebar,
			onSetWorkspaceStatus,
			startDragGesture,
			startRepoDragGesture,
			isAnyDragging,
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

			<div className="mt-1 flex items-center justify-between px-3">
				<h2 className="text-[14px] font-medium tracking-[-0.01em] text-muted-foreground">
					Workspaces
				</h2>

				<div className="flex items-center gap-1 text-muted-foreground">
					<SidebarViewPopover
						repositories={availableRepositories}
						grouping={sidebarGrouping}
						selectedRepoIds={sidebarRepoFilterIds}
						sort={sidebarSort}
						open={isSidebarViewPopoverOpen}
						onOpenChange={setIsSidebarViewPopoverOpen}
						shortcut={sidebarFilterShortcut}
						onGroupingChange={onSidebarGroupingChange}
						onRepoFilterChange={onSidebarRepoFilterChange}
						onSortChange={onSidebarSortChange}
					/>

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
					style={{
						height: `${virtualizer.getTotalSize()}px`,
						width: "100%",
						position: "relative",
					}}
				>
					{virtualizer.getVirtualItems().map((vItem) => {
						const item = flatItems[vItem.index];
						return (
							<div
								key={vItem.key}
								style={{
									position: "absolute",
									top: 0,
									left: 0,
									width: "100%",
									height: `${vItem.size}px`,
									// `translate3d` forces a compositor layer in WebKit
									// (Tauri's webview) so transitions during the drag
									// stay smooth in both directions.
									transform: `translate3d(0, ${vItem.start}px, 0)`,
									// Transition is ONLY on during the drag. The
									// moment the user releases, `isAnyDragging` flips
									// false and any layout shift caused by the
									// optimistic commit (status/repo lane change,
									// reorder, etc.) snaps instantly into place — no
									// landing animation.
									transition:
										isAnyDragging && item.kind !== "drop-placeholder"
											? "transform 150ms cubic-bezier(0.16, 1, 0.3, 1)"
											: "none",
									willChange: isAnyDragging ? "transform" : "auto",
								}}
							>
								{renderItem(item)}
							</div>
						);
					})}
				</div>
			</div>
			{dragState && activeDragRow ? (
				<WorkspaceDragGhost
					dragState={dragState}
					row={activeDragRow}
					selected={selectedWorkspaceId === activeDragRow.id}
					isSending={busyWorkspaceIds?.has(activeDragRow.id)}
					isInteractionRequired={interactionRequiredWorkspaceIds?.has(
						activeDragRow.id,
					)}
					hideRepoAvatar={repoIdFromGroupId(dragState.sourceGroupId) !== null}
				/>
			) : null}
			{repoDragState && repoDragGroup ? (
				<RepoDragGhost
					dragState={repoDragState}
					// Only carry rows when the group is expanded in the sidebar.
					rows={
						sectionOpenState[repoDragGroup.id] !== false
							? repoDragGroup.rows
							: []
					}
					repoIconSrc={repoDragGroup.rows[0]?.repoIconSrc ?? null}
					repoInitials={repoDragGroup.rows[0]?.repoInitials ?? null}
					selectedWorkspaceId={selectedWorkspaceId}
					busyWorkspaceIds={busyWorkspaceIds}
					interactionRequiredWorkspaceIds={interactionRequiredWorkspaceIds}
				/>
			) : null}
		</div>
	);
});
