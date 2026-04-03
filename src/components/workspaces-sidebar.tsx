import { cva } from "class-variance-authority";
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import {
  IssueClosedIcon,
  IssueDraftIcon,
  XCircleFillIcon,
} from "@primer/octicons-react";
import {
  type ButtonHTMLAttributes,
  type ReactNode,
  useEffect,
  useState,
} from "react";
import {
  Archive,
  ChevronDown,
  BookMarked,
  GitBranch,
  LoaderCircle,
  RotateCcw,
  Plus,
} from "lucide-react";
import {
  type GroupTone,
  type WorkspaceGroup,
  type WorkspaceRow,
} from "@/lib/conductor";
import { cn } from "@/lib/utils";
import { TooltipProvider } from "./ui/tooltip";
import { BaseTooltip } from "./ui/base-tooltip";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";

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

function ToolbarButton({ label, className, children, ...props }: ToolbarButtonProps) {
  return (
    <button
      {...props}
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
  onRestoreWorkspace,
  archivingWorkspaceId,
  restoringWorkspaceId,
  workspaceActionsDisabled,
}: {
  row: WorkspaceRow;
  selected: boolean;
  onSelect?: (workspaceId: string) => void;
  onArchiveWorkspace?: (workspaceId: string) => void;
  onRestoreWorkspace?: (workspaceId: string) => void;
  archivingWorkspaceId?: string | null;
  restoringWorkspaceId?: string | null;
  workspaceActionsDisabled?: boolean;
}) {
  const actionLabel =
    row.state === "archived" ? "Restore workspace" : "Archive workspace";
  const isArchiving = archivingWorkspaceId === row.id;
  const isRestoring = restoringWorkspaceId === row.id;
  const isRestoreAction = row.state === "archived";
  const isBusy = isArchiving || isRestoring;
  const hasActionHandler = isRestoreAction
    ? Boolean(onRestoreWorkspace)
    : Boolean(onArchiveWorkspace);
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

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={row.title}
      data-active={row.active ? "true" : "false"}
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
            row.active ? "font-semibold text-app-foreground" : "font-medium text-app-foreground-soft/70",
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
              "flex size-6 shrink-0 items-center justify-center rounded-md text-app-muted",
              isBusy ? "visible" : "invisible group-hover:visible",
              workspaceActionsDisabled
                ? "cursor-not-allowed opacity-60"
                : "cursor-pointer hover:bg-app-toolbar-hover hover:text-app-foreground",
            )}
          >
            {actionIcon}
          </button>
        </BaseTooltip>
      ) : null}
    </div>
  );
}

export function WorkspacesSidebar({
  groups,
  archivedRows,
  selectedWorkspaceId,
  onSelectWorkspace,
  onArchiveWorkspace,
  onRestoreWorkspace,
  archivingWorkspaceId,
  restoringWorkspaceId,
  workspaceActionError,
}: {
  groups: WorkspaceGroup[];
  archivedRows: WorkspaceRow[];
  selectedWorkspaceId?: string | null;
  onSelectWorkspace?: (workspaceId: string) => void;
  onArchiveWorkspace?: (workspaceId: string) => void;
  onRestoreWorkspace?: (workspaceId: string) => void;
  archivingWorkspaceId?: string | null;
  restoringWorkspaceId?: string | null;
  workspaceActionError?: string | null;
}) {
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

          <div className="flex items-center gap-1 text-app-foreground-soft/80">
            <BaseTooltip side="top" content={<span>Add repository</span>}>
              <ToolbarButton label="Add repository" className="text-app-foreground-soft/78">
                <BookMarked className="size-3.5" strokeWidth={2} />
              </ToolbarButton>
            </BaseTooltip>

            <BaseTooltip side="top" content={<span>Add workspace</span>}>
              <ToolbarButton label="New workspace">
                <Plus className="size-3.5" strokeWidth={2.4} />
              </ToolbarButton>
            </BaseTooltip>
          </div>
        </div>

        <ScrollAreaPrimitive.Root
          data-slot="workspace-groups-scroll"
          type="scroll"
          scrollHideDelay={700}
          className="relative mt-4 min-h-0 flex-1 overflow-hidden"
        >
          <ScrollAreaPrimitive.Viewport className="h-full min-w-0 w-full rounded-[inherit] px-2 pr-4">
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
                            archivingWorkspaceId={archivingWorkspaceId}
                            restoringWorkspaceId={restoringWorkspaceId}
                            workspaceActionsDisabled={Boolean(
                              archivingWorkspaceId || restoringWorkspaceId,
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
                      onRestoreWorkspace={onRestoreWorkspace}
                      archivingWorkspaceId={archivingWorkspaceId}
                      restoringWorkspaceId={restoringWorkspaceId}
                      workspaceActionsDisabled={Boolean(
                        archivingWorkspaceId || restoringWorkspaceId,
                      )}
                    />
                  ))}
                </div>
              </CollapsibleContent>
            ) : null}

              {workspaceActionError ? (
                <p className="px-1 pt-1 text-[12px] leading-snug text-app-canceled">
                  {workspaceActionError}
                </p>
              ) : null}
                </section>
              </Collapsible>
            </div>
          </ScrollAreaPrimitive.Viewport>
          <ScrollAreaPrimitive.Scrollbar
            orientation="vertical"
            className="flex w-2.5 touch-none select-none p-[2px] transition-opacity data-[state=hidden]:opacity-0 data-[state=visible]:opacity-100"
          >
            <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-app-scrollbar-thumb hover:bg-app-scrollbar-thumb-hover" />
          </ScrollAreaPrimitive.Scrollbar>
        </ScrollAreaPrimitive.Root>
      </div>
    </TooltipProvider>
  );
}
