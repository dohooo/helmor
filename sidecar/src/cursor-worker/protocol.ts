/** Wire protocol between the Bun sidecar (proxy) and the Node cursor worker.
 *
 * Cursor's `@cursor/sdk` runs its agent loop + HTTP/2 transport in-process.
 * Bun's HTTP/2 client throws `NGHTTP2_FRAME_SIZE_ERROR` on the larger frames
 * Cursor sends inside a git repo, which silently breaks every tool call. Node
 * does not have this bug, so we run the SDK in a Node child process and bridge
 * it over stdin/stdout JSON Lines. See `cursor-session-manager.ts` (proxy) and
 * `worker.ts` (Node entry). */

import type {
	GenerateTitleOptions,
	ListSlashCommandsParams,
	ProviderModelInfo,
	SendMessageParams,
	SlashCommandInfo,
} from "../session-manager.js";

// --- proxy → worker -------------------------------------------------------

export type ToWorker =
	| { t: "setApiKey"; apiKey: string | null }
	| { t: "send"; requestId: string; params: SendMessageParams }
	| {
			t: "title";
			rpcId: string;
			requestId: string;
			userMessage: string;
			branchRenamePrompt: string | null;
			timeoutMs?: number;
			options?: GenerateTitleOptions;
	  }
	| { t: "slash"; rpcId: string; params: ListSlashCommandsParams }
	| { t: "models"; rpcId: string; opts?: { apiKey?: string } }
	| { t: "stop"; sessionId: string }
	| { t: "shutdown" };

// --- worker → proxy -------------------------------------------------------

/** One emitter call to replay on the real `SidecarEmitter`. Only the subset
 * the cursor SDK logic actually emits is carried over the wire. */
export type EmitMsg =
	| {
			m: "error";
			requestId: string | null;
			message: string;
			internal?: boolean;
	  }
	| { m: "end"; requestId: string }
	| { m: "aborted"; requestId: string; reason: string }
	| { m: "passthrough"; requestId: string; message: object }
	| {
			m: "planCaptured";
			requestId: string;
			toolUseId: string;
			plan: string | null;
	  }
	| {
			m: "titleGenerated";
			requestId: string;
			title: string;
			branchName: string | undefined;
	  };

export type FromWorker =
	| { t: "ready" }
	| { t: "emit"; e: EmitMsg }
	/** Resolves the proxy's `sendMessage(requestId)` promise. */
	| { t: "sendDone"; requestId: string }
	| {
			t: "rpcOk";
			rpcId: string;
			value: SlashCommandInfo[] | ProviderModelInfo[];
	  }
	| { t: "rpcErr"; rpcId: string; message: string }
	| { t: "log"; level: "debug" | "info" | "error"; message: string };
