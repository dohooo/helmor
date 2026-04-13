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
	useRef,
	useState,
} from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
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
import { ScrollArea } from "@/components/ui/scroll-area";
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
												"group/trigger flex w-full cursor-pointer select-none items-center justify-between rounded-lg px-2 py-1.5 text-[13px] font-semibold tracking-[-0.01em] text-foreground hover:bg-accent/60",
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
															isCompleted={completedWorkspaceIds?.has(row.id)}
															isInteractionRequired={interactionRequiredWorkspaceIds?.has(
																row.id,
															)}
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
									"group/trigger flex w-full cursor-pointer select-none items-center justify-between rounded-lg px-2 py-1.5 text-[13px] font-semibold tracking-[-0.01em] text-foreground hover:bg-accent/60",
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
