/**
 * Accumulates Claude CLI stream-json lines and produces partial
 * SessionMessageRecord snapshots for real-time rendering.
 *
 * Collects full assistant/user events (tool calls, tool results, text, thinking)
 * so intermediate steps are visible during streaming.
 */
import type { SessionMessageRecord } from "./conductor";

export class StreamAccumulator {
  /** Collected full message events (assistant + user) for rendering. */
  private collectedMessages: SessionMessageRecord[] = [];
  /** Accumulating text from stream deltas for the current response. */
  private deltaText = "";
  /** Accumulating thinking from stream deltas. */
  private deltaThinking = "";
  private lineCount = 0;

  addLine(line: string): void {
    this.lineCount++;
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      const type = value.type as string | undefined;

      // Stream deltas — accumulate text/thinking for real-time display
      if (type === "stream_event") {
        const event = value.event as Record<string, unknown> | undefined;
        const delta = event?.delta as Record<string, unknown> | undefined;
        if (typeof delta?.text === "string") {
          this.deltaText += delta.text;
        }
        if (typeof delta?.thinking === "string") {
          this.deltaThinking += delta.thinking;
        }
        return;
      }

      // Full assistant message — store as a renderable message
      if (type === "assistant") {
        this.collectedMessages.push(this.jsonToMessage(line, value, "assistant"));
        // Reset deltas when we get a full assistant message
        // (the full message supersedes accumulated deltas)
        this.deltaText = "";
        this.deltaThinking = "";
        return;
      }

      // User message (tool results) — store for rendering
      if (type === "user") {
        this.collectedMessages.push(this.jsonToMessage(line, value, "user"));
        return;
      }

      // System messages (task_started etc.) — skip, adapter filters them anyway
      // Result messages — skip, the done event handles this
    } catch {
      // ignore non-JSON lines
    }
  }

  /**
   * Returns all collected messages plus a trailing partial message
   * from accumulated deltas (if any new text arrived since last full message).
   */
  toMessages(contextKey: string, sessionId: string): SessionMessageRecord[] {
    const messages = [...this.collectedMessages];

    // If we have delta text/thinking not yet covered by a full message, add a partial
    const trimmedText = this.deltaText.trim();
    const trimmedThinking = this.deltaThinking.trim();
    if (trimmedText || trimmedThinking) {
      messages.push(this.buildPartialMessage(contextKey, sessionId, trimmedText, trimmedThinking));
    }

    return messages;
  }

  /** Legacy single-message API — returns just a partial for backward compat. */
  toPartialMessage(contextKey: string, sessionId: string): SessionMessageRecord {
    const messages = this.toMessages(contextKey, sessionId);
    // Return the last message, or a placeholder
    return messages[messages.length - 1] ?? this.buildPartialMessage(contextKey, sessionId, "...", "");
  }

  private jsonToMessage(
    raw: string,
    _parsed: Record<string, unknown>,
    role: string,
  ): SessionMessageRecord {
    const parsed = _parsed;
    return {
      id: `stream:${this.lineCount}:${role}`,
      sessionId: "",
      role,
      content: raw,
      contentIsJson: true,
      parsedContent: parsed,
      createdAt: new Date().toISOString(),
      sentAt: null,
      cancelledAt: null,
      model: null,
      sdkMessageId: null,
      lastAssistantMessageId: null,
      turnId: null,
      isResumableMessage: null,
      attachmentCount: 0,
    };
  }

  private buildPartialMessage(
    contextKey: string,
    sessionId: string,
    text: string,
    thinking: string,
  ): SessionMessageRecord {
    const displayText = text || "...";

    if (thinking) {
      const parsed = {
        type: "assistant",
        message: {
          type: "message",
          role: "assistant",
          content: [
            { type: "thinking", thinking },
            { type: "text", text: displayText },
          ],
        },
      };
      return {
        id: `${contextKey}:stream-partial`,
        sessionId,
        role: "assistant",
        content: JSON.stringify(parsed),
        contentIsJson: true,
        parsedContent: parsed,
        createdAt: new Date().toISOString(),
        sentAt: null,
        cancelledAt: null,
        model: null,
        sdkMessageId: null,
        lastAssistantMessageId: null,
        turnId: null,
        isResumableMessage: null,
        attachmentCount: 0,
      };
    }

    return {
      id: `${contextKey}:stream-partial`,
      sessionId,
      role: "assistant",
      content: displayText,
      contentIsJson: false,
      createdAt: new Date().toISOString(),
      sentAt: null,
      cancelledAt: null,
      model: null,
      sdkMessageId: null,
      lastAssistantMessageId: null,
      turnId: null,
      isResumableMessage: null,
      attachmentCount: 0,
    };
  }
}
