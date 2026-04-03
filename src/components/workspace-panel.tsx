import { Suspense, lazy, memo, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Virtuoso,
  type Components as VirtuosoComponents,
  type ItemProps as VirtuosoItemProps,
  type ScrollSeekPlaceholderProps,
  type VirtuosoHandle,
} from "react-virtuoso";
import {
  AlertCircle,
  ArrowDown,
  Bot,
  Check,
  Clock3,
  Copy,
  FileText,
  FilePlus,
  FolderKanban,
  FolderSearch,
  GitBranch,
  Globe,
  MessageSquareText,
  Pencil,
  Search,
  Sparkles,
  SquareTerminal,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  SessionAttachmentRecord,
  SessionMessageRecord,
  WorkspaceDetail,
  WorkspaceSessionSummary,
} from "@/lib/conductor";
import {
  convertConductorMessages,
  type ConductorMessagePart,
} from "@/lib/message-adapter";
import { extractImagePaths, ImagePreviewBadge } from "./image-preview";

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
};

type RenderedMessage = ReturnType<typeof convertConductorMessages>[number];

const STREAMDOWN_ANIMATION = {
  animation: "fadeIn",
  duration: 160,
  stagger: 6,
  sep: "char",
} as const;

const LazyStreamdown = lazy(async () => {
  const mod = await import("streamdown");
  return { default: mod.Streamdown };
});

let hasPreloadedStreamdown = false;

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
}: WorkspacePanelProps) {
  const selectedSession = sessions.find((s) => s.id === selectedSessionId) ?? null;

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
    <div className="flex min-h-0 flex-1 flex-col bg-app-elevated">
      {/* --- Header --- */}
      <header className="relative z-20">
        <div
          aria-label="Workspace header"
          className="flex h-[2.6rem] items-center gap-3 px-5"
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
            {workspace?.state === "archived" ? (
              <span className="px-1 py-0.5 font-medium text-app-muted">Archived</span>
            ) : null}
          </div>
        </div>

        {/* --- Session tabs --- */}
        <div className="mt-0.5 flex h-[1.85rem] items-stretch overflow-x-auto px-0 [scrollbar-width:none]">
          {loadingWorkspace ? (
            <div className="flex items-center gap-1.5 px-2 text-[12px] text-app-muted">
              <Clock3 className="size-3 animate-pulse" strokeWidth={1.8} />
              Loading
            </div>
          ) : sessions.length > 0 ? (
            sessions.map((session) => {
              const selected = session.id === selectedSessionId;
              const isActive = selected && sending;
              return (
                <button
                  key={session.id}
                  type="button"
                  onClick={() => onSelectSession?.(session.id)}
                  className={cn(
                    "group relative flex w-[8rem] items-center gap-1.5 px-2.5 text-left text-[12px] transition-colors",
                    selected
                      ? "bg-app-foreground/[0.06] text-app-foreground"
                      : "text-app-foreground-soft hover:bg-app-foreground/[0.04] hover:text-app-foreground",
                  )}
                >
                  <SessionProviderIcon agentType={session.agentType} active={isActive} />
                  <span className="truncate font-medium">{displaySessionTitle(session)}</span>
                </button>
              );
            })
          ) : (
            <div className="flex items-center gap-1.5 px-2 text-[12px] text-app-muted">
              <AlertCircle className="size-3" strokeWidth={1.8} />
              No sessions
            </div>
          )}
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
          <ConductorThread
            key={selectedSessionId ?? "live-thread"}
            messages={messages}
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

function ConductorThread({ messages, sending }: { messages: SessionMessageRecord[]; sending: boolean }) {
  const threadMessages = useMemo(() => convertConductorMessages(messages), [messages]);
  const [sendStart, setSendStart] = useState<number | null>(null);
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [isPositioning, setIsPositioning] = useState(true);
  const [pendingAutoScroll, setPendingAutoScroll] = useState(false);
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
    if (sending) {
      setSendStart((current) => current ?? Date.now());
    } else {
      setSendStart(null);
    }
  }, [sending]);

  useEffect(() => {
    previousSendingRef.current = sending;
  }, [sending]);

  useEffect(() => {
    if (sendingJustStarted) {
      setPendingAutoScroll(true);
    } else if (!sending) {
      setPendingAutoScroll(false);
    }
  }, [sendingJustStarted, sending]);

  const scrollThreadToBottom = useCallback(() => {
    const virtuoso = virtuosoRef.current;
    if (!virtuoso) return;

    // Jump to the last item first, then settle to the actual scroll extent so footer space is included.
    virtuoso.scrollToIndex({
      index: "LAST",
      align: "end",
      behavior: "auto",
    });
    virtuoso.autoscrollToBottom();
  }, []);

  useEffect(() => {
    if (!sending || !isAtBottom) return;
    scrollThreadToBottom();
  }, [threadMessages, sending, isAtBottom, scrollThreadToBottom]);

  useLayoutEffect(() => {
    if (threadMessages.length === 0) return;
    if (!isPositioning && (!sending || !(sendingJustStarted || pendingAutoScroll))) return;
    scrollThreadToBottom();
  }, [
    threadMessages,
    sending,
    sendingJustStarted,
    pendingAutoScroll,
    isPositioning,
    scrollThreadToBottom,
  ]);

  useEffect(() => {
    if (isAtBottom && pendingAutoScroll) {
      setPendingAutoScroll(false);
    }
  }, [isAtBottom, pendingAutoScroll]);

  const handleAtBottomStateChange = useCallback((atBottom: boolean) => {
    setIsAtBottom(atBottom);
    if (atBottom) {
      setIsPositioning(false);
    }
  }, []);

  const virtuosoComponents = useMemo<VirtuosoComponents<RenderedMessage>>(() => ({
    Header: ConversationHeaderSpacer,
    Footer: () => (
      <ConversationFooterSpacer sending={sending} startTime={sendStart} />
    ),
    Item: ConversationItem,
    ScrollSeekPlaceholder: ConversationScrollSeekPlaceholder,
  }), [sending, sendStart]);

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
        sending && (atBottom || pendingAutoScroll || sendingJustStarted)
          ? "auto"
          : false
      )}
      isPositioning={isPositioning}
      itemContent={itemContent}
      onAtBottomStateChange={handleAtBottomStateChange}
      virtuosoRef={virtuosoRef}
    >
      {!isAtBottom && !pendingAutoScroll && !sendingJustStarted ? (
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
  virtuosoRef,
}: {
  children?: ReactNode;
  components: VirtuosoComponents<RenderedMessage>;
  data: RenderedMessage[];
  followOutput: "auto" | false | ((isAtBottom: boolean) => "auto" | false);
  isPositioning: boolean;
  itemContent: (index: number, message: RenderedMessage) => ReactNode;
  onAtBottomStateChange: (atBottom: boolean) => void;
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
        initialTopMostItemIndex={{ index: "LAST", align: "end" }}
        increaseViewportBy={{ bottom: 720, top: 360 }}
        itemContent={itemContent}
        overscan={{ main: 600, reverse: 300 }}
        scrollSeekConfiguration={{
          enter: (velocity) => Math.abs(velocity) > 2200,
          exit: (velocity) => Math.abs(velocity) < 180,
        }}
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
    <div {...props} style={style} className="flow-root px-7 pb-1.5">
      {children}
    </div>
  );
});

