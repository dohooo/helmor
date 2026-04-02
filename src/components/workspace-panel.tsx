import { useState } from "react";
import {
  AlertCircle,
  BrainCircuit,
  ChevronDown,
  Clock3,
  FileText,
  FolderKanban,
  GitBranch,
  Image as ImageIcon,
  Info,
  MessageSquareText,
  Sparkles,
  TerminalSquare,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  SessionAttachmentRecord,
  SessionMessageRecord,
  WorkspaceDetail,
  WorkspaceSessionSummary,
} from "@/lib/conductor";

type WorkspacePanelProps = {
  workspace: WorkspaceDetail | null;
  sessions: WorkspaceSessionSummary[];
  selectedSessionId: string | null;
  messages: SessionMessageRecord[];
  attachments: SessionAttachmentRecord[];
  loadingWorkspace?: boolean;
  loadingSession?: boolean;
  onSelectSession?: (sessionId: string) => void;
};

type TimelineBlock =
  | { id: string; kind: "thinking"; text: string }
  | { id: string; kind: "text"; text: string }
  | { id: string; kind: "tool"; label: string; input?: string }
  | { id: string; kind: "tool-result"; label: string; output?: string }
  | { id: string; kind: "result"; text: string }
  | { id: string; kind: "system"; label: string; details?: string };

