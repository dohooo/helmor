/**
 * Minimal Agent Client Protocol (ACP) type subset used by the Kimi provider.
 *
 * ACP is newline-delimited JSON-RPC 2.0 over stdio (designed by Zed, "LSP for
 * coding agents"). Kimi Code CLI speaks it via `kimi acp`. We hand-roll the
 * client (mirroring `codex-app-server.ts`) against the stable wire protocol
 * version 1 rather than depend on the churning `@agentclientprotocol/sdk`.
 *
 * Only the shapes Helmor actually reads are typed here; everything else is
 * forwarded verbatim. Field names are camelCase to match the wire.
 */

/** The ACP wire protocol version Helmor speaks. Sent in `initialize`. */
export const ACP_PROTOCOL_VERSION = 1;

/** `initialize` result — capability + auth advertisement. */
export interface AcpInitializeResult {
	readonly protocolVersion?: number;
	readonly agentCapabilities?: {
		readonly loadSession?: boolean;
		readonly promptCapabilities?: {
			readonly image?: boolean;
			readonly audio?: boolean;
			readonly embeddedContext?: boolean;
		};
		readonly sessionCapabilities?: {
			readonly resume?: unknown;
			readonly list?: unknown;
		};
	};
	readonly authMethods?: readonly AcpAuthMethod[];
	readonly agentInfo?: { readonly name?: string; readonly version?: string };
}

export interface AcpAuthMethod {
	readonly id: string;
	readonly name?: string;
	readonly description?: string;
}

/** A single content block in a prompt or an update chunk. */
export type AcpContentBlock =
	| { readonly type: "text"; readonly text: string }
	| {
			readonly type: "image";
			readonly data: string;
			readonly mimeType: string;
			readonly uri?: string;
	  }
	| { readonly type: string; readonly [key: string]: unknown };

/** `session/new` / `session/load` result. */
export interface AcpNewSessionResult {
	readonly sessionId: string;
	readonly models?: {
		readonly availableModels?: ReadonlyArray<{
			readonly modelId: string;
			readonly name?: string;
			readonly description?: string;
		}>;
		readonly currentModelId?: string;
	};
}

/** `session/prompt` result — how a turn ends. */
export interface AcpPromptResult {
	readonly stopReason: string;
}

/** A `session/update` notification payload (`params`). */
export interface AcpSessionNotification {
	readonly sessionId: string;
	readonly update: AcpSessionUpdate;
}

/** Discriminated by `sessionUpdate`. Only fields we read are typed.
 *  `content` is a single block on message/thought chunks but a
 *  `ToolCallContent[]` on tool calls — kept `unknown`, narrowed at use. */
export interface AcpSessionUpdate {
	readonly sessionUpdate: string;
	readonly content?: unknown;
	// tool_call / tool_call_update
	readonly toolCallId?: string;
	readonly title?: string;
	readonly kind?: string;
	readonly status?: string;
	readonly rawInput?: unknown;
	readonly rawOutput?: unknown;
	// plan
	readonly entries?: ReadonlyArray<{
		readonly content?: string;
		readonly priority?: string;
		readonly status?: string;
	}>;
	// available_commands_update
	readonly availableCommands?: ReadonlyArray<{
		readonly name?: string;
		readonly description?: string;
		readonly input?: unknown;
	}>;
	readonly [key: string]: unknown;
}

/** `session/request_permission` request params (agent → client). */
export interface AcpRequestPermissionParams {
	readonly sessionId: string;
	readonly toolCall?: {
		readonly toolCallId?: string;
		readonly title?: string;
		readonly kind?: string;
		readonly rawInput?: unknown;
		readonly content?: unknown;
		readonly [key: string]: unknown;
	};
	readonly options: readonly AcpPermissionOption[];
}

export interface AcpPermissionOption {
	readonly optionId: string;
	readonly name?: string;
	/** allow_once | allow_always | reject_once | reject_always */
	readonly kind?: string;
}

/** `fs/read_text_file` request params (agent → client). */
export interface AcpReadTextFileParams {
	readonly sessionId: string;
	readonly path: string;
	readonly line?: number;
	readonly limit?: number;
}

/** `fs/write_text_file` request params (agent → client). */
export interface AcpWriteTextFileParams {
	readonly sessionId: string;
	readonly path: string;
	readonly content: string;
}
