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
	Search,
	Trash2,
} from "lucide-react";
import {
	type ButtonHTMLAttributes,
	memo,
	type ReactNode,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import type {
	GroupTone,
	RepositoryCreateOption,
	WorkspaceGroup,
	WorkspaceRow,
} from "@/lib/api";
import { recordSidebarRowRender } from "@/lib/dev-render-debug";
import { cn } from "@/lib/utils";
import { BaseTooltip } from "./ui/base-tooltip";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "./ui/collapsible";
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
import { ScrollArea } from "./ui/scroll-area";

const rowVariants = cva(
	"group relative flex h-7.5 select-none items-center gap-2 rounded-md px-2.5 text-[13px] cursor-pointer",
	{
		variants: {
			active: {
				true: "bg-app-row-selected text-app-foreground",
				false: "text-app-foreground/80 hover:bg-app-row-hover",
			},
		},
		defaultVariants: {
			active: false,
		},
	},
);

const groupToneClasses: Record<GroupTone, string> = {
	pinned: "text-app-foreground-soft",
	done: "text-app-done",
	review: "text-app-review",
	progress: "text-app-progress",
	backlog: "text-app-backlog",
	canceled: "text-app-canceled",
};
const ARCHIVED_SECTION_ID = "__archived__";

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
		...groups.map((group) => [group.id, group.rows.length > 0]),
		[ARCHIVED_SECTION_ID, false],
	]) as Record<string, boolean>;
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

type ToolbarButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
	label: string;
	className?: string;
	children: ReactNode;
};