export function WorkspacePanel({
  workspace,
  sessions,
  selectedSessionId,
  messages,
  attachments,
  loadingWorkspace = false,
  loadingSession = false,
  onSelectSession,
}: WorkspacePanelProps) {
  const selectedSession = sessions.find((session) => session.id === selectedSessionId) ?? null;
  const attachmentIndex = new Map(
    attachments.map((attachment) => [attachment.id, attachment]),
  );
  const attachmentsByMessage = new Map<string, SessionAttachmentRecord[]>();

  for (const attachment of attachments) {
    if (!attachment.sessionMessageId) {
      continue;
    }

    const current = attachmentsByMessage.get(attachment.sessionMessageId) ?? [];
    current.push(attachment);
    attachmentsByMessage.set(attachment.sessionMessageId, current);
  }

  const visibleMessages = messages.slice(-24);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-app-elevated">
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
              <span className="px-1 py-0.5 font-medium text-app-muted">
                Archived
              </span>
            ) : null}
          </div>
        </div>

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
                  onClick={() => {
                    onSelectSession?.(session.id);
                  }}
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

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div
          aria-label="Workspace timeline"
          className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-5"
        >
          {loadingSession ? (
            <div className="flex items-center gap-2 rounded-2xl border border-app-border bg-app-sidebar px-4 py-3 text-sm text-app-muted">
              <Clock3 className="size-4 animate-pulse" strokeWidth={1.8} />
              Loading session timeline
            </div>
          ) : visibleMessages.length > 0 ? (
            <div className="space-y-4">
              {visibleMessages.map((message) => (
                <TimelineMessage
                  key={message.id}
                  message={message}
                  attachments={attachmentsByMessage.get(message.id) ?? []}
                  attachmentIndex={attachmentIndex}
                />
              ))}
            </div>
          ) : (
            <div className="m-auto max-w-md rounded-[22px] border border-app-border bg-app-sidebar px-5 py-6 text-center">
              <div className="mx-auto flex size-12 items-center justify-center rounded-2xl border border-app-border-strong bg-app-sidebar text-app-foreground-soft">
                <MessageSquareText className="size-5" strokeWidth={1.8} />
              </div>
              <h3 className="mt-4 text-[15px] font-semibold text-app-foreground">
                {selectedSession ? "This session is quiet for now" : "No session selected"}
              </h3>
              <p className="mt-2 text-[13px] leading-6 text-app-muted">
                {selectedSession
                  ? "The selected session does not have stored timeline events in this fixture yet."
                  : "Pick a session tab to inspect its stored Conductor data."}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TimelineMessage({
  message,
  attachments,
  attachmentIndex,
}: {
  message: SessionMessageRecord;
  attachments: SessionAttachmentRecord[];
  attachmentIndex: Map<string, SessionAttachmentRecord>;
}) {
  const blocks = getTimelineBlocks(message, attachmentIndex);
  const isUser = message.role === "user";

  if (blocks.length === 0) {
    return null;
  }

  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div className={cn("max-w-[52rem] space-y-2", isUser ? "items-end" : "items-start")}>
        {blocks.map((block) => (
          <TimelineBlockView key={block.id} block={block} align={isUser ? "right" : "left"} />
        ))}

        {attachments.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {attachments.map((attachment) => (
              <span
                key={attachment.id}
                className="inline-flex items-center gap-1 rounded-md border border-app-border bg-app-sidebar px-2 py-1 text-[11px] text-app-foreground-soft"
              >
                {attachment.attachmentType === "image" ? (
                  <ImageIcon className="size-3.5 text-app-project" strokeWidth={1.8} />
                ) : (
                  <FileText className="size-3.5 text-app-project" strokeWidth={1.8} />
                )}
                {attachment.originalName ?? "Attachment"}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function TimelineBlockView({
  block,
  align,
}: {
  block: TimelineBlock;
  align: "left" | "right";
}) {
  if (block.kind === "system") {
    return <SystemBlock label={block.label} details={block.details} />;
  }

  if (block.kind === "tool") {
    return (
      <div className="space-y-1">
        <div className="inline-flex items-center gap-2 rounded-xl border border-app-border bg-app-sidebar px-3 py-2 text-[12px] text-app-foreground-soft">
          <TerminalSquare className="size-3.5 text-app-project" strokeWidth={1.8} />
          <span>{block.label}</span>
        </div>
        {block.input ? (
          <CollapsibleCode label="Input" content={block.input} />
        ) : null}
      </div>
    );
  }

  if (block.kind === "tool-result") {
    return (
      <div className="space-y-1">
        <div className="inline-flex items-center gap-2 rounded-xl border border-app-border bg-app-sidebar px-3 py-2 text-[12px] text-app-foreground-soft">
          <Sparkles className="size-3.5 text-app-project" strokeWidth={1.8} />
          <span>{block.label}</span>
        </div>
        {block.output ? (
          <CollapsibleCode label="Output" content={block.output} />
        ) : null}
      </div>
    );
  }

  if (block.kind === "thinking") {
    return <ThinkingBlock text={block.text} />;
  }

  if (block.kind === "result") {
    return (
      <div className="inline-flex items-center gap-2 rounded-xl border border-app-border bg-app-base px-3 py-2 text-[11px] text-app-muted">
        <Sparkles className="size-3.5 text-app-project" strokeWidth={1.8} />
        <span>{block.text}</span>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "rounded-2xl border px-4 py-3 text-[14px] leading-7",
        align === "right"
          ? "border-app-border bg-app-sidebar-strong text-app-foreground"
          : "border-app-border bg-app-sidebar text-app-foreground-soft",
      )}
    >
      <pre className="whitespace-pre-wrap font-sans">{block.text}</pre>
    </div>
  );
}

function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const preview = text.length > 120 ? `${text.slice(0, 120)}…` : text;

  return (
    <div className="rounded-2xl border border-app-border bg-app-sidebar px-4 py-3">
      <button
        type="button"
        onClick={() => { setOpen((o) => !o); }}
        className="flex w-full items-center gap-2 text-[12px] font-medium text-app-foreground-soft"
      >
        <BrainCircuit className="size-3.5 text-app-accent" strokeWidth={1.8} />
        <span>Thinking</span>
        <ChevronDown className={cn("ml-auto size-3.5 transition-transform", open && "rotate-180")} strokeWidth={1.8} />
      </button>
      {open ? (
        <pre className="mt-2 max-h-[20rem] overflow-y-auto whitespace-pre-wrap font-sans text-[13px] leading-6 text-app-foreground-soft">
          {text}
        </pre>
      ) : (
        <p className="mt-1.5 truncate text-[12px] text-app-muted">{preview}</p>
      )}
    </div>
  );
}

function SystemBlock({ label, details }: { label: string; details?: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="w-full">
      <button
        type="button"
        onClick={() => { setOpen((o) => !o); }}
        className="inline-flex items-center gap-2 rounded-lg border border-app-border bg-app-sidebar px-3 py-1.5 text-[11px] text-app-muted transition-colors hover:text-app-foreground-soft"
      >
        <Info className="size-3" strokeWidth={1.8} />
        <span>{label}</span>
        {details ? (
          <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} strokeWidth={1.8} />
        ) : null}
      </button>
      {open && details ? (
        <pre className="mt-2 max-h-[12rem] overflow-auto rounded-lg border border-app-border bg-app-base p-3 text-[11px] leading-5 text-app-muted">
          {details}
        </pre>
      ) : null}
    </div>
  );
}

function CollapsibleCode({ label, content }: { label: string; content: string }) {
  const [open, setOpen] = useState(false);
  const preview = content.length > 80 ? `${content.slice(0, 80)}…` : content;

  return (
    <div>
      <button
        type="button"
        onClick={() => { setOpen((o) => !o); }}
        className="flex items-center gap-1 pl-3 text-[11px] text-app-muted hover:text-app-foreground-soft"
      >
        <ChevronDown className={cn("size-3 transition-transform", open ? "rotate-0" : "-rotate-90")} strokeWidth={1.8} />
        <span>{label}</span>
        {!open ? <span className="ml-1 truncate opacity-50">{preview}</span> : null}
      </button>
      {open ? (
        <pre className="mt-1 max-h-[16rem] overflow-auto rounded-lg border border-app-border bg-app-base p-3 text-[11px] leading-5 text-app-muted">
          {content}
        </pre>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Data parsing
// ---------------------------------------------------------------------------

function getTimelineBlocks(
  message: SessionMessageRecord,
  attachmentIndex: Map<string, SessionAttachmentRecord>,
): TimelineBlock[] {
  if (!message.contentIsJson || !isRecord(message.parsedContent)) {
    return [
      {
        id: `${message.id}:raw`,
        kind: "text",
        text: message.content,
      },
    ];
  }

  const parsed = message.parsedContent;
  const parsedType = typeof parsed.type === "string" ? parsed.type : null;

  // --- assistant message (text, thinking, tool_use blocks) ---
  if (parsedType === "assistant") {
    return parseAssistantMessage(message.id, parsed);
  }

  // --- result message (token usage summary) ---
  if (parsedType === "result") {
    return parseResultMessage(message.id, parsed);
  }

  // --- user message (text, tool_result, images) ---
  if (parsedType === "user") {
    return parseUserMessage(message.id, parsed, attachmentIndex);
  }

  // --- system message (session init, config) ---
  if (parsedType === "system") {
    return parseSystemMessage(message.id, parsed);
  }

  // --- unknown JSON type — show as collapsed system info instead of raw dump ---
  return [
    {
      id: `${message.id}:unknown`,
      kind: "system",
      label: parsedType ? `${parsedType} event` : "Event",
      details: formatJson(parsed),
    },
  ];
}

function parseAssistantMessage(
  messageId: string,
  parsed: Record<string, unknown>,
): TimelineBlock[] {
  const assistantMessage = isRecord(parsed.message) ? parsed.message : null;
  const content = Array.isArray(assistantMessage?.content)
    ? assistantMessage?.content
    : [];
  const blocks = content.flatMap((block, index) =>
    parseAssistantContentBlock(messageId, block, index),
  );

  if (blocks.length > 0) {
    return blocks;
  }

  // Fallback: try to find any text in the message
  const fallbackText = extractDeepText(parsed);
  return fallbackText
    ? [{ id: `${messageId}:assistant-fallback`, kind: "text", text: fallbackText }]
    : [{ id: `${messageId}:assistant-empty`, kind: "system", label: "Assistant response (empty)" }];
}

function parseResultMessage(
  messageId: string,
  parsed: Record<string, unknown>,
): TimelineBlock[] {
  const usage = isRecord(parsed.usage) ? parsed.usage : null;
  const inputTokens = asNumber(usage?.input_tokens);
  const outputTokens = asNumber(usage?.output_tokens);
  const bits = [
    inputTokens ? `in ${inputTokens.toLocaleString()}` : null,
    outputTokens ? `out ${outputTokens.toLocaleString()}` : null,
  ].filter(Boolean);

  return [
    {
      id: `${messageId}:result`,
      kind: "result",
      text: bits.length > 0 ? `Session result • ${bits.join(" • ")}` : "Session result",
    },
  ];
}

function parseUserMessage(
  messageId: string,
  parsed: Record<string, unknown>,
  attachmentIndex: Map<string, SessionAttachmentRecord>,
): TimelineBlock[] {
  const userMessage = isRecord(parsed.message) ? parsed.message : null;
  const content = Array.isArray(userMessage?.content) ? userMessage?.content : [];

  const blocks: TimelineBlock[] = [];
  const textParts: string[] = [];

  for (const [index, block] of content.entries()) {
    if (!isRecord(block)) continue;

    if (block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
      continue;
    }

    // tool_result — can contain text string, array of content blocks, or nested structures
    if (block.type === "tool_result") {
      // Flush accumulated text first
      if (textParts.length > 0) {
        blocks.push({
          id: `${messageId}:user-text:${index}`,
          kind: "text",
          text: textParts.join("\n\n").trim(),
        });
        textParts.length = 0;
      }

      const toolName = typeof block.tool_use_id === "string"
        ? `Tool result`
        : "Tool result";

      if (typeof block.content === "string") {
        blocks.push({
          id: `${messageId}:tool-result:${index}`,
          kind: "tool-result",
          label: toolName,
          output: block.content.length > 200 ? block.content : undefined,
        });
        if (block.content.length <= 200) {
          blocks.push({
            id: `${messageId}:tool-result-text:${index}`,
            kind: "text",
            text: block.content,
          });
        }
      } else if (Array.isArray(block.content)) {
        const resultText = extractTextFromContentArray(block.content, attachmentIndex);
        if (resultText) {
          blocks.push({
            id: `${messageId}:tool-result:${index}`,
            kind: "tool-result",
            label: toolName,
            output: resultText.length > 200 ? resultText : undefined,
          });
          if (resultText.length <= 200) {
            blocks.push({
              id: `${messageId}:tool-result-text:${index}`,
              kind: "text",
              text: resultText,
            });
          }
        } else {
          blocks.push({
            id: `${messageId}:tool-result:${index}`,
            kind: "tool-result",
            label: toolName,
          });
        }
      } else {
        blocks.push({
          id: `${messageId}:tool-result:${index}`,
          kind: "tool-result",
          label: toolName,
        });
      }
      continue;
    }

    // tool_use inside user message (forwarded)
    if (block.type === "tool_use") {
      if (textParts.length > 0) {
        blocks.push({
          id: `${messageId}:user-text:${index}`,
          kind: "text",
          text: textParts.join("\n\n").trim(),
        });
        textParts.length = 0;
      }
      blocks.push({
        id: `${messageId}:tool:${index}`,
        kind: "tool",
        label: describeToolUse(block),
        input: isRecord(block.input) ? formatJson(block.input) : undefined,
      });
      continue;
    }

    // image / file reference
    if (block.type === "image" || block.type === "file") {
      const attachmentId =
        maybeString(block.attachment_id) ?? maybeString(block.id) ?? maybeString(block.file_id);
      const attachment = attachmentId ? attachmentIndex.get(attachmentId) : null;
      const name = attachment?.originalName ?? (block.type === "image" ? "Image" : "File");
      textParts.push(`[${name}]`);
      continue;
    }
  }

  // Flush remaining text
  if (textParts.length > 0) {
    blocks.push({
      id: `${messageId}:user-text-final`,
      kind: "text",
      text: textParts.join("\n\n").trim(),
    });
  }

  if (blocks.length === 0) {
    // Fallback — try to get anything readable
    const fallback = extractDeepText(parsed);
    if (fallback) {
      return [{ id: `${messageId}:user-fallback`, kind: "text", text: fallback }];
    }
    return [{ id: `${messageId}:user-empty`, kind: "system", label: "User message" }];
  }

  return blocks;
}

function parseSystemMessage(
  messageId: string,
  parsed: Record<string, unknown>,
): TimelineBlock[] {
  const subtype = maybeString(parsed.subtype as string);
  const model = maybeString(parsed.model as string);
  const sessionId = maybeString(parsed.session_id as string);

  let label = "System";
  if (subtype === "init") {
    label = model ? `Session initialized • ${model}` : "Session initialized";
  } else if (subtype) {
    label = `System: ${subtype}`;
  }

  // Build a summary of interesting fields
  const summaryParts: string[] = [];
  if (sessionId) summaryParts.push(`Session: ${sessionId.slice(0, 8)}…`);
  if (model) summaryParts.push(`Model: ${model}`);
  const permMode = maybeString(parsed.permissionMode as string);
  if (permMode) summaryParts.push(`Mode: ${permMode}`);
  const tools = parsed.tools;
  if (Array.isArray(tools)) summaryParts.push(`Tools: ${tools.length} available`);

  return [
    {
      id: `${messageId}:system`,
      kind: "system",
      label,
      details: summaryParts.length > 0 ? summaryParts.join("\n") : formatJson(parsed),
    },
  ];
}

function parseAssistantContentBlock(
  messageId: string,
  block: unknown,
  index: number,
): TimelineBlock[] {
  if (!isRecord(block)) {
    return [];
  }

  if (block.type === "thinking" && typeof block.thinking === "string") {
    return [
      {
        id: `${messageId}:thinking:${index}`,
        kind: "thinking",
        text: block.thinking,
      },
    ];
  }

  if (block.type === "text" && typeof block.text === "string") {
    return [
      {
        id: `${messageId}:text:${index}`,
        kind: "text",
        text: block.text,
      },
    ];
  }

  if (block.type === "tool_use") {
    return [
      {
        id: `${messageId}:tool:${index}`,
        kind: "tool",
        label: describeToolUse(block),
        input: isRecord(block.input) ? formatJson(block.input) : undefined,
      },
    ];
  }

  if (block.type === "tool_result") {
    const content = typeof block.content === "string"
      ? block.content
      : Array.isArray(block.content)
        ? block.content.map((b) => (isRecord(b) && typeof b.text === "string" ? b.text : "")).filter(Boolean).join("\n")
        : undefined;
    return [
      {
        id: `${messageId}:tool-result:${index}`,
        kind: "tool-result",
        label: "Tool result",
        output: content,
      },
    ];
  }

  return [];
}

function describeToolUse(block: Record<string, unknown>): string {
  const name = typeof block.name === "string" ? block.name : "Tool";
  const input = isRecord(block.input) ? block.input : null;

  if (name === "Read" && input) {
    const filePath = maybeString(input.file_path);
    const offset = asNumber(input.offset);
    const limit = asNumber(input.limit);
    const fileName = filePath ? basename(filePath) : "file";
    const lineText = limit ? `Read ${limit} lines` : "Read file";
    const offsetText = offset ? ` from line ${offset}` : "";
    return `${lineText} ${fileName}${offsetText}`;
  }

  if (name === "Write" && input) {
    const filePath = maybeString(input.file_path);
    return `Write ${filePath ? basename(filePath) : "file"}`;
  }

  if (name === "Edit" && input) {
    const filePath = maybeString(input.file_path);
    return `Edit ${filePath ? basename(filePath) : "file"}`;
  }

  if (name === "Bash" && input) {
    const command = maybeString(input.command);
    if (command) {
      const short = command.length > 60 ? `${command.slice(0, 60)}…` : command;
      return `Run ${short}`;
    }
    return "Run shell command";
  }

  if ((name === "Grep" || name === "Glob") && input) {
    const pattern = maybeString(input.pattern);
    return pattern ? `${name} ${pattern}` : name;
  }

  if ((name === "Task" || name === "Agent") && input) {
    const description = maybeString(input.description);
    const prompt = maybeString(input.prompt);
    const text = description ?? prompt;
    if (text) {
      const short = text.length > 50 ? `${text.slice(0, 50)}…` : text;
      return `${name}: ${short}`;
    }
    return name;
  }

  return name;
}

function extractTextFromContentArray(
  content: unknown[],
  attachmentIndex: Map<string, SessionAttachmentRecord>,
): string | null {
  const parts: string[] = [];
  for (const item of content) {
    if (!isRecord(item)) continue;
    if (item.type === "text" && typeof item.text === "string") {
      parts.push(item.text);
    } else if (item.type === "image") {
      const attachmentId = maybeString(item.attachment_id) ?? maybeString(item.id);
      const attachment = attachmentId ? attachmentIndex.get(attachmentId) : null;
      parts.push(`[${attachment?.originalName ?? "Image"}]`);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

function extractDeepText(obj: Record<string, unknown>): string | null {
  // Try to find text content in nested structures
  if (typeof obj.text === "string" && obj.text.trim()) return obj.text;
  if (typeof obj.content === "string" && obj.content.trim()) return obj.content;

  const message = isRecord(obj.message) ? obj.message : null;
  if (message) {
    if (typeof message.content === "string" && message.content.trim()) return message.content;
    if (Array.isArray(message.content)) {
      const texts = message.content
        .map((b) => (isRecord(b) && typeof b.text === "string" ? b.text : null))
        .filter(Boolean);
      if (texts.length > 0) return texts.join("\n\n");
    }
  }

  return null;
}

function formatJson(obj: unknown): string {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(obj);
  }
}

function SessionProviderIcon({
  agentType,
  active,
}: {
  agentType?: string | null;
  active: boolean;
}) {
  const isCodex = agentType === "codex";

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
        isCodex ? "text-app-project" : "text-app-foreground-soft",
      )}
      strokeWidth={1.8}
    />
  );
}

function displaySessionTitle(session: WorkspaceSessionSummary): string {
  if (session.title && session.title !== "Untitled") {
    return session.title;
  }

  return session.agentType === "codex" ? "Codex session" : "Claude session";
}

function basename(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || value;
}

function maybeString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
