/**
 * Adapter: Conductor SessionMessageRecord[] → assistant-ui ThreadMessageLike[]
 */
import type { ThreadMessageLike } from "@assistant-ui/react";
import type { SessionMessageRecord } from "./conductor";

type TextPart = { type: "text"; text: string };
type ReasoningPart = { type: "reasoning"; text: string };
type ToolCallPart = {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  argsText: string;
  result?: unknown;
};
type AnyPart = TextPart | ReasoningPart | ToolCallPart;

export function convertConductorMessages(
  messages: SessionMessageRecord[],
): ThreadMessageLike[] {
  return groupChildMessages(convertMessagesFlat(messages));
}

function convertMessagesFlat(
  messages: SessionMessageRecord[],
): ThreadMessageLike[] {
  const result: ThreadMessageLike[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const parsed = msg.contentIsJson
      ? (msg.parsedContent as Record<string, unknown> | undefined)
      : undefined;
    const msgType = parsed?.type as string | undefined;

    // system — skip noise subtypes
    if (msgType === "system") {
      const sub = parsed!.subtype as string | undefined;
      if (sub === "init" || sub === "task_progress" || sub === "task_started" || sub === "task_completed") continue;
      result.push(makeSystem(msg, buildSystemLabel(parsed!)));
      continue;
    }

    // result (session summary)
    if (msgType === "result") {
      result.push(makeSystem(msg, buildResultLabel(parsed!)));
      continue;
    }

    // error
    if (msgType === "error" || msg.role === "error") {
      result.push(makeSystem(msg, buildErrorLabel(msg, parsed)));
      continue;
    }

    // assistant
    if (msgType === "assistant") {
      const parts = parseAssistantParts(parsed);
      const isChild = parsed != null && typeof parsed.parent_tool_use_id === "string";

      // Look ahead: merge following user/tool_result messages
      while (i + 1 < messages.length) {
        const next = messages[i + 1];
        const np = next.contentIsJson
          ? (next.parsedContent as Record<string, unknown> | undefined)
          : undefined;
        const nextType = np?.type as string | undefined;
        if (nextType !== "user") break;
        const merged = mergeToolResults(np, parts);
        if (!merged) break;
        i++;
      }

      if (parts.length === 0) {
        const fb = extractFallback(msg);
        if (fb) parts.push({ type: "text", text: fb });
      }

      result.push({
        role: "assistant",
        id: isChild ? `child:${msg.id}` : msg.id,
        createdAt: new Date(msg.createdAt),
        content: parts as ThreadMessageLike["content"],
        status: { type: "complete", reason: "stop" },
      });
      continue;
    }

    // user — tool_result messages: merge into previous assistant or skip entirely
    if (msgType === "user") {
      const prev = result[result.length - 1];
      if (prev?.role === "assistant" && parsed) {
        mergeToolResults(parsed, prev.content as AnyPart[]);
      }
      // Never render user tool_result messages as standalone — they are always
      // paired with a tool-call and should be merged or silently skipped.
      // Only show real user text messages (non-JSON or with actual text content).
      if (parsed) continue;
      result.push(convertUserMessage(msg, parsed));
      continue;
    }

    // user by role (plain text, non-JSON)
    if (msg.role === "user" && !parsed) {
      result.push(convertUserMessage(msg, undefined));
      continue;
    }

    // unknown
    result.push(makeSystem(msg, msgType ? `${msgType} event` : "Event"));
  }

  return result;
}

// ---------------------------------------------------------------------------
// Assistant parsing
// ---------------------------------------------------------------------------

function parseAssistantParts(
  parsed: Record<string, unknown> | undefined,
): AnyPart[] {
  if (!parsed) return [];
  const msg = isObj(parsed.message) ? parsed.message : null;
  const blocks = Array.isArray(msg?.content) ? msg!.content : [];
  const parts: AnyPart[] = [];

  for (const b of blocks) {
    if (!isObj(b)) continue;
    if (b.type === "thinking" && typeof b.thinking === "string") {
      parts.push({ type: "reasoning", text: b.thinking });
    } else if (b.type === "redacted_thinking") {
      parts.push({ type: "reasoning", text: "[Thinking redacted]" });
    } else if (b.type === "text" && typeof b.text === "string") {
      parts.push({ type: "text", text: b.text });
    } else if (b.type === "tool_use" || b.type === "server_tool_use") {
      const args = isObj(b.input) ? (b.input as Record<string, unknown>) : {};
      parts.push({
        type: "tool-call",
        toolCallId: String(b.id ?? `tc-${parts.length}`),
        toolName: String(b.name ?? "unknown"),
        args,
        argsText: JSON.stringify(args),
      });
    }
  }
  return parts;
}

// ---------------------------------------------------------------------------
// Merge tool_result user messages into preceding tool-call parts
// ---------------------------------------------------------------------------

