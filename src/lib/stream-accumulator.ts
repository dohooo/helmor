/**
 * Accumulates Claude CLI stream-json lines and produces partial
 * SessionMessageRecord snapshots for real-time rendering.
 */
import type { SessionMessageRecord } from "./conductor";

export class StreamAccumulator {
  private assistantText = "";
  private thinkingText = "";

  addLine(line: string): void {
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      const type = value.type as string | undefined;

      if (type === "stream_event") {
        const event = value.event as Record<string, unknown> | undefined;
        const delta = event?.delta as Record<string, unknown> | undefined;
        if (typeof delta?.text === "string") {
          this.assistantText += delta.text;
        }
        if (typeof delta?.thinking === "string") {
          this.thinkingText += delta.thinking;
        }
        return;
      }

      if (type === "assistant") {
        const message = value.message as Record<string, unknown> | undefined;
        const content = message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            const b = block as Record<string, unknown>;
            if (b.type === "text" && typeof b.text === "string") {
              // Only use if no stream deltas seen yet
              if (!this.assistantText) this.assistantText = b.text;
            }
            if (b.type === "thinking" && typeof b.thinking === "string") {
              if (!this.thinkingText) this.thinkingText = b.thinking;
            }
          }
        }
      }
    } catch {
      // ignore non-JSON lines
    }
  }

  toPartialMessage(contextKey: string, sessionId: string): SessionMessageRecord {
    const hasThinking = this.thinkingText.trim().length > 0;
    const text = this.assistantText.trim() || "...";

    if (hasThinking) {
      const parsed = {
        type: "assistant",
        message: {
          type: "message",
          role: "assistant",
          content: [
            { type: "thinking", thinking: this.thinkingText },
            { type: "text", text },
          ],
        },
      };
      return {
        id: `${contextKey}:stream-assistant`,
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
      id: `${contextKey}:stream-assistant`,
      sessionId,
      role: "assistant",
      content: text,
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