function ConversationScrollSeekPlaceholder({
  height,
  index,
}: ScrollSeekPlaceholderProps) {
  const isUserLike = index % 3 === 1;
  const widthClass = index % 5 === 0 ? "w-[44%]" : index % 2 === 0 ? "w-[62%]" : "w-[52%]";

  return (
    <div className="px-7 pb-1.5" style={{ height }}>
      <div className={cn("flex h-full min-h-10 items-center", isUserLike ? "justify-end" : "justify-start")}>
        <div
          className={cn(
            "h-8 rounded-md border border-app-border bg-app-sidebar/70 motion-safe:animate-pulse",
            isUserLike ? "w-[36%]" : widthClass,
          )}
        />
      </div>
    </div>
  );
}

function ConversationHeaderSpacer() {
  return <div className="h-6 shrink-0" />;
}

function ConversationFooterSpacer({
  sending,
  startTime,
}: {
  sending: boolean;
  startTime: number | null;
}) {
  return (
    <div className="px-7 pb-6 pt-1.5">
      {sending ? <SendingIndicator startTime={startTime} /> : null}
    </div>
  );
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
    return <ConductorUserMessage message={message} />;
  }

  if (message.role === "assistant") {
    return <ConductorAssistantMessage message={message} streaming={streaming} />;
  }

  return <ConductorSystemMessage message={message} />;
}

const MemoConversationMessage = memo(ConversationMessage, (prev, next) => {
  return (
    prev.message === next.message
    && prev.streaming === next.streaming
    && prev.itemIndex === next.itemIndex
  );
});

