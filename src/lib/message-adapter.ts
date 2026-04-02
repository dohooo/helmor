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
  const result: ThreadMessageLike[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const parsed = msg.contentIsJson
      ? (msg.parsedContent as Record<string, unknown> | undefined)
      : undefined;
    const msgType = parsed?.type as string | undefined;

    // system
    if (msgType === "system") {
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
      result.push(makeSystem(msg, `Error: ${extractFallback(msg)}`));
      continue;
    }

    // assistant
    if (msgType === "assistant" || msg.role === "assistant") {
      const parts = parseAssistantParts(parsed);

      // Look ahead: merge following user messages that are pure tool_result
      while (i + 1 < messages.length) {
        const next = messages[i + 1];
        const np = next.contentIsJson
          ? (next.parsedContent as Record<string, unknown> | undefined)
          : undefined;
        if ((np?.type ?? next.role) !== "user") break;
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
        id: msg.id,
        createdAt: new Date(msg.createdAt),
        content: parts as ThreadMessageLike["content"],
        status: { type: "complete", reason: "stop" },
      });
      continue;
    }

    // user
    if (msgType === "user" || msg.role === "user") {
      // Try to merge pure tool_result into previous assistant
      const prev = result[result.length - 1];
      if (prev?.role === "assistant" && parsed) {
        const merged = mergeToolResults(parsed, prev.content as AnyPart[]);
        if (merged) continue;
      }
      result.push(convertUserMessage(msg, parsed));
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
    } else if (b.type === "text" && typeof b.text === "string") {
      parts.push({ type: "text", text: b.text });
    } else if (b.type === "tool_use") {
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
  const u = isObj(p.usage) ? p.usage : null;
  const inp = typeof u?.input_tokens === "number" ? u.input_tokens : null;
  const out = typeof u?.output_tokens === "number" ? u.output_tokens : null;
  const cost = typeof p.total_cost_usd === "number" ? p.total_cost_usd : null;
  const bits: string[] = [];
  if (inp) bits.push(`in ${(inp as number).toLocaleString()}`);
  if (out) bits.push(`out ${(out as number).toLocaleString()}`);
  if (cost) bits.push(`$${(cost as number).toFixed(4)}`);
  const summary = bits.length > 0 ? `Session complete • ${bits.join(" • ")}` : "Session complete";
  const resultText = typeof p.result === "string" ? p.result : null;
  return resultText ? `${summary}\n\n${resultText}` : summary;
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

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
