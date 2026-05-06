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
	readonly fastMode: boolean | undefined;
	readonly claudeEnvironment?: Readonly<Record<string, string>>;
	/**
	 * Extra directories the user linked via `/add-dir`. Passed to Claude as
	 * `additionalDirectories`; merged into Codex's per-turn `sandboxPolicy`
	 * writable roots when the session is in plan mode. Absent for sessions
	 * with no linked dirs so callers don't need to hand-populate empty
	 * arrays everywhere.
	 */
	readonly additionalDirectories?: readonly string[];
	/**
	 * Structured image attachment paths from the composer. The single
	 * source of truth for which `@<path>` substrings inside `prompt`
	 * should be lifted out as image attachments. Paths may contain
	 * whitespace (macOS Finder drops); never re-derive this list from
	 * the prompt text. Always present — empty array means "no
	 * attachments".
	 */
	readonly images: readonly string[];
}

export interface ListSlashCommandsParams {
	readonly cwd: string | undefined;
	readonly additionalDirectories?: readonly string[];
}

/**
 * Ad-hoc context-usage query for the hover popover. `providerSessionId`
 * is the SDK's own session id (what `resume:` takes) — used when no live
 * `Query` is held for this helmor session. `model` is the composer's
 * current model id; `cwd` lets the transient query load project settings.
 */
export interface GetContextUsageParams {
	readonly helmorSessionId: string;
	readonly providerSessionId: string | null;
	readonly model: string;
	readonly cwd: string | undefined;
}

export interface GenerateTitleOptions {
	readonly model?: string;
	readonly claudeEnvironment?: Readonly<Record<string, string>>;
	/** When false, only the title is requested — branch generation is omitted
	 * from the prompt entirely (saves tokens for local-mode workspaces and
	 * any other case where the caller has no intent to rename a branch). */
	readonly generateBranch?: boolean;
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

/** A model entry returned by listModels. Provider is implicit. */
export interface ProviderModelInfo {
	readonly id: string;
	readonly label: string;
	readonly cliModel: string;
	readonly effortLevels?: readonly string[];
	readonly supportsFastMode?: boolean;
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
		branchRenamePrompt: string | null,
		emitter: SidecarEmitter,
		timeoutMs?: number,
		options?: GenerateTitleOptions,
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

	/** List available models from the provider. */
	listModels(): Promise<readonly ProviderModelInfo[]>;

	/**
	 * Abort an in-flight session by id. No-op if the session is not active.
	 */
	stopSession(sessionId: string): Promise<void>;

	/**
	 * Inject an additional user message into an in-flight turn (real
	 * mid-turn steer). Returns `true` when the input was delivered to
	 * the provider, `false` when no active turn exists for `sessionId`.
	 * Implementations MUST confirm provider acceptance before emitting
	 * any pipeline event — a failed steer must not pollute the stream.
	 * Throws on SDK-level rejection.
	 */
	steer(
		sessionId: string,
		prompt: string,
		files: readonly string[],
		images: readonly string[],
	): Promise<boolean>;

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