function ConductorUserMessage({ message }: { message: RenderedMessage }) {
  const parts = message.content as ConductorMessagePart[];

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

function ConductorAssistantMessage({
  message,
  streaming,
}: {
  message: RenderedMessage;
  streaming: boolean;
}) {
  const parts = message.content as ConductorMessagePart[];

  return (
    <div
      data-message-id={message.id}
      data-message-role="assistant"
      className="min-w-0 max-w-full space-y-1"
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

function ConductorSystemMessage({ message }: { message: RenderedMessage }) {
  const parts = message.content as ConductorMessagePart[];

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
      <div className="space-y-2">
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
  return (
    <div
      className={cn(
        "conversation-markdown prose prose-sm max-w-none break-words text-[14px] leading-7 text-app-foreground-soft prose-headings:my-0 prose-headings:text-app-foreground prose-p:my-0 prose-li:my-0 prose-pre:my-0 prose-ul:my-0 prose-ol:my-0 prose-blockquote:my-0 prose-table:my-0 prose-strong:text-app-foreground prose-code:rounded prose-code:bg-app-sidebar-strong prose-code:px-1.5 prose-code:py-0.5 prose-code:text-[13px] prose-code:text-app-foreground prose-pre:bg-app-sidebar prose-pre:text-[13px] prose-a:text-app-project prose-table:text-[13px]",
        streaming ? "conversation-markdown-streaming" : null,
      )}
    >
      <Suspense fallback={<AssistantTextFallback text={text} streaming={streaming} />}>
        <LazyStreamdown
          animated={streaming ? STREAMDOWN_ANIMATION : false}
          className="conversation-streamdown"
          isAnimating={streaming}
          mode={streaming ? "streaming" : "static"}
          parseIncompleteMarkdown
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
        streaming ? "conversation-streamdown-fallback-streaming" : null,
      )}
    >
      {text}
    </div>
  );
}

function AssistantReasoning({ text }: { text: string }) {
  return (
    <details className="group">
      <summary className="flex cursor-pointer items-center gap-1.5 py-0.5 text-[12px] text-app-muted hover:text-app-foreground-soft [&::-webkit-details-marker]:hidden">
        <svg className="size-2.5 shrink-0 transition-transform group-open:rotate-90" viewBox="0 0 12 12" fill="none">
          <path d="M4.5 2.5L8.5 6L4.5 9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Thinking
      </summary>
      <pre className="mt-1.5 max-h-[20rem] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-app-foreground/[0.03] px-3 py-2.5 font-sans text-[12px] leading-5 text-app-muted/70">
        {text}
      </pre>
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
          {info.diffAdd != null ? <span className="text-emerald-400">+{info.diffAdd}</span> : null}
          {info.diffDel != null ? <span className="text-red-400">-{info.diffDel}</span> : null}
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
      <details className="group/children">
        <summary className="flex max-w-full cursor-default items-center gap-1.5 py-0.5 text-[12px] text-app-muted [&::-webkit-details-marker]:hidden">
          {toolLine}
          <span className="shrink-0 cursor-pointer text-[11px] text-app-muted/40 hover:text-app-muted">
            <svg className="size-2 transition-transform group-open/children:rotate-90" viewBox="0 0 12 12" fill="none">
              <path d="M4.5 2.5L8.5 6L4.5 9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <span className="shrink-0 text-[11px] text-app-muted/40">{childrenData.parts.length} steps</span>
        </summary>
        <div className="ml-5 space-y-0.5 border-l border-app-border/30 pl-3 pt-1">
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
    <details className="group/out" open={false}>
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
        <div className="mt-1 max-h-[16rem] overflow-auto rounded-md bg-app-foreground/[0.02] text-[11px] leading-5">
          {info.fullCommand ? (
            <div className="border-b border-app-border/20 px-2 py-1.5">
              <span className="mr-1.5 text-cyan-400/50">$</span>
              <code className="font-mono text-app-foreground-soft">{info.fullCommand}</code>
            </div>
          ) : null}
          <pre className="whitespace-pre-wrap break-words p-2 text-app-muted/70">
            {resultText!.slice(0, 2000)}{resultText!.length > 2000 ? "…" : ""}
          </pre>
        </div>
      ) : null}
    </details>
  );
}

