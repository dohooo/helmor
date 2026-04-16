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

/** A model entry returned by listModels. Provider is implicit. */
export interface ProviderModelInfo {
	readonly id: string;
	readonly label: string;
	readonly cliModel: string;
	readonly effortLevels?: readonly string[];
	readonly supportsFastMode?: boolean;
}

/**
 * Normalize a model display label for the UI.
 * - "default" → "Opus 4.6 1M"
 * - "Sonnet (1M context)" → "Sonnet 1M"
 * - "gpt-5.4" → "GPT-5.4"
 * - "gpt-5.1-codex-mini" → "GPT-5.1-Codex-Mini"
 */
export function formatModelLabel(id: string, rawLabel: string): string {
	if (id === "default") return "Opus 4.6 1M";

	let label = rawLabel;

	// "Sonnet (1M context)" → "Sonnet 1M"
	label = label.replace(/\s*\((\d+[A-Za-z]*)\s+context\)/g, " $1");

	// GPT model IDs used as labels: uppercase "gpt" and capitalize after hyphens
	if (label.toLowerCase().startsWith("gpt-")) {
		label = label
			.split("-")
			.map((part, i) =>
				i === 0
					? part.toUpperCase()
					: part.charAt(0).toUpperCase() + part.slice(1),
			)
			.join("-");
	}

	return label;
}

/**
 * Extract a numeric version from a model ID for sorting (e.g. "gpt-5.4" → 5.4).
 * "default" gets Infinity so it sorts first (it's the primary model).
 */
function sortKey(id: string): number {
	if (id === "default") return Infinity;
	const m = id.match(/(\d+(?:\.\d+)?)/);
	return m?.[1] ? Number.parseFloat(m[1]) : 0;
}

/** Sort models by version number descending, then alphabetically. */
export function sortModelsByVersion(
	models: ProviderModelInfo[],
): ProviderModelInfo[] {
	return [...models].sort((a, b) => {
		const va = sortKey(a.id);
		const vb = sortKey(b.id);
		if (vb !== va) return vb - va;
		return a.id.localeCompare(b.id);
	});
}

/** Fallback effort levels when the SDK doesn't provide them. */
export function fallbackEffortLevels(modelId: string): string[] {
	const id = modelId.toLowerCase();
	if (id === "default" || id.includes("opus"))
		return ["low", "medium", "high", "max"];
	return ["low", "medium", "high"];
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

	/** List available models from the provider. */
	listModels(): Promise<readonly ProviderModelInfo[]>;

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
