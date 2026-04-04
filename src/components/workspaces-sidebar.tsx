import { cva } from "class-variance-authority";
import {
  IssueClosedIcon,
  IssueDraftIcon,
  XCircleFillIcon,
} from "@primer/octicons-react";
import {
  type ButtonHTMLAttributes,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  Archive,
  ChevronDown,
  BookMarked,
  GitBranch,
  LoaderCircle,
  RotateCcw,
  Plus,
  Search,
} from "lucide-react";
import {
  type GroupTone,
  type RepositoryCreateOption,
  type WorkspaceGroup,
  type WorkspaceRow,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { TooltipProvider } from "./ui/tooltip";
import { BaseTooltip } from "./ui/base-tooltip";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "./ui/context-menu";
import { ScrollArea } from "./ui/scroll-area";

const rowVariants = cva(
  "group relative flex h-9 select-none items-center gap-2 rounded-md px-3 text-[13px] cursor-pointer",
  {
    variants: {
      active: {
        true: "bg-app-row-selected text-app-foreground",
        false: "text-app-foreground-soft/70 hover:bg-app-row-hover",
      },
    },
    defaultVariants: {
      active: false,
    },
  },
);

const groupToneClasses: Record<GroupTone, string> = {
  done: "text-app-done",
  review: "text-app-review",
  progress: "text-app-progress",
  backlog: "text-app-backlog",
  canceled: "text-app-canceled",
};

type ToolbarButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  className?: string;
  children: ReactNode;
};