function SendingIndicator({ startTime }: { startTime: number | null }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!startTime) return;
    setElapsed(0);
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [startTime]);

  const timeLabel = elapsed >= 60
    ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`
    : `${elapsed}s`;

  return (
    <div className="flex items-center gap-2 py-1 text-[11px] text-app-muted">
      <span className="relative flex size-3.5 shrink-0 items-center justify-center">
        <span className="absolute inset-0 animate-spin rounded-full border border-transparent border-t-app-progress" />
        <span className="size-1.5 rounded-full bg-app-progress" />
      </span>
      <span>{timeLabel}</span>
    </div>
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
            {diffAdd != null ? <span className="text-emerald-400">+{diffAdd}</span> : null}
            {diffDel != null ? <span className="text-red-400">-{diffDel}</span> : null}
          </span>
        ) : null}
      </span>
      {pos
        ? createPortal(
            <div
              onMouseEnter={show}
              onMouseLeave={hideDelayed}
              className="fixed z-[100] w-[min(40rem,90vw)] rounded-lg border border-app-border bg-app-sidebar shadow-xl"
              style={{ left: pos.x, top: pos.y }}
            >
              <div className="border-b border-app-border/50 px-3 py-1.5 text-[11px] text-app-muted">
                {file}
              </div>
              <div className="max-h-[24rem] overflow-auto font-mono text-[11px] leading-5">
                {oldStr
                  ? oldStr.split("\n").map((line, i) => (
                      <div key={`d${i}`} className="flex whitespace-pre-wrap bg-red-400/[0.04]">
                        <span className="w-8 shrink-0 select-none border-r border-app-border/20 pr-1 text-right text-red-400/30">{i + 1}</span>
                        <span className="w-4 shrink-0 select-none text-center text-red-400/50">-</span>
                        <span className="min-w-0 text-red-400/70">{line}</span>
                      </div>
                    ))
                  : null}
                {oldStr && newStr ? <div className="border-t border-app-border/30" /> : null}
                {newStr
                  ? newStr.split("\n").map((line, i) => (
                      <div key={`a${i}`} className="flex whitespace-pre-wrap bg-emerald-400/[0.04]">
                        <span className="w-8 shrink-0 select-none border-r border-app-border/20 pr-1 text-right text-emerald-400/30">{i + 1}</span>
                        <span className="w-4 shrink-0 select-none text-center text-emerald-400/50">+</span>
                        <span className="min-w-0 text-emerald-400/70">{line}</span>
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

function isTextPart(part: unknown): part is Extract<ConductorMessagePart, { type: "text" }> {
  return isObj(part) && part.type === "text" && typeof part.text === "string";
}

function isReasoningPart(part: unknown): part is Extract<ConductorMessagePart, { type: "reasoning" }> {
  return isObj(part) && part.type === "reasoning" && typeof part.text === "string";
}

function isToolCallPart(part: unknown): part is Extract<ConductorMessagePart, { type: "tool-call" }> {
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
      <span className="inline-flex items-center gap-1 text-red-400/80">
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
      icon: <Pencil className="size-3.5 text-amber-400" strokeWidth={1.8} />,
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
      icon: <FileText className="size-3.5 text-sky-400" strokeWidth={1.8} />,
    };
  }

  if (name === "Write") {
    const fp = str(input.file_path);
    return {
      action: "Write",
      file: fp ? basename(fp) : undefined,
      icon: <FilePlus className="size-3.5 text-emerald-400" strokeWidth={1.8} />,
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
    return { action: "Grep", icon: <Search className="size-3.5 text-violet-400" strokeWidth={1.8} />, detail: p ?? undefined };
  }

  if (name === "Glob") {
    const p = str(input.pattern);
    return { action: "Glob", icon: <FolderSearch className="size-3.5 text-violet-400" strokeWidth={1.8} />, detail: p ?? undefined };
  }

  if (name === "WebFetch") {
    const url = str(input.url);
    return { action: "WebFetch", icon: <Globe className="size-3.5 text-teal-400" strokeWidth={1.8} />, detail: url ? truncate(url, 60) : undefined };
  }

  if (name === "WebSearch") {
    const q = str(input.query);
    return { action: "WebSearch", icon: <Globe className="size-3.5 text-teal-400" strokeWidth={1.8} />, detail: q ? truncate(q, 50) : undefined };
  }

  if (name === "ToolSearch") {
    const q = str(input.query);
    return { action: "ToolSearch", icon: <Search className="size-3.5 text-violet-400" strokeWidth={1.8} />, detail: q ? truncate(q, 50) : undefined };
  }

  if (name === "Agent" || name === "Task") {
    const d = str(input.description) ?? str(input.prompt);
    return { action: name, icon: <Bot className="size-3.5 text-indigo-400" strokeWidth={1.8} />, detail: d ? truncate(d, 50) : undefined };
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
    <div className="m-auto max-w-md rounded-[22px] border border-app-border bg-app-sidebar px-5 py-6 text-center">
      <div className="mx-auto flex size-12 items-center justify-center rounded-2xl border border-app-border-strong bg-app-sidebar text-app-foreground-soft">
        <MessageSquareText className="size-5" strokeWidth={1.8} />
      </div>
      <h3 className="mt-4 text-[15px] font-semibold text-app-foreground">
        {hasSession ? "This session is quiet for now" : "No session selected"}
      </h3>
      <p className="mt-2 text-[13px] leading-6 text-app-muted">
        {hasSession
          ? "The selected session does not have stored timeline events in this fixture yet."
          : "Pick a session tab to inspect its stored Conductor data."}
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
