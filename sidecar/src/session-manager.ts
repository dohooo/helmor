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
	readonly postToolPermissionMode?: string | undefined;
	readonly postToolUseId?: string | undefined;
	readonly permissionMode: string | undefined;
	readonly effortLevel: string | undefined;
}

export interface ListSlashCommandsParams {
	readonly cwd: string | undefined;
	readonly model: string | undefined;
}

/**
 * One slash-command entry exposed to the composer popup. Mirrors the Claude
 * Agent SDK's `SlashCommand` shape so the Claude path is a 1:1 forward, and
 * the Codex path (skill scanner) maps onto the same fields.
 */
export interface SlashCommandInfo {
	readonly name: string;
	readonly description: string;
	readonly argumentHint: string | undefined;
	readonly source: "builtin" | "skill";
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
	 * List the slash commands available for the composer popup. Claude
	 * delegates to the SDK control protocol; Codex walks the documented
	 * skill directories on disk. Both return the same shape so the
	 * frontend doesn't have to branch.
	 */
	listSlashCommands(
		params: ListSlashCommandsParams,
	): Promise<readonly SlashCommandInfo[]>;

	/**
	 * Abort an in-flight session by id. No-op if the session is not active.
	 */
	stopSession(sessionId: string): Promise<void>;

	/**
	 * Tear down every in-flight session this manager owns. Called when the
	 * sidecar is shutting down (parent process is exiting). Implementations
	 * must release SDK resources — Claude's `Query.close()`, Codex's
	 * `AbortController.abort()` — so the underlying CLI children get a
	 * chance to exit on their own before the sidecar is killed.
	 *
	 * Must not throw. Returns when every owned session has been signalled
	 * (not necessarily after the underlying CLIs have actually exited).
	 */
	shutdown(): Promise<void>;
}
