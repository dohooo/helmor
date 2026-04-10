import {
	IssueClosedIcon,
	IssueDraftIcon,
	XCircleFillIcon,
} from "@primer/octicons-react";
import { cva } from "class-variance-authority";
import {
	Archive,
	ChevronRight,
	Circle,
	FolderPlus,
	GitBranch,
	LoaderCircle,
	Pin,
	PinOff,
	Plus,
	RotateCcw,
	Trash2,
} from "lucide-react";
import {
	memo,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import type {
	GroupTone,
	RepositoryCreateOption,
	WorkspaceGroup,
	WorkspaceRow,
} from "@/lib/api";
import { recordSidebarRowRender } from "@/lib/dev-render-debug";
import { cn } from "@/lib/utils";
import {
	getWorkspaceBranchTone,
	type WorkspaceBranchTone,
} from "@/lib/workspace-helpers";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "./ui/collapsible";
import { Command, CommandEmpty, CommandItem, CommandList } from "./ui/command";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger,
	ContextMenuTrigger,
} from "./ui/context-menu";
import { Popover, PopoverAnchor, PopoverContent } from "./ui/popover";
import { ScrollArea } from "./ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

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

const groupToneClasses: Record<GroupTone, string> = {
	pinned: "text-[var(--workspace-sidebar-status-neutral)]",
	done: "text-[var(--workspace-sidebar-status-done)]",
	review: "text-[var(--workspace-sidebar-status-review)]",
	progress: "text-[var(--workspace-sidebar-status-progress)]",
	backlog: "text-[var(--workspace-sidebar-status-backlog)]",
	canceled: "text-[var(--workspace-sidebar-status-canceled)]",
};
const branchToneClasses: Record<WorkspaceBranchTone, string> = {
	working: "text-[var(--workspace-branch-status-working)]",
	open: "text-[var(--workspace-branch-status-open)]",
	merged: "text-[var(--workspace-branch-status-merged)]",
	closed: "text-[var(--workspace-branch-status-closed)]",
	inactive: "text-[var(--workspace-branch-status-inactive)]",
};
const ARCHIVED_SECTION_ID = "__archived__";
const SECTION_OPEN_STATE_STORAGE_KEY =
	"helmor:workspaces-sidebar:section-open-state";

const STATUS_OPTIONS: ReadonlyArray<{
	value: string;
	label: string;
	tone: GroupTone;
}> = [
	{ value: "backlog", label: "Backlog", tone: "backlog" },
	{ value: "in-progress", label: "In progress", tone: "progress" },
	{ value: "review", label: "In review", tone: "review" },
	{ value: "done", label: "Done", tone: "done" },
	{ value: "canceled", label: "Canceled", tone: "canceled" },
];

function createInitialSectionOpenState(groups: WorkspaceGroup[]) {
	return Object.fromEntries([
		...groups.map((group) => [group.id, true]),
		[ARCHIVED_SECTION_ID, false],
	]) as Record<string, boolean>;
}

function readStoredSectionOpenState() {
	if (typeof window === "undefined") {
		return null;
	}

	try {
		const raw = window.localStorage.getItem(SECTION_OPEN_STATE_STORAGE_KEY);
		if (!raw) {
			return null;
		}

		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return null;
		}

		return parsed as Record<string, boolean>;
	} catch {
		return null;
	}
}

function writeStoredSectionOpenState(state: Record<string, boolean>) {
	if (typeof window === "undefined") {
		return;
	}

	try {
		window.localStorage.setItem(
			SECTION_OPEN_STATE_STORAGE_KEY,
			JSON.stringify(state),
		);
	} catch {}
}

function findSelectedSectionId(
	selectedWorkspaceId: string | null | undefined,
	groups: WorkspaceGroup[],
	archivedRows: WorkspaceRow[],
) {
	if (!selectedWorkspaceId) {
		return null;
	}

	for (const group of groups) {
		if (group.rows.some((row) => row.id === selectedWorkspaceId)) {
			return group.id;
		}
	}

	if (archivedRows.some((row) => row.id === selectedWorkspaceId)) {
		return ARCHIVED_SECTION_ID;
	}

	return null;
}

