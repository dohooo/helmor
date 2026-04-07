/**
 * Provider-agnostic SessionManager interface. Both
 * `ClaudeSessionManager` and `CodexSessionManager` implement this so
 * the entry point in `index.ts` can dispatch by provider without knowing
 * any SDK-specific details.
 */

import type { SidecarEmitter } from "./emitter.js";

export type Provider = "claude" | "codex";

export interface SendMessageParams {
	readonly sessionId: string;
	readonly prompt: string;
	readonly model: string | undefined;
	readonly cwd: string | undefined;
	readonly resume: string | undefined;
	readonly permissionMode: string | undefined;
	readonly effortLevel: string | undefined;
}

export interface SessionManager {
	/**
	 * Stream a single user turn to the underlying provider SDK and forward
	 * every event back through `emitter`. Resolves when the stream
	 * terminates (end / aborted / error). Implementations must always emit
	 * exactly one terminal event.
	 */
	sendMessage(
		requestId: string,
		params: SendMessageParams,
		emitter: SidecarEmitter,
	): Promise<void>;

	/**
	 * Generate a short session title from the user's first message and
	 * emit exactly one `titleGenerated` event.
	 */
	generateTitle(
		requestId: string,
		userMessage: string,
		emitter: SidecarEmitter,
	): Promise<void>;

	/**
	 * Abort an in-flight session by id. No-op if the session is not active.
	 */
	stopSession(sessionId: string): Promise<void>;
}
