/**
 * Manages active Claude Agent SDK sessions.
 *
 * Each session wraps a `query()` async generator that stays alive
 * for the session's lifetime. Follow-up messages are sent via
 * the streaming input interface.
 */

import {
	type Query,
	query,
	type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";

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
	 *
	 * Per SDK contract: sessionId and resume are mutually exclusive
	 * unless forkSession is also set. When resuming, we only pass
	 * resume (the SDK resolves the session itself).
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

		// sessionId and resume are mutually exclusive in the SDK contract.
		// When resuming, pass resume so the SDK loads existing context.
		// When starting fresh, let the SDK auto-generate its own session ID
		// — do NOT pass our Helmor UUID as sessionId, because the SDK's
		// internal session store may use a different ID format.
		const sessionOpts: Record<string, unknown> = {};
		if (resume) {
			sessionOpts.resume = resume;
		}
		// For new sessions: no sessionId → SDK generates its own

		const q = query({
			prompt,
			options: {
				abortController,
				cwd: cwd || undefined,
				model: model || undefined,
				...sessionOpts,
				permissionMode:
					(permissionMode as
						| "default"
						| "plan"
						| "bypassPermissions"
						| "acceptEdits"
						| "dontAsk"
						| "auto") || "acceptEdits",
				allowDangerouslySkipPermissions:
					permissionMode === "bypassPermissions" || undefined,
				includePartialMessages: true,
				settingSources: ["user", "project", "local"],
			},
		});

		// Track the session
		this.sessions.set(sessionId, { query: q, abortController });

		try {
			let resolvedSessionId: string | undefined;

			for await (const message of q) {
				// Capture session ID — q.sessionId is an undocumented runtime property;
				// guard access since it's not on the Query type.
				if (!resolvedSessionId) {
					try {
						resolvedSessionId = (q as unknown as { sessionId?: string })
							.sessionId;
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
				resolvedSessionId = (q as unknown as { sessionId?: string }).sessionId;
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