function PartialCircleIcon({
	tone,
	inset,
	variant,
}: {
	tone: Extract<GroupTone, "review" | "progress">;
	inset: number;
	variant: "half-right" | "three-quarters";
}) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"relative block size-[14px] shrink-0 rounded-full border border-current",
				groupToneClasses[tone],
			)}
		>
			{variant === "half-right" ? (
				<span
					className="absolute rounded-r-full bg-current"
					style={{
						top: `${inset}px`,
						right: `${inset}px`,
						bottom: `${inset}px`,
						width: "4px",
					}}
				/>
			) : (
				<span
					className="absolute rounded-full bg-current"
					style={{
						inset: `${inset}px`,
						clipPath:
							"polygon(50% 0%, 100% 0%, 100% 100%, 0% 100%, 0% 50%, 50% 50%)",
					}}
				/>
			)}
		</span>
	);
}

function GroupIcon({ tone }: { tone: GroupTone }) {
	const className = cn("shrink-0", groupToneClasses[tone]);
	const iconSize = 14;

	switch (tone) {
		case "pinned":
			return (
				<Pin
					className={cn(className, "-rotate-45")}
					size={iconSize}
					strokeWidth={2}
				/>
			);
		case "done":
			return <IssueClosedIcon className={className} size={iconSize} />;
		case "review":
			return (
				<PartialCircleIcon
					tone="review"
					inset={2.25}
					variant="three-quarters"
				/>
			);
		case "progress":
			return (
				<PartialCircleIcon tone="progress" inset={2.5} variant="half-right" />
			);
		case "backlog":
			return <IssueDraftIcon className={className} size={iconSize} />;
		case "canceled":
			return <XCircleFillIcon className={className} size={iconSize} />;
	}
}

function initialsFromLabel(label?: string | null) {
	if (!label) {
		return "WS";
	}

	const parts = label
		.split(/[^A-Za-z0-9]+/)
		.map((part) => part.trim())
		.filter(Boolean);

	if (parts.length >= 2) {
		return parts
			.slice(0, 2)
			.map((part) => part[0]?.toUpperCase() ?? "")
			.join("");
	}

	const alphanumeric = Array.from(label).filter((character) =>
		/[A-Za-z0-9]/.test(character),
	);

	return alphanumeric.slice(0, 2).join("").toUpperCase() || "WS";
}

function getWorkspaceAvatarSrc(repoIconSrc?: string | null) {
	return repoIconSrc?.trim() ? repoIconSrc : null;
}

const WorkspaceAvatar = memo(function WorkspaceAvatar({
	repoIconSrc,
	repoInitials,
	repoName,
	title,
	className,
	fallbackClassName,
}: {
	repoIconSrc?: string | null;
	repoInitials?: string | null;
	repoName?: string | null;
	title: string;
	className?: string;
	fallbackClassName?: string;
}) {
	const fallback = (
		repoInitials?.trim() || initialsFromLabel(repoName || title)
	)
		.slice(0, 2)
		.toUpperCase();
	const src = getWorkspaceAvatarSrc(repoIconSrc);
	const [hasImage, setHasImage] = useState(Boolean(src));

	useEffect(() => {
		setHasImage(Boolean(src));
	}, [src]);

	return (
		<Avatar
			aria-hidden="true"
			data-slot="workspace-avatar"
			data-fallback={fallback}
			className={cn(
				"size-[16px] shrink-0 rounded-[5px] border-0 bg-transparent outline-none",
				className,
			)}
		>
			{src ? (
				<AvatarImage
					src={src}
					alt={`${repoName ?? title} icon`}
					onError={() => {
						setHasImage(false);
					}}
					onLoad={() => {
						setHasImage(true);
					}}
				/>
			) : null}
			{!hasImage ? (
				<AvatarFallback
					delayMs={0}
					className={cn(
						"bg-muted text-[7px] font-semibold uppercase tracking-[0.02em] text-muted-foreground",
						fallbackClassName,
					)}
				>
					{fallback}
				</AvatarFallback>
			) : null}
		</Avatar>
	);
});