function ToolbarButton({
	label,
	className,
	children,
	ref,
	...props
}: ToolbarButtonProps & { ref?: React.Ref<HTMLButtonElement> }) {
	return (
		<button
			{...props}
			ref={ref}
			type="button"
			aria-label={label}
			className={cn(
				"flex size-7 cursor-pointer items-center justify-center bg-transparent text-app-foreground-soft/72 transition-colors hover:bg-transparent hover:text-app-foreground focus-visible:text-app-foreground",
				className,
			)}
		>
			{children}
		</button>
	);
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
}: {
	repoIconSrc?: string | null;
	repoInitials?: string | null;
	repoName?: string | null;
	title: string;
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
		<span
			aria-hidden="true"
			data-slot="workspace-avatar"
			className="relative flex size-[16px] shrink-0 items-center justify-center overflow-hidden rounded-[5px] border-0 bg-transparent outline-none"
		>
			{src ? (
				<img
					src={src}
					alt={`${repoName ?? title} icon`}
					className="size-full object-cover"
					onError={() => {
						setHasImage(false);
					}}
					onLoad={() => {
						setHasImage(true);
					}}
				/>
			) : null}
			{!hasImage ? (
				<span className="absolute inset-0 flex items-center justify-center bg-app-sidebar-strong text-[7px] font-semibold uppercase tracking-[0.02em] text-app-foreground-soft">
					{fallback}
				</span>
			) : null}
		</span>
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
					"w-full text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-app-border-strong",
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
							<span className="absolute inset-0 animate-spin rounded-full border border-transparent border-t-app-progress" />
							<span className="size-1 rounded-full bg-app-progress" />
						</span>
					) : (
						<GitBranch
							className="size-[13px] shrink-0 text-app-warm"
							strokeWidth={1.9}
						/>
					)}
					<span
						className={cn(
							"truncate leading-none",
							selected
								? row.hasUnread
									? "font-semibold text-app-foreground"
									: "font-medium text-app-foreground"
								: row.hasUnread
									? "font-semibold text-app-foreground"
									: "font-medium",
						)}
					>
						{row.branch ?? row.title}
					</span>
				</div>

				{hasActionHandler ? (
					<span
						className={cn(
							"flex shrink-0 items-center gap-1.5",
							isBusy ? "visible" : "invisible group-hover:visible",
						)}
					>
						<BaseTooltip side="top" content={<span>{actionLabel}</span>}>
							<button
								type="button"
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
								className={cn(
									"flex items-center justify-center text-app-muted",
									workspaceActionsDisabled
										? "cursor-not-allowed opacity-60"
										: "cursor-pointer hover:text-app-foreground",
								)}
							>
								{actionIcon}
							</button>
						</BaseTooltip>
						{isRestoreAction && onDeleteWorkspace ? (
							<BaseTooltip side="top" content={<span>Delete permanently</span>}>
								<button
									type="button"
									aria-label="Delete permanently"
									disabled={Boolean(workspaceActionsDisabled)}
									onClick={(event) => {
										event.stopPropagation();
										if (workspaceActionsDisabled) return;
										onDeleteWorkspace(row.id);
									}}
									className={cn(
										"flex items-center justify-center text-app-muted",
										workspaceActionsDisabled
											? "cursor-not-allowed opacity-60"
											: "cursor-pointer hover:text-red-400",
									)}
								>
									<Trash2 className="size-3.5" strokeWidth={2.1} />
								</button>
							</BaseTooltip>
						) : null}
					</span>
				) : null}
			</div>
		);

		const isPinned = Boolean(row.pinnedAt);
		const effectiveStatus =
			row.manualStatus ?? row.derivedStatus ?? "in-progress";

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
										<span className="ml-auto text-app-foreground">✓</span>
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
	const [repoSearchQuery, setRepoSearchQuery] = useState("");
	const repoPickerRef = useRef<HTMLDivElement | null>(null);
	const repoPickerAnchorRef = useRef<HTMLButtonElement | null>(null);
	const repoSearchInputRef = useRef<HTMLInputElement | null>(null);
	const [pickerPos, setPickerPos] = useState<{
		top: number;
		left: number;
	} | null>(null);
	const viewportRef = useRef<HTMLDivElement | null>(null);
	const workspaceRowRefs = useRef(new Map<string, HTMLDivElement>());
	// Cache one ref-callback per workspace id so React does not detach +
	// re-attach the row DOM ref on every parent render. The previous version
	// returned `(workspaceId) => (el) => {...}` which produced a brand-new
	// closure for each row each render.
	const rowRefCallbackCache = useRef(
		new Map<string, (element: HTMLDivElement | null) => void>(),
	);
	const [sectionOpenState, setSectionOpenState] = useState(() =>
		createInitialSectionOpenState(groups),
	);

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
				const nextValue = current[group.id] ?? group.rows.length > 0;
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

	const updatePickerPosition = useCallback(() => {
		const anchor = repoPickerAnchorRef.current;
		if (!anchor) return;
		const rect = anchor.getBoundingClientRect();
		const popoverWidth = 296; // 18.5rem
		let left = rect.right - popoverWidth;
		if (left < 4) left = 4;
		setPickerPos({ top: rect.bottom + 8, left });
	}, []);

	useLayoutEffect(() => {
		if (!isRepoPickerOpen) return;
		updatePickerPosition();
	}, [isRepoPickerOpen, updatePickerPosition]);
	const workspaceActionsBusy = Boolean(
		addingRepository ||
			archivingWorkspaceId ||
			markingUnreadWorkspaceId ||
			restoringWorkspaceId,
	);
	const createBusy = Boolean(creatingWorkspaceRepoId);
	const addRepositoryBusy = Boolean(addingRepository);
	const filteredRepositories = useMemo(() => {
		const normalizedQuery = repoSearchQuery.trim().toLowerCase();

		if (!normalizedQuery) {
			return availableRepositories ?? [];
		}

		return (availableRepositories ?? []).filter((repository) => {
			const haystack =
				`${repository.name} ${repository.defaultBranch ?? ""}`.toLowerCase();
			return haystack.includes(normalizedQuery);
		});
	}, [availableRepositories, repoSearchQuery]);

	useEffect(() => {
		if (!isRepoPickerOpen) {
			setRepoSearchQuery("");
			return;
		}

		repoSearchInputRef.current?.focus();
	}, [isRepoPickerOpen]);

	useEffect(() => {
		if (!isRepoPickerOpen) {
			return;
		}

		const handlePointerDown = (event: PointerEvent) => {
			const target = event.target;

			if (
				target instanceof Node &&
				!repoPickerRef.current?.contains(target) &&
				!repoPickerAnchorRef.current?.contains(target)
			) {
				setIsRepoPickerOpen(false);
			}
		};

		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				setIsRepoPickerOpen(false);
			}
		};

		window.addEventListener("pointerdown", handlePointerDown);
		window.addEventListener("keydown", handleKeyDown);

		return () => {
			window.removeEventListener("pointerdown", handlePointerDown);
			window.removeEventListener("keydown", handleKeyDown);
		};
	}, [isRepoPickerOpen]);

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
				<h2 className="text-[13px] font-medium tracking-[-0.01em] text-app-foreground-soft">
					Workspaces
				</h2>

				<div className="relative flex items-center gap-1 text-app-foreground-soft/80">
					<BaseTooltip side="top" content={<span>Add repository</span>}>
						<ToolbarButton
							label="Add repository"
							disabled={addRepositoryBusy || createBusy || workspaceActionsBusy}
							className={cn(
								"text-app-foreground-soft/78",
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
								<LoaderCircle
									className="size-3.5 animate-spin"
									strokeWidth={2.1}
								/>
							) : (
								<FolderPlus className="size-3.5" strokeWidth={2} />
							)}
						</ToolbarButton>
					</BaseTooltip>

					<BaseTooltip side="top" content={<span>Add workspace</span>}>
						<ToolbarButton
							ref={repoPickerAnchorRef}
							label="New workspace"
							disabled={addRepositoryBusy || createBusy || workspaceActionsBusy}
							aria-expanded={isRepoPickerOpen}
							aria-haspopup="dialog"
							className={cn(
								addRepositoryBusy || createBusy || workspaceActionsBusy
									? "cursor-not-allowed opacity-60"
									: undefined,
							)}
							onClick={() => {
								if (addRepositoryBusy || createBusy || workspaceActionsBusy) {
									return;
								}

								setIsRepoPickerOpen((current) => !current);
							}}
						>
							{createBusy ? (
								<LoaderCircle
									className="size-3.5 animate-spin"
									strokeWidth={2.1}
								/>
							) : (
								<Plus className="size-3.5" strokeWidth={2.4} />
							)}
						</ToolbarButton>
					</BaseTooltip>

					{isRepoPickerOpen && pickerPos
						? createPortal(
								<div
									ref={repoPickerRef}
									role="dialog"
									aria-label="Create workspace from repository"
									className="fixed z-[9999] w-[18.5rem] rounded-[14px] border border-app-border bg-app-sidebar px-2 py-2 shadow-[0_18px_48px_rgba(0,0,0,0.38)]"
									style={{ top: pickerPos.top, left: pickerPos.left }}
								>
									<div className="relative">
										<Search
											className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-app-foreground-soft/60"
											strokeWidth={1.9}
										/>
										<input
											ref={repoSearchInputRef}
											type="text"
											value={repoSearchQuery}
											aria-label="Search repositories"
											placeholder="Search repositories"
											onChange={(event) => {
												setRepoSearchQuery(event.target.value);
											}}
											onKeyDown={(event) => {
												event.stopPropagation();
											}}
											className="h-9 w-full rounded-full border border-app-border bg-app-toolbar px-9 text-[13px] font-medium text-app-foreground outline-none placeholder:text-app-foreground-soft/56 focus:border-app-border-strong"
										/>
									</div>

									<div className="mt-2 max-h-72 space-y-1 overflow-y-auto pr-1">
										{filteredRepositories.length > 0 ? (
											filteredRepositories.map((repository) => (
												<button
													key={repository.id}
													type="button"
													className="flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left transition-colors hover:bg-app-row-hover"
													onClick={() => {
														setIsRepoPickerOpen(false);
														onCreateWorkspace?.(repository.id);
													}}
												>
													<WorkspaceAvatar
														repoIconSrc={repository.repoIconSrc}
														repoInitials={repository.repoInitials}
														repoName={repository.name}
														title={repository.name}
													/>
													<span className="min-w-0 flex-1">
														<span className="block truncate text-[13px] font-medium text-app-foreground">
															{repository.name}
														</span>
														{repository.defaultBranch ? (
															<span className="block truncate text-[11px] uppercase tracking-[0.14em] text-app-foreground-soft/52">
																{repository.defaultBranch}
															</span>
														) : null}
													</span>
												</button>
											))
										) : (
											<p className="px-2 py-3 text-[12px] leading-snug text-app-foreground-soft/60">
												No repositories found.
											</p>
										)}
									</div>
								</div>,
								document.body,
							)
						: null}
				</div>
			</div>

			<ScrollArea
				data-slot="workspace-groups-scroll"
				className="relative mt-4 min-h-0 flex-1 overflow-hidden"
				viewportRef={viewportRef}
				viewportClassName="h-full min-w-0 w-full rounded-[inherit] px-2 pr-3"
			>
				<div className="flex min-h-full flex-col gap-4 pb-3">
					{groups
						.filter((group) => group.id !== "pinned" || group.rows.length > 0)
						.map((group) => {
							const canCollapse = group.rows.length > 0;

							return (
								<Collapsible
									key={group.id}
									open={sectionOpenState[group.id] ?? group.rows.length > 0}
									onOpenChange={(open) => {
										setSectionOpenState((current) => ({
											...current,
											[group.id]: open,
										}));
									}}
								>
									<section aria-label={group.label} className="space-y-1.5">
										<CollapsibleTrigger
											className={cn(
												"group/trigger flex w-full select-none items-center justify-between rounded-lg px-2 py-1.5 text-[13px] font-semibold tracking-[-0.01em] text-app-foreground hover:bg-app-toolbar-hover/70",
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
													<span className="rounded-full bg-app-row-selected px-1.5 py-px text-center text-[10.5px] font-medium leading-[16px] text-app-muted transition-opacity group-hover/trigger:opacity-0">
														{group.rows.length}
													</span>
													<ChevronRight
														className="absolute left-1/2 top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 text-app-muted opacity-0 transition-all group-hover/trigger:opacity-100 group-data-[panel-open]/trigger:rotate-90"
														strokeWidth={2}
													/>
												</span>
											) : null}
										</CollapsibleTrigger>

										{group.rows.length > 0 ? (
											<CollapsibleContent>
												<div className="space-y-0.5">
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
						<section aria-label="Archived" className="space-y-1.5">
							<CollapsibleTrigger
								className={cn(
									"group/trigger flex w-full select-none items-center justify-between rounded-lg px-2 py-1.5 text-[13px] font-semibold tracking-[-0.01em] text-app-foreground hover:bg-app-toolbar-hover/70",
									archivedRows.length > 0 ? "cursor-pointer" : "cursor-default",
								)}
								disabled={archivedRows.length === 0}
							>
								<span className="flex items-center gap-2">
									<Archive
										className="size-[14px] shrink-0 text-app-backlog"
										strokeWidth={1.9}
									/>
									<span>Archived</span>
								</span>

								{archivedRows.length > 0 ? (
									<span className="relative flex h-5 min-w-5 items-center justify-center">
										<span className="rounded-full bg-app-row-selected px-1.5 py-px text-center text-[10.5px] font-medium leading-[16px] text-app-muted transition-opacity group-hover/trigger:opacity-0">
											{archivedRows.length}
										</span>
										<ChevronRight
											className="absolute left-1/2 top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 text-app-muted opacity-0 transition-all group-hover/trigger:opacity-100 group-data-[panel-open]/trigger:rotate-90"
											strokeWidth={2}
										/>
									</span>
								) : null}
							</CollapsibleTrigger>

							{archivedRows.length > 0 ? (
								<CollapsibleContent>
									<div className="space-y-0.5">
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
