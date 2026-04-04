import { Suspense, lazy, memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Skeleton, { SkeletonTheme } from "react-loading-skeleton";
import {
  Virtuoso,
  type Components as VirtuosoComponents,
  type ItemProps as VirtuosoItemProps,
  type ScrollSeekPlaceholderProps,
  type StateSnapshot,
  type VirtuosoHandle,
} from "react-virtuoso";
import {
  AlertCircle,
  ArrowDown,
  ArrowRight,
  Bot,
  Check,
  ChevronDown,
  Clock3,
  Copy,
  FileText,
  FilePlus,
  FolderKanban,
  FolderSearch,
  GitBranch,
  Globe,
  LoaderCircle,
  MessageSquareText,
  Pencil,
  Search,
  Sparkles,
  SquareTerminal,
  X,
  History,
  RotateCcw,
  Trash2,
  Plus,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  createSession,
  hideSession,
  unhideSession,
  deleteSession,
  loadHiddenSessions,
  listRemoteBranches,
  updateIntendedTargetBranch,
  type SessionAttachmentRecord,
  type SessionMessageRecord,
  type WorkspaceDetail,
  type WorkspaceSessionSummary,
} from "@/lib/api";
import {
  convertMessages,
  type MessagePart,
} from "@/lib/message-adapter";
import { extractImagePaths, ImagePreviewBadge } from "./image-preview";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";

type WorkspacePanelProps = {
  workspace: WorkspaceDetail | null;
  sessions: WorkspaceSessionSummary[];
  selectedSessionId: string | null;
  messages: SessionMessageRecord[];
  attachments?: SessionAttachmentRecord[];
  loadingWorkspace?: boolean;
  loadingSession?: boolean;
  sending?: boolean;
  onSelectSession?: (sessionId: string) => void;
  onSessionsChanged?: () => void;
  onWorkspaceChanged?: () => void;
};

type RenderedMessage = ReturnType<typeof convertMessages>[number];
type StreamdownMode = "static" | "streaming";

const LazyStreamdown = lazy(async () => {
  const mod = await import("streamdown");
  return { default: mod.Streamdown };
});

let hasPreloadedStreamdown = false;
const sessionViewportStateBySession = new Map<string, StateSnapshot>();

function preloadStreamdown() {
  if (hasPreloadedStreamdown) return;
  hasPreloadedStreamdown = true;
  void import("streamdown");
}

export const WorkspacePanel = memo(function WorkspacePanel({
  workspace,
  sessions,
  selectedSessionId,
  messages,
  attachments: _attachments,
  loadingWorkspace = false,
  loadingSession = false,
  sending = false,
  onSelectSession,
  onSessionsChanged,
  onWorkspaceChanged,
}: WorkspacePanelProps) {
  const selectedSession = sessions.find((s) => s.id === selectedSessionId) ?? null;
  const [showHistory, setShowHistory] = useState(false);
  const [hiddenSessions, setHiddenSessions] = useState<WorkspaceSessionSummary[]>([]);
  const [remoteBranches, setRemoteBranches] = useState<string[]>([]);
  const [loadingBranches, setLoadingBranches] = useState(false);

  const handleCreateSession = useCallback(async () => {
    if (!workspace) return;
    try {
      const result = await createSession(workspace.id);
      onSessionsChanged?.();
      onSelectSession?.(result.sessionId);
    } catch (error) {
      console.error("Failed to create session:", error);
    }
  }, [workspace, onSessionsChanged, onSelectSession]);

  const handleHideSession = useCallback(async (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await hideSession(sessionId);
    // Bump dataVersion → useEffect reloads sessions (without the hidden one)
    // → setSelectedSessionId fallback picks next visible session automatically
    onSessionsChanged?.();
  }, [onSessionsChanged]);

  const handleToggleHistory = useCallback(async () => {
    if (!showHistory && workspace) {
      const hidden = await loadHiddenSessions(workspace.id);
      setHiddenSessions(hidden);
    }
    setShowHistory((v) => !v);
  }, [showHistory, workspace]);

  const handleUnhide = useCallback(async (sessionId: string) => {
    await unhideSession(sessionId);
    setHiddenSessions((prev) => {
      const next = prev.filter((s) => s.id !== sessionId);
      if (next.length === 0) setShowHistory(false);
      return next;
    });
    onSessionsChanged?.();
    onSelectSession?.(sessionId);
  }, [onSessionsChanged, onSelectSession]);

  const handleDelete = useCallback(async (sessionId: string) => {
    await deleteSession(sessionId);
    setHiddenSessions((prev) => {
      const next = prev.filter((s) => s.id !== sessionId);
      if (next.length === 0) setShowHistory(false);
      return next;
    });
    onSessionsChanged?.();
  }, [onSessionsChanged]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const idleCallbackId = "requestIdleCallback" in window
      ? window.requestIdleCallback(() => preloadStreamdown(), { timeout: 1200 })
      : null;
    const timeoutId = idleCallbackId === null
      ? window.setTimeout(() => preloadStreamdown(), 180)
      : null;

    return () => {
      if (idleCallbackId !== null && "cancelIdleCallback" in window) {
        window.cancelIdleCallback(idleCallbackId);
      }
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-transparent">
      {/* --- Header --- */}
      <header className="relative z-20">
        <div
          aria-label="Workspace header"
          className="flex h-[2.4rem] items-center gap-3 px-5"
          data-tauri-drag-region
        >
          <div className="flex min-w-0 items-center gap-2 text-[13px]">
            <span className="inline-flex items-center gap-1 px-1 py-0.5 font-medium text-app-foreground-soft">
              <FolderKanban className="size-3.5 text-app-project" strokeWidth={1.9} />
              <span className="truncate">{workspace?.repoName ?? "Workspace"}</span>
            </span>
            <span className="text-app-muted">/</span>
            <span className="inline-flex items-center gap-1 px-1 py-0.5 font-medium text-app-foreground">
              <GitBranch className="size-3.5 text-app-warm" strokeWidth={1.9} />
              <span className="truncate">{workspace?.branch ?? "No branch"}</span>
            </span>
            {workspace?.intendedTargetBranch ? (
              <>
                <ArrowRight className="size-3 shrink-0 text-app-muted" strokeWidth={1.8} />
                {workspace.state === "archived" ? (
                  <span className="px-1 py-0.5 text-[13px] font-medium text-app-foreground-soft">
                    {workspace.intendedTargetBranch}
                  </span>
                ) : (
                  <DropdownMenu
                    onOpenChange={(open) => {
                      if (open && workspace) {
                        setLoadingBranches(true);
                        void listRemoteBranches(workspace.id).then((branches) => {
                          setRemoteBranches(branches);
                          setLoadingBranches(false);
                        });
                      }
                    }}
                  >
                    <DropdownMenuTrigger className="inline-flex cursor-pointer items-center gap-0.5 rounded-md px-1 py-0.5 text-[13px] font-medium text-app-foreground-soft transition-colors hover:bg-app-toolbar-hover hover:text-app-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-app-border-strong">
                      <span className="truncate">{workspace.intendedTargetBranch}</span>
                      <ChevronDown className="size-3 shrink-0" strokeWidth={2} />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="max-h-64 min-w-40 overflow-y-auto">
                      {loadingBranches ? (
                        <div className="flex items-center justify-center px-3 py-2">
                          <LoaderCircle className="size-3.5 animate-spin text-app-muted" strokeWidth={2} />
                        </div>
                      ) : (
                        remoteBranches.map((branch) => (
                          <DropdownMenuItem
                            key={branch}
                            onClick={() => {
                              if (branch === workspace.intendedTargetBranch) return;
                              void updateIntendedTargetBranch(workspace.id, branch).then(() => {
                                onWorkspaceChanged?.();
                              });
                            }}
                          >
                            <span className={cn(
                              "flex-1 truncate",
                              branch === workspace.intendedTargetBranch && "font-semibold",
                            )}>
                              {branch}
                            </span>
                            {branch === workspace.intendedTargetBranch ? (
                              <Check className="size-3.5 shrink-0 text-app-foreground" strokeWidth={2} />
                            ) : null}
                          </DropdownMenuItem>
                        ))
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </>
            ) : null}
            {workspace?.state === "archived" ? (
              <span className="px-1 py-0.5 font-medium text-app-muted">Archived</span>
            ) : null}
          </div>
        </div>

        {/* --- Session tabs row --- */}
        <div className="flex items-center px-4 pb-1">
          <div className="min-w-0 flex-1 overflow-x-auto [scrollbar-width:none]">
            {loadingWorkspace ? (
              <div className="flex h-[1.85rem] items-center gap-1.5 px-2 text-[12px] text-app-muted">
                <Clock3 className="size-3 animate-pulse" strokeWidth={1.8} />
                Loading
              </div>
            ) : sessions.length > 0 ? (
              <Tabs
                value={selectedSessionId ?? sessions[0]?.id}
                onValueChange={(value) => {
                  onSelectSession?.(value);
                }}
                className="min-w-max gap-0"
              >
                <TabsList
                  aria-label="Sessions"
                  className="min-w-max justify-start rounded-xl"
                >
                  {sessions.map((session) => {
                    const selected = session.id === selectedSessionId;
                    const isActive = selected && sending;
                    const hasUnread = session.unreadCount > 0;

                    return (
                      <TabsTrigger
                        key={session.id}
                        value={session.id}
                        className="group/tab relative gap-1.5 rounded-[10px] px-3.5 pr-5 text-[13px] text-app-foreground-soft data-[state=active]:text-app-foreground"
                      >
                        <SessionProviderIcon agentType={session.agentType} active={isActive} />
                        <span
                          className={cn(
                            "truncate font-medium",
                            hasUnread && !selected ? "text-app-foreground" : undefined,
                          )}
                        >
                          {displaySessionTitle(session)}
                        </span>
                        {hasUnread ? (
                          <span
                            aria-label="Unread session"
                            className="size-1.5 shrink-0 rounded-full bg-app-progress"
                          />
                        ) : null}
                        <span
                          role="button"
                          aria-label="Close session"
                          onClick={(e) => handleHideSession(session.id, e)}
                          className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center justify-center rounded-sm p-0.5 opacity-0 transition-opacity hover:bg-app-toolbar-hover group-hover/tab:opacity-100 data-[state=active]:opacity-100"
                        >
                          <X className="size-2.5" strokeWidth={2} />
                        </span>
                      </TabsTrigger>
                    );
                  })}
                </TabsList>
              </Tabs>
            ) : (
              <div className="flex h-[1.85rem] items-center gap-1.5 px-2 text-[12px] text-app-muted">
                <AlertCircle className="size-3" strokeWidth={1.8} />
                No sessions
              </div>
            )}
          </div>

          {/* New session button */}
          <button
            type="button"
            aria-label="New session"
            onClick={handleCreateSession}
            className="ml-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg text-app-muted transition-colors hover:bg-app-toolbar-hover hover:text-app-foreground-soft"
          >
            <Plus className="size-3.5" strokeWidth={1.8} />
          </button>

          {/* History button — right end of tab bar */}
          <div className="relative ml-1 shrink-0">
            <button
              type="button"
              aria-label="Session history"
              onClick={handleToggleHistory}
              className={cn(
                "flex size-7 items-center justify-center rounded-lg text-app-muted transition-colors hover:bg-app-toolbar-hover hover:text-app-foreground-soft",
                showHistory && "bg-app-toolbar-hover text-app-foreground-soft",
              )}
            >
              <History className="size-3.5" strokeWidth={1.8} />
            </button>

            {/* Dropdown menu */}
            {showHistory ? (
              <div className="absolute right-0 top-full z-30 mt-1 w-56 rounded-lg border border-app-border bg-app-sidebar py-1 shadow-lg">
                {hiddenSessions.length > 0 ? (
                  hiddenSessions.map((session) => (
                    <div
                      key={session.id}
                      className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-[12px] text-app-foreground-soft hover:bg-app-toolbar-hover"
                    >
                      <div className="flex min-w-0 items-center gap-1.5">
                        <SessionProviderIcon agentType={session.agentType} active={false} />
                        <span className="truncate">{displaySessionTitle(session)}</span>
                      </div>
                      <div className="flex shrink-0 items-center gap-0.5">
                        <button
                          type="button"
                          aria-label="Restore session"
                          onClick={() => handleUnhide(session.id)}
                          className="rounded-sm p-1 text-app-muted transition-colors hover:text-app-foreground-soft"
                        >
                          <RotateCcw className="size-3" strokeWidth={1.8} />
                        </button>
                        <button
                          type="button"
                          aria-label="Delete session permanently"
                          onClick={() => handleDelete(session.id)}
                          className="rounded-sm p-1 text-app-muted transition-colors hover:text-red-400"
                        >
                          <Trash2 className="size-3" strokeWidth={1.8} />
                        </button>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="px-2.5 py-1.5 text-[11px] text-app-muted">No hidden sessions</div>
                )}
              </div>
            ) : null}
          </div>
        </div>
      </header>

      {/* --- Timeline --- */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {loadingSession ? (
          <div className="flex items-center gap-2 px-4 py-5 text-sm text-app-muted">
            <Clock3 className="size-4 animate-pulse" strokeWidth={1.8} />
            Loading session timeline
          </div>
        ) : messages.length > 0 ? (
          <ChatThread
            key={selectedSessionId ?? "live-thread"}
            messages={messages}
            sessionId={selectedSessionId ?? "live-thread"}
            sending={sending}
          />
        ) : (
          <EmptyState hasSession={!!selectedSession} />
        )}
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Stick-to-bottom powered thread
// ---------------------------------------------------------------------------

function ChatThread({
  messages,
  sessionId,
  sending,
}: {
  messages: SessionMessageRecord[];
  sessionId: string;
  sending: boolean;
}) {
  const threadMessages = useMemo(() => convertMessages(messages), [messages]);
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [isPositioning, setIsPositioning] = useState(true);
  const restoredViewportState = useMemo(
    () => sessionViewportStateBySession.get(sessionId),
    [sessionId],
  );
  const previousSendingRef = useRef(sending);
  const sendingJustStarted = sending && !previousSendingRef.current;
  const streamingMessageId = useMemo(() => {
    if (!sending) return null;

    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      const isStreamingAssistant =
        message.role === "assistant"
        && (
          message.id.startsWith("stream:")
          || message.id.endsWith(":stream-partial")
        );

      if (!isStreamingAssistant) continue;

      const parsed = message.contentIsJson
        ? (message.parsedContent as Record<string, unknown> | undefined)
        : undefined;
      const isChild = parsed != null && typeof parsed.parent_tool_use_id === "string";

      return isChild ? `child:${message.id}` : message.id;
    }

    return null;
  }, [messages, sending]);

  useEffect(() => {
    previousSendingRef.current = sending;
  }, [sending]);

  useEffect(() => {
    return () => {
      const virtuoso = virtuosoRef.current;
      if (!virtuoso) return;
      virtuoso.getState((snapshot) => {
        sessionViewportStateBySession.set(sessionId, snapshot);
      });
    };
  }, [sessionId]);

  const scrollThreadToBottom = useCallback(() => {
    const virtuoso = virtuosoRef.current;
    if (!virtuoso) return;

    virtuoso.scrollToIndex({
      index: "LAST",
      align: "end",
      behavior: "auto",
    });
  }, []);

  useEffect(() => {
    if (sendingJustStarted) {
      scrollThreadToBottom();
    }
  }, [sendingJustStarted, scrollThreadToBottom]);

  useEffect(() => {
    if (!restoredViewportState) return;
    scrollThreadToBottom();
  }, [restoredViewportState, scrollThreadToBottom]);

  const handleAtBottomStateChange = useCallback((atBottom: boolean) => {
    setIsAtBottom(atBottom);
    if (atBottom) {
      setIsPositioning(false);
    }
  }, []);

  const virtuosoComponents = useMemo<VirtuosoComponents<RenderedMessage>>(() => ({
    Header: ConversationHeaderSpacer,
    Item: ConversationItem,
    ScrollSeekPlaceholder: ConversationScrollSeekPlaceholder,
  }), []);

  const itemContent = useCallback((index: number, message: RenderedMessage) => (
    <MemoConversationMessage
      message={message}
      streaming={message.id === streamingMessageId}
      itemIndex={index}
    />
  ), [streamingMessageId]);

  return (
    <ConversationViewport
      components={virtuosoComponents}
      data={threadMessages}
      followOutput={(atBottom) => (
        sending && atBottom
          ? "auto"
          : false
      )}
      isPositioning={isPositioning}
      itemContent={itemContent}
      onAtBottomStateChange={handleAtBottomStateChange}
      restoredViewportState={restoredViewportState}
      virtuosoRef={virtuosoRef}
    >
      {!isAtBottom && !sendingJustStarted ? (
        <button
          type="button"
          onClick={() => {
            scrollThreadToBottom();
          }}
          className="conversation-scroll-button"
          aria-label="Scroll to latest message"
        >
          <ArrowDown className="size-3.5" strokeWidth={1.9} />
          Latest
        </button>
      ) : null}
    </ConversationViewport>
  );
}

// ---------------------------------------------------------------------------
// Message components
// ---------------------------------------------------------------------------

function ConversationViewport({
  children,
  components,
  data,
  followOutput,
  isPositioning,
  itemContent,
  onAtBottomStateChange,
  restoredViewportState,
  virtuosoRef,
}: {
  children?: ReactNode;
  components: VirtuosoComponents<RenderedMessage>;
  data: RenderedMessage[];
  followOutput: "auto" | false | ((isAtBottom: boolean) => "auto" | false);
  isPositioning: boolean;
  itemContent: (index: number, message: RenderedMessage) => ReactNode;
  onAtBottomStateChange: (atBottom: boolean) => void;
  restoredViewportState?: StateSnapshot;
  virtuosoRef: React.RefObject<VirtuosoHandle | null>;
}) {
  return (
    <div
      className={cn(
        "relative flex min-h-0 flex-1 overflow-hidden",
        isPositioning ? "opacity-0" : "opacity-100",
      )}
    >
      <Virtuoso
        ref={virtuosoRef}
        alignToBottom
        atBottomStateChange={onAtBottomStateChange}
        atBottomThreshold={48}
        className="conversation-scroll"
        components={components}
        computeItemKey={(index, message) => message.id ?? `${message.role}:${index}`}
        data={data}
        defaultItemHeight={92}
        followOutput={followOutput}
        initialTopMostItemIndex={restoredViewportState ? undefined : { index: "LAST", align: "end" }}
        increaseViewportBy={{ bottom: 720, top: 360 }}
        itemContent={itemContent}
        minOverscanItemCount={{ top: 8, bottom: 4 }}
        overscan={{ main: 600, reverse: 300 }}
        restoreStateFrom={restoredViewportState}
        scrollSeekConfiguration={{
          enter: (velocity) => Math.abs(velocity) > 2200,
          exit: (velocity) => Math.abs(velocity) < 180,
        }}
        skipAnimationFrameInResizeObserver
        style={{ height: "100%", width: "100%" }}
      />
      {children}
    </div>
  );
}

const ConversationItem = memo(function ConversationItem({
  children,
  style,
  item: _item,
  ...props
}: VirtuosoItemProps<RenderedMessage>) {
  return (
    <div {...props} style={style} className="flow-root px-5 pb-1.5">
      {children}
    </div>
  );
});

function ConversationScrollSeekPlaceholder({
  height,
  index,
}: ScrollSeekPlaceholderProps) {
  const isUserLike = index % 3 === 1;
  const width = isUserLike
    ? "36%"
    : index % 5 === 0
      ? "44%"
      : index % 2 === 0
        ? "62%"
        : "52%";

  return (
    <div className="box-border h-full px-5 pb-1.5" style={{ height }}>
      <div className={cn("flex h-full items-center", isUserLike ? "justify-end" : "justify-start")}>
        <div style={{ width }}>
          <SkeletonTheme
            baseColor="color-mix(in oklch, var(--color-app-foreground) 10%, var(--color-app-base))"
            highlightColor="color-mix(in oklch, var(--color-app-foreground) 18%, var(--color-app-base))"
            duration={1.15}
          >
            <Skeleton
              height="100%"
              borderRadius={10}
              containerClassName="block h-full leading-none"
            />
          </SkeletonTheme>
        </div>
      </div>
    </div>
  );
}

function ConversationHeaderSpacer() {
  return <div className="h-6 shrink-0" />;
}

function ConversationMessage({
  message,
  streaming,
  itemIndex: _itemIndex,
}: {
  message: RenderedMessage;
  streaming: boolean;
  itemIndex: number;
}) {
  if (message.role === "user") {
    return <ChatUserMessage message={message} />;
  }

  if (message.role === "assistant") {
    return <ChatAssistantMessage message={message} streaming={streaming} />;
  }

  return <ChatSystemMessage message={message} />;
}

const MemoConversationMessage = memo(ConversationMessage, (prev, next) => {
  return (
    prev.message === next.message
    && prev.streaming === next.streaming
    && prev.itemIndex === next.itemIndex
  );
});

function ChatUserMessage({ message }: { message: RenderedMessage }) {
  const parts = message.content as MessagePart[];

  return (
    <div
      data-message-id={message.id}
      data-message-role="user"
      className="flex min-w-0 justify-end"
    >
      <div className="max-w-[75%] overflow-hidden rounded-md bg-app-foreground/[0.03] px-3 py-2 text-[14px] leading-7 text-app-foreground">
        {parts.map((part, idx) => (
          isTextPart(part)
            ? <UserText key={idx} text={part.text} />
            : null
        ))}
      </div>
    </div>
  );
}

function ChatAssistantMessage({
  message,
  streaming,
}: {
  message: RenderedMessage;
  streaming: boolean;
}) {
  const parts = message.content as MessagePart[];

  return (
    <div
      data-message-id={message.id}
      data-message-role="assistant"
      className="flex min-w-0 max-w-full flex-col gap-1"
    >
      {parts.map((part, idx) => {
        if (isTextPart(part)) {
          return <AssistantText key={idx} text={part.text} streaming={streaming} />;
        }
        if (isReasoningPart(part)) {
          return <AssistantReasoning key={idx} text={part.text} />;
        }
        if (isToolCallPart(part)) {
          return (
            <AssistantToolCall
              key={part.toolCallId ?? `${part.toolName}:${idx}`}
              toolName={part.toolName}
              args={part.args}
              result={part.result}
            />
          );
        }
        return null;
      })}
    </div>
  );
}

function ChatSystemMessage({ message }: { message: RenderedMessage }) {
  const parts = message.content as MessagePart[];

  return (
    <div
      data-message-id={message.id}
      data-message-role="system"
      className="group/sys flex min-w-0 items-center gap-1.5"
    >
      <div className="py-1 text-[11px] text-app-muted">
        {parts.map((part, idx) => (
          isTextPart(part)
            ? <SystemText key={idx} text={part.text} />
            : null
        ))}
      </div>
      <CopyMessageButton />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Content part components
// ---------------------------------------------------------------------------

function UserText({ text }: { text: string }) {
  const images = extractImagePaths(text);
  if (images.length > 0) {
    // Remove image paths from text, show as badges
    let remaining = text;
    for (const p of images) {
      remaining = remaining.replace(p, "").trim();
    }
    return (
      <div className="flex flex-col gap-2">
        {remaining ? <p className="whitespace-pre-wrap break-words">{remaining}</p> : null}
        <div className="flex flex-wrap gap-1.5">
          {images.map((p) => (
            <ImagePreviewBadge key={p} path={p} />
          ))}
        </div>
      </div>
    );
  }
  return <p className="whitespace-pre-wrap break-words">{text}</p>;
}

function AssistantText({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}) {
  const mode: StreamdownMode = streaming ? "streaming" : "static";

  return (
    <div
      className="conversation-markdown prose prose-sm max-w-none break-words text-[12px] leading-6 text-app-foreground prose-headings:my-0 prose-headings:text-app-foreground prose-p:my-0 prose-p:text-app-foreground prose-li:my-0 prose-li:text-app-foreground prose-strong:text-app-foreground prose-em:text-app-foreground prose-pre:my-0 prose-pre:border prose-pre:border-app-border prose-pre:bg-app-sidebar prose-pre:text-[12px] prose-pre:text-app-foreground prose-ul:my-0 prose-ol:my-0 prose-blockquote:my-0 prose-blockquote:border-app-border prose-blockquote:text-app-muted prose-table:my-0 prose-table:text-[11px] prose-table:text-app-foreground prose-th:border-app-border prose-th:text-app-foreground prose-td:border-app-border prose-td:text-app-foreground prose-tr:border-app-border prose-a:text-app-project prose-a:underline prose-a:decoration-app-project/30 prose-code:rounded prose-code:border prose-code:border-app-border/50 prose-code:bg-app-sidebar prose-code:px-1 prose-code:py-px prose-code:text-[12px] prose-code:text-app-foreground-soft"
    >
      <Suspense fallback={<AssistantTextFallback text={text} streaming={streaming} />}>
        <LazyStreamdown
          animated={streaming}
          className="conversation-streamdown"
          isAnimating={streaming}
          mode={mode}
        >
          {text}
        </LazyStreamdown>
      </Suspense>
    </div>
  );
}

function AssistantTextFallback({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}) {
  return (
    <div
      className={cn(
        "conversation-streamdown whitespace-pre-wrap break-words",
        streaming ? "animate-in fade-in-0 duration-150" : null,
      )}
    >
      {text}
    </div>
  );
}

function AssistantReasoning({ text }: { text: string }) {
  return (
    <details className="group flex flex-col">
      <summary className="flex cursor-pointer items-center gap-1.5 py-0.5 text-[12px] text-app-muted hover:text-app-foreground-soft [&::-webkit-details-marker]:hidden">
        <svg className="size-2.5 shrink-0 transition-transform group-open:rotate-90" viewBox="0 0 12 12" fill="none">
          <path d="M4.5 2.5L8.5 6L4.5 9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Thinking
      </summary>
      <div className="pt-1.5">
        <pre className="max-h-[20rem] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-app-foreground/[0.03] px-3 py-2.5 font-sans text-[12px] leading-5 text-app-muted/70">
          {text}
        </pre>
      </div>
    </details>
  );
}

function AssistantToolCall({
  toolName,
  args,
  result,
}: {
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
}) {
  const info = getToolInfo(toolName, args);
  const isEdit = toolName === "Edit";
  const oldStr = isEdit && typeof args.old_string === "string" ? args.old_string : null;
  const newStr = isEdit && typeof args.new_string === "string" ? args.new_string : null;
  const hasDiff = oldStr != null || newStr != null;

  // Detect __children__ encoded in result (sub-agent steps)
  const resultStr = result != null ? (typeof result === "string" ? result : JSON.stringify(result, null, 2)) : null;
  const isChildrenResult = resultStr?.startsWith("__children__") ?? false;
  const childrenData = isChildrenResult
    ? (() => { try { return JSON.parse(resultStr!.slice("__children__".length)) as { parts: Array<Record<string, unknown>> }; } catch { return null; } })()
    : null;
  const resultText = isChildrenResult ? null : resultStr;
  const hasOutput = resultText != null && resultText.length > 5;

  const toolLine = (
    <>
      <span className="shrink-0">{info.icon}</span>
      <span className="font-medium">{info.action}</span>
      {info.file ? (
        hasDiff ? (
          <EditDiffTrigger file={info.file} diffAdd={info.diffAdd} diffDel={info.diffDel} oldStr={oldStr} newStr={newStr} />
        ) : (
          <span className="truncate text-app-foreground-soft">{info.file}</span>
        )
      ) : null}
      {!hasDiff && (info.diffAdd != null || info.diffDel != null) ? (
        <span className="flex items-center gap-1 text-[11px]">
          {info.diffAdd != null ? <span className="text-app-positive">+{info.diffAdd}</span> : null}
          {info.diffDel != null ? <span className="text-app-negative">-{info.diffDel}</span> : null}
        </span>
      ) : null}
      {info.command ? (
        <code className="truncate rounded bg-app-foreground/[0.06] px-1.5 py-0.5 font-mono text-[11px] text-app-foreground-soft">{info.command}</code>
      ) : info.detail ? (
        <span className="truncate text-app-muted/60">{info.detail}</span>
      ) : null}
    </>
  );

  // Sub-agent children: render step count inline, expanded children below
  if (childrenData) {
    return (
      <details className="group/children flex flex-col">
        <summary className="flex max-w-full cursor-default items-center gap-1.5 py-0.5 text-[12px] text-app-muted [&::-webkit-details-marker]:hidden">
          {toolLine}
          <span className="shrink-0 cursor-pointer text-[11px] text-app-muted/40 hover:text-app-muted">
            <svg className="size-2 transition-transform group-open/children:rotate-90" viewBox="0 0 12 12" fill="none">
              <path d="M4.5 2.5L8.5 6L4.5 9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <span className="shrink-0 text-[11px] text-app-muted/40">{childrenData.parts.length} steps</span>
        </summary>
        <div className="ml-5 flex flex-col gap-0.5 border-l border-app-border/30 pl-3 pt-1">
          {childrenData.parts.map((part, idx) => {
            if (part.type === "tool-call") {
              return (
                <AssistantToolCall
                  key={idx}
                  toolName={(part.toolName as string) ?? "unknown"}
                  args={(part.args as Record<string, unknown>) ?? {}}
                  result={part.result}
                />
              );
            }
            if (part.type === "text" && part.text) {
              return (
                <div key={idx} className="text-[13px] leading-6 text-app-foreground-soft">
                  {(part.text as string).slice(0, 300)}{(part.text as string).length > 300 ? "…" : ""}
                </div>
              );
            }
            if (part.type === "reasoning" && part.text) {
              return <AssistantReasoning key={idx} text={part.text as string} />;
            }
            return null;
          })}
        </div>
      </details>
    );
  }

  // Normal tool call with optional output
  return (
    <details className="group/out flex flex-col" open={false}>
      <summary className="flex max-w-full cursor-default items-center gap-1.5 py-0.5 text-[12px] text-app-muted [&::-webkit-details-marker]:hidden">
        {toolLine}
        {hasOutput ? (
          <span className="shrink-0 cursor-pointer text-app-muted/40 hover:text-app-muted">
            <svg className="size-2.5 transition-transform group-open/out:rotate-90" viewBox="0 0 12 12" fill="none">
              <path d="M4.5 2.5L8.5 6L4.5 9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        ) : null}
      </summary>
      {hasOutput ? (
        <div className="max-h-[16rem] overflow-auto rounded-md bg-app-foreground/[0.02] text-[11px] leading-5">
          {info.fullCommand ? (
            <div className="border-b border-app-border/20 px-2 py-1.5">
              <span className="mr-1.5 text-app-project/60">$</span>
              <code className="font-mono text-app-foreground-soft">{info.fullCommand}</code>
            </div>
          ) : null}
          <pre className="whitespace-pre-wrap break-words p-1.5 text-app-muted/70">
            {resultText!.slice(0, 2000)}{resultText!.length > 2000 ? "…" : ""}
          </pre>
        </div>
      ) : null}
    </details>
  );
}

function CopyMessageButton() {
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);

  const handleCopy = useCallback(() => {
    const root = ref.current?.closest("[data-message-role]") ?? ref.current?.parentElement;
    if (!root) return;
    const text = root.textContent ?? "";
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, []);

  return (
    <button
      ref={ref}
      type="button"
      onClick={handleCopy}
      className="flex size-5 shrink-0 items-center justify-center rounded text-app-muted/30 opacity-0 transition-all hover:text-app-muted group-hover/sys:opacity-100"
    >
      {copied ? (
        <Check className="size-3" strokeWidth={2} />
      ) : (
        <Copy className="size-3" strokeWidth={1.8} />
      )}
    </button>
  );
}

function EditDiffTrigger({
  file,
  diffAdd,
  diffDel,
  oldStr,
  newStr,
}: {
  file: string;
  diffAdd?: number;
  diffDel?: number;
  oldStr: string | null;
  newStr: string | null;
}) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  const show = useCallback(() => {
    if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
    if (triggerRef.current) {
      const r = triggerRef.current.getBoundingClientRect();
      setPos({ x: r.left, y: r.bottom + 4 });
    }
  }, []);
  const hideDelayed = useCallback(() => {
    hideTimer.current = setTimeout(() => setPos(null), 120);
  }, []);

  return (
    <>
      <span
        ref={triggerRef}
        onMouseEnter={show}
        onMouseLeave={hideDelayed}
        className="inline-flex cursor-default items-center gap-1.5 rounded border border-app-border/60 px-1.5 py-0.5 transition-colors hover:border-app-foreground-soft/40 hover:bg-app-foreground/[0.03]"
      >
        <span className="truncate text-app-foreground-soft">{file}</span>
        {diffAdd != null || diffDel != null ? (
          <span className="flex items-center gap-1 text-[11px]">
            {diffAdd != null ? <span className="text-app-positive">+{diffAdd}</span> : null}
            {diffDel != null ? <span className="text-app-negative">-{diffDel}</span> : null}
          </span>
        ) : null}
      </span>
      {pos
        ? createPortal(
            <div
              onMouseEnter={show}
              onMouseLeave={hideDelayed}
              className="fixed z-[100] w-[min(40rem,90vw)] rounded-lg border border-app-border bg-app-tooltip shadow-xl"
              style={{ left: pos.x, top: pos.y }}
            >
              <div className="border-b border-app-border/50 px-3 py-1.5 text-[11px] text-app-muted">
                {file}
              </div>
              <div className="max-h-[24rem] overflow-auto font-mono text-[11px] leading-5">
                {oldStr
                  ? oldStr.split("\n").map((line, i) => (
                      <div key={`d${i}`} className="flex whitespace-pre-wrap bg-app-negative/10">
                        <span className="w-8 shrink-0 select-none border-r border-app-border/20 pr-1 text-right text-app-negative/40">{i + 1}</span>
                        <span className="w-4 shrink-0 select-none text-center text-app-negative/60">-</span>
                        <span className="min-w-0 text-app-negative/80">{line}</span>
                      </div>
                    ))
                  : null}
                {oldStr && newStr ? <div className="border-t border-app-border/30" /> : null}
                {newStr
                  ? newStr.split("\n").map((line, i) => (
                      <div key={`a${i}`} className="flex whitespace-pre-wrap bg-app-positive/10">
                        <span className="w-8 shrink-0 select-none border-r border-app-border/20 pr-1 text-right text-app-positive/40">{i + 1}</span>
                        <span className="w-4 shrink-0 select-none text-center text-app-positive/60">+</span>
                        <span className="min-w-0 text-app-positive/80">{line}</span>
                      </div>
                    ))
                  : null}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function isTextPart(part: unknown): part is Extract<MessagePart, { type: "text" }> {
  return isObj(part) && part.type === "text" && typeof part.text === "string";
}

function isReasoningPart(part: unknown): part is Extract<MessagePart, { type: "reasoning" }> {
  return isObj(part) && part.type === "reasoning" && typeof part.text === "string";
}

function isToolCallPart(part: unknown): part is Extract<MessagePart, { type: "tool-call" }> {
  return (
    isObj(part)
    && part.type === "tool-call"
    && typeof part.toolName === "string"
    && isObj(part.args)
  );
}

function SystemText({ text }: { text: string }) {
  if (text.startsWith("Error:")) {
    return (
      <span className="inline-flex items-center gap-1 text-app-negative">
        <AlertCircle className="size-3 shrink-0" strokeWidth={1.8} />
        {text.slice(7)}
      </span>
    );
  }
  return <span>{text}</span>;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

type ToolInfo = {
  action: string;
  file?: string;
  detail?: string;
  command?: string;
  fullCommand?: string;
  icon: React.ReactNode;
  diffAdd?: number;
  diffDel?: number;
};

function getToolInfo(name: string, input: Record<string, unknown> | null): ToolInfo {
  const fallbackIcon = <span className="size-3.5 rounded-full bg-app-foreground/15" />;
  if (!input) return { action: name, icon: fallbackIcon };

  if (name === "Edit") {
    const fp = str(input.file_path);
    const oldStr = typeof input.old_string === "string" ? input.old_string : "";
    const newStr = typeof input.new_string === "string" ? input.new_string : "";
    const del = oldStr ? oldStr.split("\n").length : 0;
    const add = newStr ? newStr.split("\n").length : 0;
    return {
      action: "Edit",
      file: fp ? basename(fp) : undefined,
      icon: <Pencil className="size-3.5 text-app-warning" strokeWidth={1.8} />,
      diffAdd: add,
      diffDel: del,
    };
  }

  if (name === "Read") {
    const fp = str(input.file_path);
    const limit = typeof input.limit === "number" ? input.limit : null;
    return {
      action: limit ? `Read ${limit} lines` : "Read",
      file: fp ? basename(fp) : undefined,
      icon: <FileText className="size-3.5 text-app-info" strokeWidth={1.8} />,
    };
  }

  if (name === "Write") {
    const fp = str(input.file_path);
    return {
      action: "Write",
      file: fp ? basename(fp) : undefined,
      icon: <FilePlus className="size-3.5 text-app-positive" strokeWidth={1.8} />,
    };
  }

  if (name === "Bash") {
    const cmd = str(input.command);
    return {
      action: "Run",
      icon: <SquareTerminal className="size-3.5 text-app-foreground-soft" strokeWidth={1.8} />,
      command: cmd ? truncate(cmd, 80) : undefined,
      fullCommand: cmd ?? undefined,
    };
  }

  if (name === "Grep") {
    const p = str(input.pattern);
    return { action: "Grep", icon: <Search className="size-3.5 text-app-info" strokeWidth={1.8} />, detail: p ?? undefined };
  }

  if (name === "Glob") {
    const p = str(input.pattern);
    return { action: "Glob", icon: <FolderSearch className="size-3.5 text-app-info" strokeWidth={1.8} />, detail: p ?? undefined };
  }

  if (name === "WebFetch") {
    const url = str(input.url);
    return { action: "WebFetch", icon: <Globe className="size-3.5 text-app-project" strokeWidth={1.8} />, detail: url ? truncate(url, 60) : undefined };
  }

  if (name === "WebSearch") {
    const q = str(input.query);
    return { action: "WebSearch", icon: <Globe className="size-3.5 text-app-project" strokeWidth={1.8} />, detail: q ? truncate(q, 50) : undefined };
  }

  if (name === "ToolSearch") {
    const q = str(input.query);
    return { action: "ToolSearch", icon: <Search className="size-3.5 text-app-info" strokeWidth={1.8} />, detail: q ? truncate(q, 50) : undefined };
  }

  if (name === "Agent" || name === "Task") {
    const d = str(input.description) ?? str(input.prompt);
    return { action: name, icon: <Bot className="size-3.5 text-app-info" strokeWidth={1.8} />, detail: d ? truncate(d, 50) : undefined };
  }

  return { action: name, icon: fallbackIcon };
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function basename(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() ?? path;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function EmptyState({ hasSession }: { hasSession: boolean }) {
  return (
    <div className="m-auto flex max-w-sm flex-col items-center px-8 text-center">
      <MessageSquareText className="size-7 text-app-muted/80" strokeWidth={1.7} />
      <p className="mt-5 text-[15px] font-medium tracking-[-0.01em] text-app-foreground">
        {hasSession ? "Nothing here yet" : "No session selected"}
      </p>
      <p className="mt-2 max-w-[30rem] text-[13px] leading-6 text-app-muted">
        {hasSession
          ? "This session does not have stored timeline events in the current fixture."
          : "Choose a session from the header to inspect its timeline."}
      </p>
    </div>
  );
}

function SessionProviderIcon({
  agentType,
  active,
}: {
  agentType?: string | null;
  active: boolean;
}) {
  if (active) {
    return (
      <span className="relative flex size-3.5 shrink-0 items-center justify-center">
        <span className="absolute inset-0 animate-spin rounded-full border border-transparent border-t-app-progress" />
        <span className="size-1.5 rounded-full bg-app-progress" />
      </span>
    );
  }
  return (
    <Sparkles
      className={cn(
        "size-3 shrink-0",
        agentType === "codex" ? "text-app-project" : "text-app-foreground-soft",
      )}
      strokeWidth={1.8}
    />
  );
}

function displaySessionTitle(session: WorkspaceSessionSummary): string {
  if (session.title && session.title !== "Untitled") return session.title;
  return session.agentType === "codex" ? "Codex session" : "Claude session";
}