type WorkspaceRowItemProps = {
	row: WorkspaceRow;
	selected: boolean;
	isSending?: boolean;
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

const WorkspaceRowItem = memo(
	function WorkspaceRowItem({
		row,
		selected,
		isSending,
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
					{isSending ? (
						<span className="relative flex size-[13px] shrink-0 items-center justify-center">
							<span className="absolute inset-0 animate-spin rounded-full border border-transparent border-t-[var(--workspace-sidebar-status-progress)]" />
							<span className="size-1 rounded-full bg-[var(--workspace-sidebar-status-progress)]" />
						</span>
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
						{row.branch ?? row.title}
					</span>
				</div>

				{hasActionHandler ? (
					<span
						className={cn(
							"flex shrink-0 items-center gap-0.5",
							isBusy ? "visible" : "invisible group-hover:visible",
						)}
					>
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
			previous.archivingWorkspaceId === next.archivingWorkspaceId &&
			previous.markingUnreadWorkspaceId === next.markingUnreadWorkspaceId &&
			previous.restoringWorkspaceId === next.restoringWorkspaceId &&
			previous.workspaceActionsDisabled === next.workspaceActionsDisabled
		);
	},
);

export const WorkspacesSidebar = memo(function WorkspacesSidebar({
	groups,
	archivedRows,
	availableRepositories,
	addingRepository,
	selectedWorkspaceId,
	sendingWorkspaceIds,
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
	const workspaceRowRefs = useRef(new Map<string, HTMLDivElement>());
	// Cache one ref-callback per workspace id so React does not detach +
	// re-attach the row DOM ref on every parent render. The previous version
	// returned `(workspaceId) => (el) => {...}` which produced a brand-new
	// closure for each row each render.
	const rowRefCallbackCache = useRef(
		new Map<string, (element: HTMLDivElement | null) => void>(),
	);
	const [sectionOpenState, setSectionOpenState] = useState(() => ({
		...createInitialSectionOpenState(groups),
		...readStoredSectionOpenState(),
	}));

	const setWorkspaceRowRef = useCallback((workspaceId: string) => {
		const cache = rowRefCallbackCache.current;
		const existing = cache.get(workspaceId);
		if (existing) return existing;
		const callback = (element: HTMLDivElement | null) => {
			if (element) {
				workspaceRowRefs.current.set(workspaceId, element);
				return;
			}
			workspaceRowRefs.current.delete(workspaceId);
		};
		cache.set(workspaceId, callback);
		return callback;
	}, []);

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

	useLayoutEffect(() => {
		if (!selectedWorkspaceId) {
			return;
		}

		const selectedRowElement =
			workspaceRowRefs.current.get(selectedWorkspaceId);
		if (
			!selectedRowElement ||
			typeof selectedRowElement.scrollIntoView !== "function"
		) {
			return;
		}

		const frameId = window.requestAnimationFrame(() => {
			selectedRowElement.scrollIntoView({
				block: "nearest",
				inline: "nearest",
			});
		});

		return () => {
			window.cancelAnimationFrame(frameId);
		};
	}, [sectionOpenState, selectedWorkspaceId]);

	const workspaceActionsBusy = Boolean(
		addingRepository ||
			archivingWorkspaceId ||
			markingUnreadWorkspaceId ||
			restoringWorkspaceId,
	);
	const createBusy = Boolean(creatingWorkspaceRepoId);
	const addRepositoryBusy = Boolean(addingRepository);
	const repositories = availableRepositories ?? [];

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

			<ScrollArea
				data-slot="workspace-groups-scroll"
				className="relative mt-4 min-h-0 flex-1 overflow-hidden [&_[data-slot=scroll-area-viewport]]:h-full [&_[data-slot=scroll-area-viewport]]:min-w-0 [&_[data-slot=scroll-area-viewport]]:w-full [&_[data-slot=scroll-area-viewport]]:px-2 [&_[data-slot=scroll-area-viewport]]:pr-3"
			>
				<div className="flex min-h-full flex-col gap-4 pb-3">
					{groups
						.filter((group) => group.id !== "pinned" || group.rows.length > 0)
						.map((group) => {
							const canCollapse = group.rows.length > 0;

							return (
								<Collapsible
									key={group.id}
									open={sectionOpenState[group.id] ?? true}
									onOpenChange={(open) => {
										setSectionOpenState((current) => ({
											...current,
											[group.id]: open,
										}));
									}}
								>
									<section
										aria-label={group.label}
										className="flex flex-col gap-1.5"
									>
										<CollapsibleTrigger
											className={cn(
												"group/trigger flex w-full select-none items-center justify-between rounded-lg px-2 py-1.5 text-[13px] font-semibold tracking-[-0.01em] text-foreground hover:bg-accent/60",
												canCollapse ? "cursor-pointer" : "cursor-default",
											)}
											disabled={!canCollapse}
										>
											<span className="flex items-center gap-2">
												<GroupIcon tone={group.tone} />
												<span>{group.label}</span>
											</span>

											{group.rows.length > 0 ? (
												<span className="relative flex h-5 min-w-5 items-center justify-center">
													<Badge
														variant="secondary"
														className="h-4 min-w-[16px] justify-center rounded-full px-1 text-[9.5px] leading-none transition-opacity group-hover/trigger:opacity-0"
													>
														{group.rows.length}
													</Badge>
													<ChevronRight
														className="absolute left-1/2 top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 text-muted-foreground opacity-0 transition-all group-hover/trigger:opacity-100 group-data-[panel-open]/trigger:rotate-90"
														strokeWidth={2}
													/>
												</span>
											) : null}
										</CollapsibleTrigger>

										{group.rows.length > 0 ? (
											<CollapsibleContent>
												<div className="flex flex-col gap-0.5">
													{group.rows.map((row) => (
														<WorkspaceRowItem
															key={row.id}
															row={row}
															selected={selectedWorkspaceId === row.id}
															isSending={sendingWorkspaceIds?.has(row.id)}
															rowRef={setWorkspaceRowRef(row.id)}
															onSelect={onSelectWorkspace}
															onPrefetch={onPrefetchWorkspace}
															onArchiveWorkspace={onArchiveWorkspace}
															onMarkWorkspaceUnread={onMarkWorkspaceUnread}
															onTogglePin={onTogglePin}
															onSetManualStatus={onSetManualStatus}
															archivingWorkspaceId={archivingWorkspaceId}
															markingUnreadWorkspaceId={
																markingUnreadWorkspaceId
															}
															restoringWorkspaceId={restoringWorkspaceId}
															workspaceActionsDisabled={Boolean(
																creatingWorkspaceRepoId ||
																	archivingWorkspaceId ||
																	markingUnreadWorkspaceId ||
																	restoringWorkspaceId,
															)}
														/>
													))}
												</div>
											</CollapsibleContent>
										) : null}
									</section>
								</Collapsible>
							);
						})}

					<Collapsible
						open={sectionOpenState[ARCHIVED_SECTION_ID] ?? false}
						onOpenChange={(open) => {
							setSectionOpenState((current) => ({
								...current,
								[ARCHIVED_SECTION_ID]: open,
							}));
						}}
					>
						<section aria-label="Archived" className="flex flex-col gap-1.5">
							<CollapsibleTrigger
								className={cn(
									"group/trigger flex w-full select-none items-center justify-between rounded-lg px-2 py-1.5 text-[13px] font-semibold tracking-[-0.01em] text-foreground hover:bg-accent/60",
									archivedRows.length > 0 ? "cursor-pointer" : "cursor-default",
								)}
								disabled={archivedRows.length === 0}
							>
								<span className="flex items-center gap-2">
									<Archive
										className="size-[14px] shrink-0 text-[var(--workspace-sidebar-status-backlog)]"
										strokeWidth={1.9}
									/>
									<span>Archived</span>
								</span>

								{archivedRows.length > 0 ? (
									<span className="relative flex h-5 min-w-5 items-center justify-center">
										<Badge
											variant="secondary"
											className="h-4 min-w-[16px] justify-center rounded-full px-1 text-[9.5px] leading-none transition-opacity group-hover/trigger:opacity-0"
										>
											{archivedRows.length}
										</Badge>
										<ChevronRight
											className="absolute left-1/2 top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 text-muted-foreground opacity-0 transition-all group-hover/trigger:opacity-100 group-data-[panel-open]/trigger:rotate-90"
											strokeWidth={2}
										/>
									</span>
								) : null}
							</CollapsibleTrigger>

							{archivedRows.length > 0 ? (
								<CollapsibleContent>
									<div className="flex flex-col gap-0.5">
										{archivedRows.map((row) => (
											<WorkspaceRowItem
												key={row.id}
												row={row}
												selected={selectedWorkspaceId === row.id}
												rowRef={setWorkspaceRowRef(row.id)}
												onSelect={onSelectWorkspace}
												onPrefetch={onPrefetchWorkspace}
												onArchiveWorkspace={onArchiveWorkspace}
												onMarkWorkspaceUnread={onMarkWorkspaceUnread}
												onRestoreWorkspace={onRestoreWorkspace}
												onDeleteWorkspace={onDeleteWorkspace}
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
											/>
										))}
									</div>
								</CollapsibleContent>
							) : null}
						</section>
					</Collapsible>
				</div>
			</ScrollArea>
		</div>
	);
});
