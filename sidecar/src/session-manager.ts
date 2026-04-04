/**
 * Manages active Claude Agent SDK sessions.
 *
 * Each session wraps a `query()` async generator that stays alive
 * for the session's lifetime. Follow-up messages are sent via
 * the streaming input interface.
 */

import { query, type Query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

type EmitFn = (data: Record<string, unknown>) => void;

interface LiveSession {
  query: Query;
  abortController: AbortController;
}

export class SessionManager {
  private sessions = new Map<string, LiveSession>();

  /**
   * Send a message in a session.
   * If resuming, uses the SDK's resume option to restore context.
   * Streams all SDK messages to the caller via emit().
   */
  async sendMessage(
    requestId: string,
    params: {
      sessionId: string;
      prompt: string;
      model?: string;
      cwd?: string;
      resume?: string;
      permissionMode?: string;
    },
    emit: EmitFn,
  ): Promise<void> {
    const { sessionId, prompt, model, cwd, resume, permissionMode } = params;

    const abortController = new AbortController();

    const q = query({
      prompt,
      options: {
        abortController,
        cwd: cwd || undefined,
        model: model || undefined,
        resume: resume || undefined,
        sessionId,
        permissionMode: (permissionMode as "default" | "plan" | "bypassPermissions" | "acceptEdits" | "dontAsk" | "auto") || "acceptEdits",
        allowDangerouslySkipPermissions: permissionMode === "bypassPermissions" || undefined,
        includePartialMessages: true,
        settingSources: ["user", "project", "local"],
      },
    });

    // Track the session
    this.sessions.set(sessionId, { query: q, abortController });

    try {
      let resolvedSessionId: string | undefined;

      for await (const message of q) {
        // Capture session ID from init message
        if (!resolvedSessionId) {
          try {
            resolvedSessionId = q.sessionId;
          } catch {
            // Not yet initialized
          }
        }

        emit({
          id: requestId,
          ...serializeMessage(message),
          ...(resolvedSessionId ? { sessionId: resolvedSessionId } : {}),
        });
      }

      // Final session ID
      try {
        resolvedSessionId = q.sessionId;
      } catch {
        // Ignore
      }

      emit({
        id: requestId,
        type: "end",
        sessionId: resolvedSessionId ?? sessionId,
      });
    } finally {
      this.sessions.delete(sessionId);
    }
  }

  /**
   * Stop an active session.
   */
  async stopSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.abortController.abort();
      this.sessions.delete(sessionId);
    }
  }
}

/**
 * Convert an SDK message to a plain serializable object.
 */
function serializeMessage(message: SDKMessage): Record<string, unknown> {
  // SDKMessage is already a plain object from the SDK
  if (typeof message === "object" && message !== null) {
    return message as unknown as Record<string, unknown>;
  }
  return { type: "unknown", raw: String(message) };
}
