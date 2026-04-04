/**
 * Helmor Sidecar — Claude Agent SDK bridge.
 *
 * Communicates with the Rust backend via stdin/stdout JSON Lines.
 * Each line is a JSON object. Requests flow in via stdin, responses
 * and streaming events flow out via stdout. stderr is used for debug
 * logging only.
 */

import { createInterface } from "node:readline";
import { SessionManager } from "./session-manager.js";

const sessions = new SessionManager();

// Signal readiness
const ready = { type: "ready", version: 1 };
process.stdout.write(JSON.stringify(ready) + "\n");

const rl = createInterface({ input: process.stdin });

for await (const line of rl) {
  if (!line.trim()) continue;

  let request: {
    id: string;
    method: string;
    params: Record<string, unknown>;
  };

  try {
    request = JSON.parse(line);
  } catch {
    emit({ type: "error", message: `Invalid JSON: ${line.slice(0, 100)}` });
    continue;
  }

  const { id, method, params } = request;

  try {
    switch (method) {
      case "sendMessage":
        // Don't await — runs concurrently, streams events via emit()
        sessions
          .sendMessage(
            id,
            params as {
              sessionId: string;
              prompt: string;
              model?: string;
              cwd?: string;
              resume?: string;
              permissionMode?: string;
            },
            emit,
          )
          .catch((err: unknown) => {
            emit({
              id,
              type: "error",
              message: err instanceof Error ? err.message : String(err),
            });
          });
        break;

      case "stopSession":
        await sessions.stopSession(params.sessionId as string);
        emit({ id, type: "stopped", sessionId: params.sessionId });
        break;

      case "ping":
        emit({ id, type: "pong" });
        break;

      default:
        emit({ id, type: "error", message: `Unknown method: ${method}` });
    }
  } catch (err: unknown) {
    emit({
      id,
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

function emit(data: Record<string, unknown>) {
  process.stdout.write(JSON.stringify(data) + "\n");
}