function mergeToolResults(
  parsed: Record<string, unknown> | undefined,
  targetParts: AnyPart[],
): boolean {
  if (!parsed) return false;
  const msg = isObj(parsed.message) ? parsed.message : null;
  const blocks = Array.isArray(msg?.content) ? msg!.content : [];
  if (blocks.length === 0) return false;

  let allToolResult = true;
  const results: { toolUseId: string; content: string }[] = [];

  for (const b of blocks) {
    if (!isObj(b)) continue;
    if (b.type === "tool_result") {
      const content = typeof b.content === "string"
        ? b.content
        : Array.isArray(b.content)
          ? (b.content as unknown[])
              .filter((x): x is Record<string, unknown> => isObj(x) && typeof x.text === "string")
              .map((x) => x.text as string)
              .join("\n")
          : "";
      results.push({
        toolUseId: String(b.tool_use_id ?? ""),
        content,
      });
    } else if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
      allToolResult = false;
    } else if (b.type !== "image" && b.type !== "file") {
      allToolResult = false;
    }
  }

  if (!allToolResult || results.length === 0) return false;

  // Attach results to matching tool-call parts
  for (const r of results) {
    const tc = targetParts.find(
      (p): p is ToolCallPart =>
        p.type === "tool-call" && p.toolCallId === r.toolUseId,
    );
    if (tc) {
      tc.result = r.content;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// User message
// ---------------------------------------------------------------------------

function convertUserMessage(
  msg: SessionMessageRecord,
  parsed: Record<string, unknown> | undefined,
): ThreadMessageLike {
  const parts: TextPart[] = [];
  if (parsed) {
    const message = isObj(parsed.message) ? parsed.message : null;
    const blocks = Array.isArray(message?.content) ? message!.content : [];
    for (const b of blocks) {
      if (isObj(b) && b.type === "text" && typeof b.text === "string") {
        parts.push({ type: "text", text: b.text });
      }
    }
  }
  if (parts.length === 0) {
    parts.push({ type: "text", text: extractFallback(msg) });
  }
  return {
    role: "user",
    id: msg.id,
    createdAt: new Date(msg.createdAt),
    content: parts,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSystem(msg: SessionMessageRecord, text: string): ThreadMessageLike {
  return {
    role: "system",
    id: msg.id,
    createdAt: new Date(msg.createdAt),
    content: [{ type: "text", text }],
  };
}

function buildSystemLabel(p: Record<string, unknown>): string {
  const sub = p.subtype as string | undefined;
  const model = p.model as string | undefined;
  if (sub === "init") return model ? `Session initialized — ${model}` : "Session initialized";
  return sub ? `System: ${sub}` : "System";
}

function buildResultLabel(p: Record<string, unknown>): string {
  const cost = typeof p.total_cost_usd === "number" ? p.total_cost_usd : null;
  const durationMs = typeof p.duration_ms === "number" ? p.duration_ms : null;
  const bits: string[] = [];
  if (durationMs) {
    const totalSecs = durationMs / 1000;
    if (totalSecs >= 60) {
      const mins = Math.floor(totalSecs / 60);
      const secs = Math.round(totalSecs % 60);
      bits.push(secs > 0 ? `${mins}m ${secs}s` : `${mins}m`);
    } else {
      bits.push(`${totalSecs.toFixed(1)}s`);
    }
  }
  if (cost) bits.push(`$${cost.toFixed(4)}`);
  return bits.join(" • ") || "Done";
}

function buildErrorLabel(
  msg: SessionMessageRecord,
  parsed: Record<string, unknown> | undefined,
): string {
  // Try to extract a clean error message from structured content
  if (parsed) {
    const content = parsed.content as string | undefined;
    if (typeof content === "string" && content.trim()) return `Error: ${content}`;
    const message = parsed.message as string | undefined;
    if (typeof message === "string" && message.trim()) return `Error: ${message}`;
  }
  // If the raw content is JSON, try parsing it
  if (msg.contentIsJson && msg.parsedContent) {
    const p = msg.parsedContent as Record<string, unknown>;
    if (typeof p.content === "string") return `Error: ${p.content}`;
    if (typeof p.message === "string") return `Error: ${p.message}`;
  }
  const fb = extractFallback(msg);
  // Don't show raw JSON as error text
  if (fb.startsWith("{")) {
    try {
      const obj = JSON.parse(fb) as Record<string, unknown>;
      if (typeof obj.content === "string") return `Error: ${obj.content}`;
      if (typeof obj.message === "string") return `Error: ${obj.message}`;
    } catch { /* ignore */ }
  }
  return `Error: ${fb}`;
}

function extractFallback(msg: SessionMessageRecord): string {
  if (!msg.contentIsJson) return msg.content;
  const p = msg.parsedContent as Record<string, unknown> | undefined;
  if (!p) return msg.content;
  if (typeof p.text === "string" && p.text.trim()) return p.text;
  if (typeof p.result === "string" && p.result.trim()) return p.result;
  const m = isObj(p.message) ? p.message : null;
  if (m && typeof m.content === "string") return m.content;
  if (m && Array.isArray(m.content)) {
    const texts = (m.content as unknown[])
      .filter((b): b is Record<string, unknown> => isObj(b) && typeof b.text === "string")
      .map((b) => b.text as string);
    if (texts.length > 0) return texts.join("\n\n");
  }
  return msg.content.slice(0, 200);
}

/**
 * Group consecutive child messages (sub-agent) into a single collapsible
 * "children" text part on the preceding parent assistant message.
 *
 * The component detects the `__children__` prefix in text parts and renders
 * them as a collapsible details section.
 */
function groupChildMessages(msgs: ThreadMessageLike[]): ThreadMessageLike[] {
  const out: ThreadMessageLike[] = [];

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.id?.startsWith("child:")) {
      const parent = out[out.length - 1];
      if (parent?.role === "assistant") {
        // Collect all consecutive child parts
        const childParts: AnyPart[] = [];
        while (i < msgs.length && msgs[i].id?.startsWith("child:")) {
          const parts = msgs[i].content as AnyPart[];
          childParts.push(...parts);
          i++;
        }
        i--;

        // Find the last Agent/Task tool-call in the parent and attach children to its result
        const parentParts = parent.content as AnyPart[];
        const agentTc = [...parentParts].reverse().find(
          (p): p is ToolCallPart =>
            p.type === "tool-call" && (p.toolName === "Agent" || p.toolName === "Task"),
        );
        if (agentTc) {
          agentTc.result = `__children__${JSON.stringify({ parts: childParts })}`;
        }
      }
      continue;
    }
    out.push(m);
  }

  return out;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
