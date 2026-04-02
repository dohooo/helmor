import { useMemo } from "react";
import {
  useExternalStoreRuntime,
  AssistantRuntimeProvider,
  ThreadPrimitive,
  MessagePrimitive,
} from "@assistant-ui/react";
import {
  AlertCircle,
  Clock3,
  FolderKanban,
  GitBranch,
  MessageSquareText,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  SessionAttachmentRecord,
  SessionMessageRecord,
  WorkspaceDetail,
  WorkspaceSessionSummary,
} from "@/lib/conductor";
import { convertConductorMessages } from "@/lib/message-adapter";

type WorkspacePanelProps = {
  workspace: WorkspaceDetail | null;
  sessions: WorkspaceSessionSummary[];
  selectedSessionId: string | null;
  messages: SessionMessageRecord[];
  attachments?: SessionAttachmentRecord[];
  loadingWorkspace?: boolean;
  loadingSession?: boolean;
  onSelectSession?: (sessionId: string) => void;
};

export function WorkspacePanel({
  workspace,
  sessions,
  selectedSessionId,
  messages,
  attachments: _attachments,
  loadingWorkspace = false,
  loadingSession = false,
  onSelectSession,
}: WorkspacePanelProps) {
  const selectedSession = sessions.find((s) => s.id === selectedSessionId) ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-app-elevated">
      {/* --- Header --- */}
      <header className="relative z-20 border-b border-app-border">
        <div
          aria-label="Workspace header"
          className="flex h-[2.4rem] items-center gap-3 px-4"
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
        <div className="flex h-[1.85rem] items-stretch overflow-x-auto px-2 [scrollbar-width:none]">
          {loadingWorkspace ? (
            <div className="flex items-center gap-1.5 px-2 text-[12px] text-app-muted">
              <Clock3 className="size-3 animate-pulse" strokeWidth={1.8} />
              Loading
            </div>
          ) : sessions.length > 0 ? (
            sessions.map((session) => {
              const selected = session.id === selectedSessionId;
              const isActive = session.active && session.status !== "error";
              return (
                <button
                  key={session.id}
                  type="button"
                  onClick={() => onSelectSession?.(session.id)}
                  className={cn(
                    "group relative flex w-[8rem] items-center gap-1.5 rounded-t-sm px-2.5 text-left text-[12px] transition-colors",
                    selected
                      ? "bg-app-base text-app-foreground"
                      : "text-app-foreground-soft hover:bg-app-toolbar-hover/50 hover:text-app-foreground",
                  )}
                >
                  <SessionProviderIcon agentType={session.agentType} active={isActive} />
                  <span className="truncate font-medium">{displaySessionTitle(session)}</span>
                  {selected ? (
                    <span className="absolute inset-x-1 bottom-0 h-[1.5px] rounded-full bg-app-project" />
                  ) : null}
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
          <ConductorThread messages={messages} />
        ) : (
          <EmptyState hasSession={!!selectedSession} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// assistant-ui powered thread
// ---------------------------------------------------------------------------

function ConductorThread({ messages }: { messages: SessionMessageRecord[] }) {
  const threadMessages = useMemo(() => convertConductorMessages(messages), [messages]);

  const runtime = useExternalStoreRuntime({
    messages: threadMessages,
    isRunning: false,
    convertMessage: (m) => m,
    onNew: async () => {
      // Read-only viewer — no sending
    },
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
        <ThreadPrimitive.Viewport className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-5">
          <ThreadPrimitive.Messages
            components={{
              UserMessage: ConductorUserMessage,
              AssistantMessage: ConductorAssistantMessage,
              SystemMessage: ConductorSystemMessage,
            }}
          />
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

// ---------------------------------------------------------------------------
// Message components
// ---------------------------------------------------------------------------

function ConductorUserMessage() {
  return (
    <MessagePrimitive.Root className="flex min-w-0 justify-end">
      <div className="max-w-[75%] overflow-hidden rounded-lg bg-app-foreground/[0.04] px-3.5 py-2.5 text-[14px] leading-7 text-app-foreground">
        <MessagePrimitive.Content
          components={{
            Text: UserText,
          }}
        />
      </div>
    </MessagePrimitive.Root>
  );
}

function ConductorAssistantMessage() {
  return (
    <MessagePrimitive.Root className="min-w-0 max-w-full space-y-3">
      <MessagePrimitive.Content
        components={{
          Text: AssistantText,
          Reasoning: AssistantReasoning,
          tools: {
            Fallback: AssistantToolCall,
          },
        }}
      />
    </MessagePrimitive.Root>
  );
}

function ConductorSystemMessage() {
  return (
    <MessagePrimitive.Root className="flex min-w-0 justify-center">
      <div className="rounded-lg px-3 py-1.5 text-[11px] text-app-muted">
        <MessagePrimitive.Content
          components={{
            Text: SystemText,
          }}
        />
      </div>
    </MessagePrimitive.Root>
  );
}

// ---------------------------------------------------------------------------
// Content part components
// ---------------------------------------------------------------------------

function UserText({ text }: { text: string }) {
  return <p className="whitespace-pre-wrap break-words">{text}</p>;
}

function AssistantText({ text }: { text: string }) {
  return (
    <div className="prose prose-sm prose-invert max-w-none break-words text-[14px] leading-7 text-app-foreground-soft prose-headings:text-app-foreground prose-strong:text-app-foreground prose-code:rounded prose-code:bg-app-sidebar-strong prose-code:px-1.5 prose-code:py-0.5 prose-code:text-[13px] prose-code:text-app-foreground prose-pre:bg-app-sidebar prose-pre:text-[13px] prose-a:text-app-project">
      <MarkdownContent text={text} />
    </div>
  );
}

function AssistantReasoning({ text }: { text: string }) {
  return (
    <details className="group rounded-lg border border-app-border bg-app-sidebar">
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-[12px] font-medium text-app-foreground-soft [&::-webkit-details-marker]:hidden">
        <svg className="size-3 shrink-0 text-app-accent transition-transform group-open:rotate-90" viewBox="0 0 12 12" fill="none">
          <path d="M4.5 2.5L8.5 6L4.5 9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Thinking
      </summary>
      <pre className="max-h-[20rem] overflow-auto whitespace-pre-wrap break-words border-t border-app-border px-3 py-2.5 font-sans text-[13px] leading-6 text-app-muted">
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
  argsText: string;
  args: Record<string, unknown>;
  result?: unknown;
  status: unknown;
  addResult: unknown;
}) {
  const label = describeToolCall(toolName, args);
  const resultText = result != null
    ? typeof result === "string" ? result : JSON.stringify(result, null, 2)
    : null;

  return (
    <div className="space-y-1">
      <div className="inline-flex max-w-full items-center gap-2 overflow-hidden rounded-lg border border-app-border bg-app-sidebar px-3 py-1.5 text-[12px] text-app-foreground-soft">
        <span className="size-1.5 shrink-0 rounded-full bg-app-project" />
        <span className="truncate">{label}</span>
      </div>
      {resultText && resultText.length > 5 ? (
        <details className="group">
          <summary className="flex cursor-pointer items-center gap-1.5 pl-1 text-[11px] text-app-muted hover:text-app-foreground-soft [&::-webkit-details-marker]:hidden">
            <svg className="size-2.5 shrink-0 transition-transform group-open:rotate-90" viewBox="0 0 12 12" fill="none">
              <path d="M4.5 2.5L8.5 6L4.5 9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Output
          </summary>
          <pre className="mt-1 max-h-[12rem] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-app-border bg-app-base p-2.5 text-[11px] leading-5 text-app-muted">
            {resultText.slice(0, 2000)}{resultText.length > 2000 ? "…" : ""}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

function SystemText({ text }: { text: string }) {
  return <span>{text}</span>;
}

// ---------------------------------------------------------------------------
// Markdown rendering (simple but effective)
// ---------------------------------------------------------------------------

function MarkdownContent({ text }: { text: string }) {
  // Split by code blocks first, then render inline markdown for non-code parts
  const parts = text.split(/(```[\s\S]*?```)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("```")) {
          const match = part.match(/^```(\w*)\n?([\s\S]*?)```$/);
          const lang = match?.[1] ?? "";
          const code = match?.[2] ?? part.slice(3, -3);
          return (
            <pre key={i} className="overflow-auto rounded-lg border border-app-border bg-app-sidebar p-3 text-[13px] leading-6">
              {lang ? <div className="mb-2 text-[11px] text-app-muted">{lang}</div> : null}
              <code>{code}</code>
            </pre>
          );
        }
        return <InlineMarkdown key={i} text={part} />;
      })}
    </>
  );
}

function InlineMarkdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const elements: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Headings
    const headingMatch = line.match(/^(#{1,4})\s+(.+)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const content = renderInline(headingMatch[2]);
      if (level === 1) elements.push(<h1 key={i}>{content}</h1>);
      else if (level === 2) elements.push(<h2 key={i}>{content}</h2>);
      else if (level === 3) elements.push(<h3 key={i}>{content}</h3>);
      else elements.push(<h4 key={i}>{content}</h4>);
      i++;
      continue;
    }

    // Unordered list items
    if (line.match(/^[-*]\s/)) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && lines[i].match(/^[-*]\s/)) {
        items.push(<li key={i}>{renderInline(lines[i].replace(/^[-*]\s/, ""))}</li>);
        i++;
      }
      elements.push(<ul key={`ul-${i}`}>{items}</ul>);
      continue;
    }

    // Ordered list items
    if (line.match(/^\d+\.\s/)) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && lines[i].match(/^\d+\.\s/)) {
        items.push(<li key={i}>{renderInline(lines[i].replace(/^\d+\.\s/, ""))}</li>);
        i++;
      }
      elements.push(<ol key={`ol-${i}`}>{items}</ol>);
      continue;
    }

    // Empty line
    if (!line.trim()) {
      i++;
      continue;
    }

    // Regular paragraph
    elements.push(<p key={i}>{renderInline(line)}</p>);
    i++;
  }

  return <>{elements}</>;
}

function renderInline(text: string): React.ReactNode {
  // Bold, italic, inline code, links
  const parts: React.ReactNode[] = [];
  const regex = /(\*\*.*?\*\*)|(`[^`]+`)|(\[([^\]]+)\]\(([^)]+)\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    if (match[1]) {
      // Bold
      parts.push(<strong key={match.index}>{match[1].slice(2, -2)}</strong>);
    } else if (match[2]) {
      // Inline code
      parts.push(<code key={match.index}>{match[2].slice(1, -1)}</code>);
    } else if (match[3]) {
      // Link
      parts.push(
        <a key={match.index} href={match[5]} target="_blank" rel="noopener noreferrer">
          {match[4]}
        </a>,
      );
    }
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts.length === 1 ? parts[0] : <>{parts}</>;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function describeToolCall(name: string, input: Record<string, unknown> | null): string {
  if (!input) return name;

  if (name === "Read") {
    const fp = str(input.file_path);
    return fp ? `Read ${basename(fp)}` : "Read file";
  }
  if (name === "Write") {
    const fp = str(input.file_path);
    return fp ? `Write ${basename(fp)}` : "Write file";
  }
  if (name === "Edit") {
    const fp = str(input.file_path);
    return fp ? `Edit ${basename(fp)}` : "Edit file";
  }
  if (name === "Bash") {
    const cmd = str(input.command);
    return cmd ? `Run ${cmd.length > 50 ? `${cmd.slice(0, 50)}…` : cmd}` : "Run command";
  }
  if (name === "Grep" || name === "Glob") {
    const p = str(input.pattern);
    return p ? `${name} ${p}` : name;
  }
  if (name === "Agent" || name === "Task") {
    const d = str(input.description) ?? str(input.prompt);
    return d ? `${name}: ${d.length > 40 ? `${d.slice(0, 40)}…` : d}` : name;
  }
  return name;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

function basename(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() ?? path;
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