function ToolbarButton({ label, className, children, ref, ...props }: ToolbarButtonProps & { ref?: React.Ref<HTMLButtonElement> }) {
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
            clipPath: "polygon(50% 0%, 100% 0%, 100% 100%, 0% 100%, 0% 50%, 50% 50%)",
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
    case "done":
      return <IssueClosedIcon className={className} size={iconSize} />;
    case "review":
      return <PartialCircleIcon tone="review" inset={2.25} variant="three-quarters" />;
    case "progress":
      return <PartialCircleIcon tone="progress" inset={2.5} variant="half-right" />;
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

function WorkspaceAvatar({
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
  const fallback = (repoInitials?.trim() || initialsFromLabel(repoName || title))
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
}

function WorkspaceRowItem({
  row,
  selected,
  onSelect,
  onArchiveWorkspace,
  onMarkWorkspaceUnread,
  onRestoreWorkspace,
  archivingWorkspaceId,
  markingUnreadWorkspaceId,
  restoringWorkspaceId,
  workspaceActionsDisabled,
}: {
  row: WorkspaceRow;
  selected: boolean;
  onSelect?: (workspaceId: string) => void;
  onArchiveWorkspace?: (workspaceId: string) => void;
  onMarkWorkspaceUnread?: (workspaceId: string) => void;
  onRestoreWorkspace?: (workspaceId: string) => void;
  archivingWorkspaceId?: string | null;
  markingUnreadWorkspaceId?: string | null;
  restoringWorkspaceId?: string | null;
  workspaceActionsDisabled?: boolean;
}) {
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
  const canMarkAsUnread =
    Boolean(onMarkWorkspaceUnread) &&
    !row.hasUnread &&
    !workspaceActionsDisabled &&
    !isBusy;
  const actionIcon =
    isBusy ? (
      <LoaderCircle className="size-3.5 animate-spin" strokeWidth={2.1} />
    ) : isRestoreAction ? (
      <RotateCcw
        className="size-3.5"
        strokeWidth={2.1}
      />
    ) : (
      <Archive className="size-3.5" strokeWidth={1.9} />
    );

  const rowBody = (
    <div
      role="button"
      tabIndex={0}
      aria-label={row.title}
      data-has-unread={row.hasUnread ? "true" : "false"}
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
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <WorkspaceAvatar
          repoIconSrc={row.repoIconSrc}
          repoInitials={row.repoInitials ?? row.avatar ?? null}
          repoName={row.repoName}
          title={row.title}
        />
        <GitBranch className="size-[13px] shrink-0 text-app-warm" strokeWidth={1.9} />
        <span
          className={cn(
            "truncate leading-none",
            selected
              ? row.hasUnread
                ? "font-semibold text-app-foreground"
                : "font-medium text-app-foreground"
              : row.hasUnread
                ? "font-semibold text-app-foreground"
                : "font-medium text-app-foreground-soft/70",
          )}
        >
          {row.title}
        </span>
      </div>

      {hasActionHandler ? (
        <BaseTooltip
          side="top"
          content={<span>{actionLabel}</span>}
        >
          <button
            type="button"
            aria-label={actionLabel}
            disabled={Boolean(workspaceActionsDisabled)}
            onClick={(event) => {
              event.stopPropagation();

              if (workspaceActionsDisabled) {
                return;
              }

              if (isRestoreAction) {
                onRestoreWorkspace?.(row.id);
              } else {
                onArchiveWorkspace?.(row.id);
              }
            }}
            className={cn(
              "flex shrink-0 items-center justify-center text-app-muted",
              isBusy ? "visible" : "invisible group-hover:visible",
              workspaceActionsDisabled
                ? "cursor-not-allowed opacity-60"
                : "cursor-pointer hover:text-app-foreground",
            )}
          >
            {actionIcon}
          </button>
        </BaseTooltip>
      ) : null}
    </div>
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger className="block">
        {rowBody}
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-40">
        <ContextMenuItem
          disabled={!canMarkAsUnread}
          onClick={() => {
            if (canMarkAsUnread) {
              onMarkWorkspaceUnread?.(row.id);
            }
          }}
        >
          <span className="size-2 shrink-0 rounded-full bg-app-progress" />
          <span>Mark as unread</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function WorkspacesSidebar({
  groups,
  archivedRows,
  availableRepositories,
  addingRepository,
  selectedWorkspaceId,
  creatingWorkspaceRepoId,
  onAddRepository,
  onSelectWorkspace,
  onCreateWorkspace,
  onArchiveWorkspace,
  onMarkWorkspaceUnread,
  onRestoreWorkspace,
  archivingWorkspaceId,
  markingUnreadWorkspaceId,
  restoringWorkspaceId,
}: {
  groups: WorkspaceGroup[];
  archivedRows: WorkspaceRow[];
  availableRepositories?: RepositoryCreateOption[];
  addingRepository?: boolean;
  selectedWorkspaceId?: string | null;
  creatingWorkspaceRepoId?: string | null;
  onAddRepository?: () => void;
  onSelectWorkspace?: (workspaceId: string) => void;
  onCreateWorkspace?: (repoId: string) => void;
  onArchiveWorkspace?: (workspaceId: string) => void;
  onMarkWorkspaceUnread?: (workspaceId: string) => void;
  onRestoreWorkspace?: (workspaceId: string) => void;
  archivingWorkspaceId?: string | null;
  markingUnreadWorkspaceId?: string | null;
  restoringWorkspaceId?: string | null;
}) {
  const [isRepoPickerOpen, setIsRepoPickerOpen] = useState(false);
  const [repoSearchQuery, setRepoSearchQuery] = useState("");
  const repoPickerRef = useRef<HTMLDivElement | null>(null);
  const repoPickerAnchorRef = useRef<HTMLButtonElement | null>(null);
  const repoSearchInputRef = useRef<HTMLInputElement | null>(null);
  const [pickerPos, setPickerPos] = useState<{ top: number; left: number } | null>(null);

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
    addingRepository || archivingWorkspaceId || markingUnreadWorkspaceId || restoringWorkspaceId,
  );
  const createBusy = Boolean(creatingWorkspaceRepoId);
  const addRepositoryBusy = Boolean(addingRepository);
  const filteredRepositories = useMemo(() => {
    const normalizedQuery = repoSearchQuery.trim().toLowerCase();

    if (!normalizedQuery) {
      return availableRepositories ?? [];
    }

    return (availableRepositories ?? []).filter((repository) => {
      const haystack = `${repository.name} ${repository.defaultBranch ?? ""}`.toLowerCase();
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
        !(repoPickerRef.current?.contains(target)) &&
        !(repoPickerAnchorRef.current?.contains(target))
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
    <TooltipProvider>
      <div className="flex h-full min-h-0 flex-col overflow-hidden pb-4">
        <div
          data-slot="window-safe-top"
          className="flex h-11 shrink-0 items-center pr-3"
        >
          <div data-tauri-drag-region className="h-full w-[94px] shrink-0" />
          <div data-tauri-drag-region className="h-full flex-1" />
        </div>

        <div className="flex items-center justify-between px-3">
          <h2 className="text-[13px] font-medium tracking-[-0.01em] text-app-foreground-soft">
            Workspaces
          </h2>

          <div
            className="relative flex items-center gap-1 text-app-foreground-soft/80"
          >
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
                  <LoaderCircle className="size-3.5 animate-spin" strokeWidth={2.1} />
                ) : (
                  <BookMarked className="size-3.5" strokeWidth={2} />
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
                  <LoaderCircle className="size-3.5 animate-spin" strokeWidth={2.1} />
                ) : (
                  <Plus className="size-3.5" strokeWidth={2.4} />
                )}
              </ToolbarButton>
            </BaseTooltip>

            {isRepoPickerOpen && pickerPos ? createPortal(
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
            ) : null}
          </div>
        </div>

        <ScrollArea
          data-slot="workspace-groups-scroll"
          className="relative mt-4 min-h-0 flex-1 overflow-hidden"
          viewportClassName="h-full min-w-0 w-full rounded-[inherit] px-2 pr-3"
        >
            <div className="flex min-h-full flex-col gap-4 pb-3">
              {groups.map((group) => {
                const canCollapse = group.rows.length > 0;

                return (
                  <Collapsible key={group.id} defaultOpen>
                    <section aria-label={group.label} className="space-y-1.5">
                      <CollapsibleTrigger
                        className={cn(
                          "group/trigger flex w-full select-none items-center justify-between rounded-xl px-1 py-1 text-[13px] font-semibold tracking-[-0.01em] text-app-foreground hover:bg-app-toolbar-hover/70",
                          canCollapse ? "cursor-pointer" : "cursor-default",
                        )}
                        disabled={!canCollapse}
                      >
                        <span className="flex items-center gap-2">
                          <GroupIcon tone={group.tone} />
                          <span>{group.label}</span>
                        </span>

                        {canCollapse ? (
                          <ChevronDown
                            className="size-4 shrink-0 text-app-foreground-soft transition-transform group-data-[panel-open]/trigger:-rotate-0 group-data-[panel-closed]/trigger:-rotate-90"
                            strokeWidth={2}
                          />
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
                            onSelect={onSelectWorkspace}
                            onArchiveWorkspace={onArchiveWorkspace}
                            onMarkWorkspaceUnread={onMarkWorkspaceUnread}
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
                );
              })}

              <Collapsible defaultOpen={false}>
                <section aria-label="Archived" className="space-y-1.5">
                  <CollapsibleTrigger className="group/trigger flex w-full cursor-pointer select-none items-center justify-between rounded-xl px-1 py-1 text-[13px] font-semibold tracking-[-0.01em] text-app-foreground hover:bg-app-toolbar-hover/70">
                    <span className="flex items-center gap-2">
                      <Archive
                        className="size-[14px] shrink-0 text-app-backlog"
                        strokeWidth={1.9}
                      />
                      <span>Archived</span>
                    </span>

                    <ChevronDown
                      className="size-4 shrink-0 text-app-foreground-soft transition-transform group-data-[panel-open]/trigger:-rotate-0 group-data-[panel-closed]/trigger:-rotate-90"
                      strokeWidth={2}
                    />
                  </CollapsibleTrigger>

                  {archivedRows.length > 0 ? (
                    <CollapsibleContent>
                      <div className="space-y-0.5">
                        {archivedRows.map((row) => (
                    <WorkspaceRowItem
                      key={row.id}
                      row={row}
                      selected={selectedWorkspaceId === row.id}
                      onSelect={onSelectWorkspace}
                      onArchiveWorkspace={onArchiveWorkspace}
                      onMarkWorkspaceUnread={onMarkWorkspaceUnread}
                      onRestoreWorkspace={onRestoreWorkspace}
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
    </TooltipProvider>
  );
}
