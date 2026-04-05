/**
 * Manages active Codex SDK sessions.
 *
 * Mirrors the Claude SessionManager pattern: each session wraps a
 * Codex Thread that streams ThreadEvents back to the caller.
 */

import { Codex, type ThreadOptions } from "@openai/codex-sdk";

type EmitFn = (data: Record<string, unknown>) => void;

export class CodexSessionManager {
  private abortControllers = new Map<string, AbortController>();

  /**
   * Send a message in a Codex session.
   * Creates a new thread or resumes an existing one, then streams events.
   */
  async sendMessage(
    requestId: string,
    params: {
      sessionId: string;
      prompt: string;
      model?: string;
      cwd?: string;
      resume?: string;
    },
    emit: EmitFn,
  ): Promise<void> {
    const { sessionId, prompt, model, cwd, resume } = params;

    const abortController = new AbortController();
    this.abortControllers.set(sessionId, abortController);

    try {
      const codex = new Codex();

      // model and workingDirectory belong on ThreadOptions, not TurnOptions
      const threadOpts: ThreadOptions = {
        ...(model ? { model } : {}),
        ...(cwd ? { workingDirectory: cwd } : {}),
      };

      const thread = resume
        ? codex.resumeThread(resume, threadOpts)
        : codex.startThread(threadOpts);

      // runStreamed returns { events: AsyncGenerator<ThreadEvent> }
      const streamedTurn = await thread.runStreamed(prompt, {
        signal: abortController.signal,
      });

      let threadId: string | null = null;

      for await (const event of streamedTurn.events) {
        // Capture thread ID
        if (!threadId) {
          threadId = thread.id;
        }

        // Emit raw Codex events — Rust persistence and frontend parse them
        emit({
          id: requestId,
          ...(event as unknown as Record<string, unknown>),
          ...(threadId ? { sessionId: threadId } : {}),
        });
      }

      // Final thread ID
      threadId = thread.id;

      emit({
        id: requestId,
        type: "end",
        sessionId: threadId ?? sessionId,
      });
    } finally {
      this.abortControllers.delete(sessionId);
    }
  }

  /**
   * Stop an active session.
   */
  async stopSession(sessionId: string): Promise<void> {
    const controller = this.abortControllers.get(sessionId);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(sessionId);
    }
  }
}
