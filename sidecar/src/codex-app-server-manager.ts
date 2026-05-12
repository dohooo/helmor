/**
 * SessionManager backed by the Codex App Server (JSON-RPC over stdin/stdout).
 *
 * Each Helmor session maps to one `codex app-server` child process.
 * Events are stripped of their JSON-RPC envelope and forwarded as flat
 * JSON via `emitter.passthrough()`. All semantic normalization (camelCase,
 * delta accumulation) happens downstream in Rust.
 */

import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
	CodexAppServer,
	type JsonRpcNotification,
	type JsonRpcRequest,
} from "./codex-app-server.js";
import { ensureCodexGoalsFeatureEnabled } from "./codex-config.js";
import { SubAgentTracker } from "./codex-subagent-tracker.js";
import { buildCodexStoredMeta } from "./context-usage.js";
import type { SidecarEmitter } from "./emitter.js";
import { resolveGitAccessDirectories } from "./git-access.js";
import { parseImageRefs } from "./images.js";
import { prependLinkedDirectoriesContext } from "./linked-directories-context.js";
import { errorDetails, logger } from "./logger.js";
import {
	listProviderModels,
	modelSupportsFastMode,
	pickFastestCodexModel,
} from "./model-catalog.js";
import type {
	GenerateTitleOptions,
	ListSlashCommandsParams,
	ProviderModelInfo,
	SendMessageParams,
	SessionManager,
	SlashCommandInfo,
	UserInputResolution,
} from "./session-manager.js";
import {
	buildTitlePrompt,
	parseTitleAndBranch,
	TITLE_GENERATION_TIMEOUT_MS,
} from "./title.js";

/**
 * Resolve the path to the Codex native binary, used as the spawn target for
 * every `codex app-server` child process.
 *
 * Resolution order:
 *   1. `HELMOR_CODEX_BIN_PATH` — set by the Tauri host in release builds,
 *      pointing at `Helmor.app/Contents/Resources/vendor/codex/codex`.
 *   2. `createRequire` lookup of the platform sub-package's binary inside
 *      `node_modules`. Used in dev (`bun run src/index.ts`) and `bun test`.
 *   3. Fall back to `"codex"` so the OS resolves it from PATH — last-resort
 *      for unusual setups; surfaces as ENOENT if not installed.
 */
function resolveCodexBinPath(): string {
	const override = process.env.HELMOR_CODEX_BIN_PATH;
	if (override) {
		return override;
	}
	const triple = codexTargetTriple();
	if (triple) {
		const platformPkg = `@openai/codex-${platformShort()}`;
		try {
			const require = createRequire(import.meta.url);
			const pkgJson = require.resolve(`${platformPkg}/package.json`);
			const candidate = join(
				dirname(pkgJson),
				"vendor",
				triple,
				"codex",
				process.platform === "win32" ? "codex.exe" : "codex",
			);
			if (existsSync(candidate)) {
				return candidate;
			}
		} catch {
			// Platform sub-package missing (e.g. --omit=optional) — fall through.
		}
	}
	return "codex";
}

function platformShort(): string {
	const arch = process.arch === "x64" ? "x64" : "arm64";
	if (process.platform === "darwin") return `darwin-${arch}`;
	if (process.platform === "linux") return `linux-${arch}`;
	if (process.platform === "win32") return `win32-${arch}`;
	return "";
}

function codexTargetTriple(): string | null {
	const arch = process.arch;
	if (process.platform === "darwin") {
		return arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
	}
	if (process.platform === "linux") {
		return arch === "arm64"
			? "aarch64-unknown-linux-musl"
			: "x86_64-unknown-linux-musl";
	}
	if (process.platform === "win32") {
		return arch === "arm64"
			? "aarch64-pc-windows-msvc"
			: "x86_64-pc-windows-msvc";
	}
	return null;
}

const CODEX_BIN_PATH = resolveCodexBinPath();

/**
 * Recognised `/goal` slash-command shapes. `set` carries the objective;
 * `resume` exists so the user can recover an active goal after a pause
 * by typing `/goal resume`. We deliberately route `resume` through the
 * sendMessage path (rather than `mutateCodexGoal`) — the resulting
 * stream subscription is what catches the goal-continuation turn that
 * codex auto-spawns, otherwise those events fire into a dead handler.
 *
 * Pause / Clear are NOT here on purpose: they live on banner / Composer
 * Stop and go through `mutateCodexGoal` so they don't show up as user
 * messages in the chat.
 */
export type GoalCommand =
	| { kind: "set"; objective: string }
	| { kind: "resume" };

export function parseGoalCommand(prompt: string): GoalCommand | null {
	const m = prompt.trim().match(/^\/goal(?:\s+([\s\S]+))?$/);
	if (!m) return null;
	const arg = (m[1] ?? "").trim();
	if (arg === "") return null;
	if (arg === "resume") return { kind: "resume" };
	return { kind: "set", objective: arg };
}

function dispatchGoalCommand(
	server: CodexAppServer,
	threadId: string,
	cmd: GoalCommand,
): { method: string; promise: Promise<unknown> } {
	if (cmd.kind === "resume") {
		return {
			method: "thread/goal/set",
			promise: server.sendRequest(
				"thread/goal/set",
				{ threadId, status: "active" },
				20_000,
			),
		};
	}
	return {
		method: "thread/goal/set",
		promise: server.sendRequest(
			"thread/goal/set",
			{ threadId, objective: cmd.objective },
			20_000,
		),
	};
}

/** How long after a "Reconnecting…" stderr line we keep emitting
 *  synthetic heartbeats while Codex owns its retry loop. */
const RETRY_SUPPRESSION_MS = 30_000;
const RETRY_NOTICE_DEDUPE_MS = 1_000;

const HELMOR_CLIENT_INFO = {
	clientInfo: {
		name: "helmor_desktop",
		title: "Helmor Desktop",
		version: "0.1.0",
	},
	capabilities: { experimentalApi: true },
} as const;

// Recoverable thread resume errors — fall back to thread/start.
const RECOVERABLE_RESUME_SNIPPETS = [
	"not found",
	"missing thread",
	"no such thread",
	"unknown thread",
	"does not exist",
];

function isRecoverableResumeError(err: unknown): boolean {
	const msg =
		err instanceof Error
			? err.message.toLowerCase()
			: String(err).toLowerCase();
	return RECOVERABLE_RESUME_SNIPPETS.some((s) => msg.includes(s));
}

function reconnectSuffix(message: string): string | null {
	const trimmed = message.trimStart();
	const prefix = trimmed.startsWith("Reconnecting...")
		? "Reconnecting..."
		: trimmed.startsWith("Reconnecting…")
			? "Reconnecting…"
			: null;
	if (!prefix) return null;

	return trimmed.slice(prefix.length).trimStart();
}

function isLegacyReconnectNotice(message: string): boolean {
	const suffix = reconnectSuffix(message);
	return suffix !== null && (suffix === "" || /^\d+\s*\/\s*\d+/.test(suffix));
}

function parseReconnectCounts(message: string): {
	attempt: number;
	max: number;
} {
	const suffix = reconnectSuffix(message);
	const match = suffix?.match(/^(\d+)\s*\/\s*(\d+)/);
	return {
		attempt: match ? Number(match[1]) : 0,
		max: match ? Number(match[2]) : 0,
	};
}

// ---------------------------------------------------------------------------
// Per-session context
// ---------------------------------------------------------------------------

interface PendingApproval {
	jsonRpcId: string | number;
	sessionId: string;
}

/**
 * A parked Codex server-initiated user-input request. Two flavors map
 * onto the same unified `userInputRequest` wire event but require
 * different response shapes when we send the user's answer back to
 * Codex's app-server:
 *
 * - `codex-form` (`item/tool/requestUserInput`): Codex's own
 *   user-input mechanism. Response shape is `{ answers: { id: { answers:
 *   [value] } } }`. Built from `questions[]` we kept around.
 * - `mcp-elicitation` (`mcpServer/elicitation/request`): Codex
 *   forwarding an MCP server's elicitation request. Response shape is
 *   `{ action, content, _meta }` matching the MCP elicitation spec.
 */
type PendingUserInput =
	| {
			kind: "codex-form";
			jsonRpcId: string | number;
			sessionId: string;
			/** Original Codex question array — needed to reverse-map the
			 *  unified form-content response back into Codex's
			 *  `{ id: { answers: [value] } }` shape. */
			questions: CodexQuestion[];
	  }
	| {
			kind: "mcp-elicitation";
			jsonRpcId: string | number;
			sessionId: string;
	  };

interface CodexQuestion {
	id?: string;
	header?: string;
	question?: string;
	isOther?: boolean;
	options?: Array<{ label?: string; description?: string }>;
}

/**
 * Build a JSON Schema from Codex's `requestUserInput` questions so the
 * unified `UserInputPanel` can render them as form fields. Mirrors the
 * shape the existing Rust bridge used to produce — moved into the
 * sidecar so Rust can stay generic about user-input semantics.
 */
function buildCodexUserInputSchema(
	questions: CodexQuestion[],
): Record<string, unknown> {
	const properties: Record<string, unknown> = {};
	const required: string[] = [];

	questions.forEach((q, i) => {
		const key = q.id ?? `q${i}`;
		required.push(key);
		const header = q.header ?? "";
		const questionText = q.question ?? "Question";
		const title = header || questionText;
		const description = header ? questionText : "";
		const options = Array.isArray(q.options) ? q.options : [];
		const hasOptions = options.length > 0;

		const oneOf = hasOptions
			? options.map((opt) => ({
					const: opt.label ?? "",
					title: opt.label ?? "",
					description: opt.description ?? "",
				}))
			: [
					{ const: "yes", title: "Yes" },
					{ const: "no", title: "No" },
				];

		const prop: Record<string, unknown> = hasOptions
			? {
					type: "string",
					title,
					description,
					oneOf,
				}
			: q.isOther
				? { type: "string", title, description }
				: { type: "string", title, description, oneOf };
		if (q.isOther) {
			prop["x-allow-other"] = true;
		}
		properties[key] = prop;
	});

	return { type: "object", properties, required };
}

/**
 * Reverse `buildCodexUserInputSchema`: take the unified form content
 * (`{ q0: "Option A", ... }`) and produce Codex's expected answer
 * shape (`{ q0: { answers: ["Option A"] }, ... }`).
 */
function buildCodexAnswers(
	content: Record<string, unknown>,
): Record<string, { answers: string[] }> {
	const answers: Record<string, { answers: string[] }> = {};
	for (const [key, value] of Object.entries(content)) {
		if (typeof value === "string") {
			answers[key] = { answers: [value] };
		} else if (Array.isArray(value)) {
			answers[key] = {
				answers: value.filter((v): v is string => typeof v === "string"),
			};
		}
	}
	return answers;
}

interface AppServerContext {
	server: CodexAppServer;
	providerThreadId: string | null;
	activeTurnId: string | null;
	turnResolve: (() => void) | null;
	turnReject: ((err: Error) => void) | null;
	/** Request id for the currently streaming sendMessage invocation —
	 *  used by `steer()` to route a synthetic user passthrough event into
	 *  the right Channel so the pipeline renders the steer bubble at the
	 *  correct streaming position (not at the tail). */
	activeRequestId: string | null;
	/** Emitter owning the active stream — `steer()` uses it to fan a
	 *  synthetic `user` passthrough alongside the RPC. */
	activeEmitter: SidecarEmitter | null;
	/** When non-null, BOTH `handleNotification` and `handleRequest` await
	 *  this promise before dispatching. `steer()` installs one for the
	 *  duration of the `turn/steer` RPC so any post-steer deltas OR
	 *  server-initiated tool/user-input requests that arrive before the
	 *  RPC reply are queued at the dispatch boundary and don't reach
	 *  the frontend pipeline/UI until after the synthetic user_prompt
	 *  event lands. Microtask FIFO preserves their relative ordering. */
	notificationGate: Promise<void> | null;
	/** Last send's model id; Codex usage notifications omit it. */
	lastSentModel: string;
	/** Wall-clock ms of the most recent "Reconnecting…" line on the
	 *  Codex child process's stderr. Used to suppress the transient
	 *  {method:"error"} notifications that Codex emits during its own
	 *  SSE retry loop — Codex will recover on its own, so terminating
	 *  the turn would be premature. */
	lastRetryAt: number | null;
	/** Last reconnect notice forwarded to the pipeline. Dedupe stderr +
	 *  JSON-RPC echoes so the user sees liveness without duplicate rows. */
	lastRetryNotice: { key: string; at: number } | null;
	/** Tracks sub-agent thread metadata (nickname, role) so we can enrich
	 *  `collabAgentToolCall(spawnAgent)` items before forwarding them. */
	subAgentTracker: SubAgentTracker;
}

// ---------------------------------------------------------------------------
// Approval request methods
// ---------------------------------------------------------------------------

const APPROVAL_METHODS = new Set([
	"item/commandExecution/requestApproval",
	"item/fileChange/requestApproval",
	"item/fileRead/requestApproval",
]);

/** Map Codex approval method → Claude-compatible toolName for the frontend. */
function approvalToolName(method: string): string {
	switch (method) {
		case "item/commandExecution/requestApproval":
			return "Bash";
		case "item/fileChange/requestApproval":
			return "apply_patch";
		case "item/fileRead/requestApproval":
			return "Read";
		default:
			return method;
	}
}

/** Extract a human-readable description from approval params. */
function approvalDescription(
	method: string,
	params: Record<string, unknown>,
): string {
	if (method === "item/commandExecution/requestApproval") {
		return typeof params.command === "string" ? params.command : "Run command";
	}
	if (method === "item/fileChange/requestApproval") {
		return typeof params.reason === "string"
			? params.reason
			: "Apply file changes";
	}
	if (method === "item/fileRead/requestApproval") {
		return typeof params.reason === "string" ? params.reason : "Read file";
	}
	return "";
}

/** Build toolInput from approval params — mirrors Claude's permissionRequest shape. */
function approvalToolInput(
	method: string,
	params: Record<string, unknown>,
): Record<string, unknown> {
	if (method === "item/commandExecution/requestApproval") {
		return { command: params.command ?? "" };
	}
	return { ...params };
}

// ---------------------------------------------------------------------------
// CodexAppServerManager
// ---------------------------------------------------------------------------

export class CodexAppServerManager implements SessionManager {
	private sessions = new Map<string, AppServerContext>();
	private pendingApprovals = new Map<string, PendingApproval>();
	private pendingUserInputs = new Map<string, PendingUserInput>();

	/** Called by index.ts when frontend responds to a permission prompt. */
	resolvePermission(permissionId: string, behavior: "allow" | "deny"): void {
		const pending = this.pendingApprovals.get(permissionId);
		if (!pending) return;
		this.pendingApprovals.delete(permissionId);

		const ctx = this.sessions.get(pending.sessionId);
		if (!ctx) return;

		const decision = behavior === "allow" ? "accept" : "decline";
		ctx.server.sendResponse(pending.jsonRpcId, { decision });
		logger.debug(`Codex approval resolved`, { permissionId, decision });
	}

	/**
	 * Called by index.ts when the frontend responds to a unified
	 * `userInputRequest`. The response shape Codex expects depends on
	 * which server-initiated request the entry was parked for:
	 *
	 * - `codex-form` (`item/tool/requestUserInput`): wrap the content
	 *   into `{ answers: { id: { answers: [value] } } }`. Cancel /
	 *   decline flush an empty answer set so Codex unwedges its turn.
	 * - `mcp-elicitation` (`mcpServer/elicitation/request`): reply with
	 *   `{ action, content, _meta }` per the MCP elicitation spec.
	 *   `submit` → `accept`; otherwise pass `decline` / `cancel` and
	 *   `null` content so the MCP server stops waiting.
	 */
	resolveUserInput(
		userInputId: string,
		resolution: UserInputResolution,
	): boolean {
		const pending = this.pendingUserInputs.get(userInputId);
		if (!pending) return false;
		this.pendingUserInputs.delete(userInputId);

		const ctx = this.sessions.get(pending.sessionId);
		if (!ctx) return false;

		if (pending.kind === "mcp-elicitation") {
			const action =
				resolution.action === "submit"
					? "accept"
					: resolution.action === "decline"
						? "decline"
						: "cancel";
			ctx.server.sendResponse(pending.jsonRpcId, {
				action,
				content:
					resolution.action === "submit" ? (resolution.content ?? null) : null,
				_meta: null,
			});
		} else {
			const answers =
				resolution.action === "submit"
					? buildCodexAnswers(resolution.content)
					: {};
			ctx.server.sendResponse(pending.jsonRpcId, { answers });
		}
		logger.debug(`Codex user-input resolved`, {
			userInputId,
			kind: pending.kind,
			action: resolution.action,
		});
		return true;
	}

	// ── sendMessage ──────────────────────────────────────────────────────

	async sendMessage(
		requestId: string,
		params: SendMessageParams,
		emitter: SidecarEmitter,
	): Promise<void> {
		const {
			sessionId,
			prompt,
			model,
			cwd,
			resume,
			effortLevel,
			permissionMode,
			fastMode,
			additionalDirectories,
			images,
		} = params;
		const workDir = cwd ?? process.cwd();
		const effectiveFastMode =
			fastMode === true && modelSupportsFastMode("codex", model);
		const resolvedAdditionalDirectories = await mergeAdditionalDirectories(
			workDir,
			additionalDirectories,
		);

		logger.debug(`[${requestId}] codex sendMessage`, {
			sessionId,
			model: model ?? "(default)",
			cwd: workDir,
			resume: resume ?? "(none)",
			promptLen: prompt.length,
		});

		// `/goal` needs `[features] goals = true` in `~/.codex/config.toml`.
		// Codex reads its config once at startup, so the pre-flight runs
		// before `ensureContext` and recycles any stale process.
		const goalCommand = parseGoalCommand(prompt);
		let effectiveResume = resume;
		if (goalCommand) {
			effectiveResume = await this.ensureCodexGoalsReady(
				sessionId,
				effectiveResume,
			);
		}

		const ctx = await this.ensureContext(
			sessionId,
			workDir,
			effectiveResume,
			model,
			permissionMode,
			effectiveFastMode,
		);
		// Codex usage notifications do not include a model id.
		if (model) ctx.lastSentModel = model;

		// Codex, unlike Claude, has no `additionalDirectoriesForClaudeMd`
		// equivalent — `sandboxPolicy.writableRoots` only grants write
		// permission, it doesn't tell the agent "these paths are part of
		// your working context". To close that gap we prepend a small
		// context preamble to the user's prompt when there are linked
		// directories, so Codex knows it can reach into them without the
		// user re-stating paths every turn. Claude doesn't need this
		// because `--add-dir` covers both facets in the CLI.
		const promptWithContext = prependLinkedDirectoriesContext(
			prompt,
			resolvedAdditionalDirectories,
		);
		const isCompactCommand = !goalCommand && prompt.trim() === "/compact";
		const input = buildTurnInput(promptWithContext, images);
		const turnStartParams: Record<string, unknown> = {
			threadId: ctx.providerThreadId,
			input,
		};
		if (model) turnStartParams.model = model;
		if (effortLevel) turnStartParams.effort = effortLevel;
		if (effectiveFastMode) turnStartParams.serviceTier = "fast";
		const codexMode = toCodexCollaborationMode(permissionMode, model);
		if (codexMode) turnStartParams.collaborationMode = codexMode;
		const codexApproval = toCodexApprovalPolicy(permissionMode);
		if (codexApproval) turnStartParams.approvalPolicy = codexApproval;
		// Always send an explicit per-turn sandbox policy. Codex applies
		// turn-level overrides as the new default for later turns on the
		// thread, which lets us switch cleanly between plan mode
		// (`workspaceWrite`) and normal execution (`dangerFullAccess`)
		// without reopening the thread.
		const sandboxPolicy = buildTurnSandboxPolicy(
			permissionMode,
			workDir,
			resolvedAdditionalDirectories,
		);
		turnStartParams.sandboxPolicy = sandboxPolicy;

		let aborted = false;

		// Stash the active stream's routing info so `steer()` can fire a
		// synthetic user passthrough on the correct request id / emitter.
		ctx.activeRequestId = requestId;
		ctx.activeEmitter = emitter;

		return new Promise<void>((resolve, reject) => {
			ctx.turnResolve = resolve;
			ctx.turnReject = (err) => {
				aborted = true;
				reject(err);
			};

			const emit = (event: object) => {
				emitter.passthrough(requestId, event);
			};

			const handleNotification = async (n: JsonRpcNotification) => {
				// Steer gate: if `steer()` is mid-RPC, hold this
				// notification until the RPC resolves and the synthetic
				// user_prompt event has been emitted. JS microtask FIFO
				// keeps concurrent notifications in their arrival order,
				// and the gate guarantees they all land AFTER the
				// synthetic event — fixes the delta-before-RPC-reply race
				// flagged in review.
				if (ctx.notificationGate) {
					await ctx.notificationGate;
				}

				// Codex sends errors as {method:"error", params:{error:{message:"..."}}}
				// Extract the nested message and emit a proper error event.
				if (n.method === "error") {
					const errObj = deepGet(n.params, "error");
					const nested =
						typeof errObj === "object" && errObj !== null
							? (errObj as Record<string, unknown>).message
							: undefined;
					const msg =
						typeof nested === "string" ? nested : "Unknown Codex error";
					// App-server protocol marks retryable stream errors with
					// params.willRetry=true. Older builds omit the structured bit,
					// so only suppress their explicit reconnect progress messages.
					// A recent stderr reconnect line is liveness context, not proof
					// that an arbitrary later error is retryable.
					const willRetry = deepGet(n.params, "willRetry");
					const lastRetry = ctx.lastRetryAt ?? 0;
					const suppressForProtocolRetry = willRetry === true;
					const suppressForLegacyRetryWindow =
						typeof willRetry !== "boolean" &&
						Date.now() - lastRetry < RETRY_SUPPRESSION_MS &&
						isLegacyReconnectNotice(msg);
					if (suppressForProtocolRetry || suppressForLegacyRetryWindow) {
						emitRetryNotice(ctx, requestId, msg);
						logger.info(
							"suppressing retryable Codex error; awaiting recovery",
							{
								requestId,
								msg,
								willRetry,
								msSinceRetry: Date.now() - lastRetry,
							},
						);
						return;
					}
					emitter.error(requestId, msg);
					ctx.activeTurnId = null;
					ctx.turnResolve?.();
					ctx.turnResolve = null;
					ctx.turnReject = null;
					return;
				}

				// Route by threadId. Codex multiplexes parent + sub-agent on
				// the same stdio stream; without this filter the sub-agent's
				// turn/started would clobber `activeTurnId` and its items
				// would pollute the parent turn's accumulator.
				const eventThreadId = extractEventThreadId(n);
				const isSubAgentEvent =
					eventThreadId !== null &&
					ctx.providerThreadId !== null &&
					eventThreadId !== ctx.providerThreadId;

				if (isSubAgentEvent) {
					// Tracker is idempotent + caches in-flight; safe to fire
					// for every sub-agent event so we register no matter
					// which method (thread/started, status/changed, …) is
					// the sub-agent's first signal.
					void ctx.subAgentTracker.noteSpawned(eventThreadId);
					return;
				}

				// Block briefly (≤2s) on any collab item with known receivers
				// so nickname/role enrichment lands before the pipeline sees
				// it. Without this, wait/sendInput/etc. render with pool
				// fallback nicknames that don't match what spawn showed.
				if (
					(n.method === "item/started" || n.method === "item/completed") &&
					shouldEnrichCollabItem(n.params)
				) {
					await enrichCollabItem(ctx.subAgentTracker, n);
				}

				const flat = flattenNotification(n, ctx.providerThreadId);
				emit(flat);

				if (n.method === "thread/started") {
					// Only the first thread/started locks providerThreadId.
					if (!ctx.providerThreadId) {
						const threadId = deepGet(n.params, "thread", "id");
						if (typeof threadId === "string") {
							ctx.providerThreadId = threadId;
						}
					}
				}

				if (n.method === "turn/started") {
					// Defensive: older Codex builds may omit threadId.
					if (
						eventThreadId === null ||
						eventThreadId === ctx.providerThreadId
					) {
						const turnId = deepGet(n.params, "turn", "id");
						if (typeof turnId === "string") {
							ctx.activeTurnId = turnId;
						}
					}
				}

				// Forward Codex goal state changes so the panel header banner
				// can render the active goal. `thread/goal/updated` carries
				// the full ThreadGoal payload; `thread/goal/cleared` flips it
				// off (we send a null goal in the same event type).
				if (n.method === "thread/goal/updated") {
					const goal = deepGet(n.params, "goal");
					if (goal && typeof goal === "object") {
						emitter.codexGoalUpdated(
							requestId,
							sessionId,
							JSON.stringify(goal),
						);
					}
				}
				if (n.method === "thread/goal/cleared") {
					emitter.codexGoalUpdated(requestId, sessionId, null);
				}

				// Forward Codex token usage to the context-usage ring.
				if (n.method === "thread/tokenUsage/updated") {
					const tokenUsage = deepGet(n.params, "tokenUsage");
					if (tokenUsage && typeof tokenUsage === "object") {
						try {
							const meta = buildCodexStoredMeta(tokenUsage, ctx.lastSentModel);
							if (meta) {
								emitter.contextUsageUpdated(
									requestId,
									sessionId,
									JSON.stringify(meta),
								);
							}
						} catch (err) {
							logger.debug("contextUsageUpdated emit failed", {
								sessionId,
								...errorDetails(err),
							});
						}
					}
				}

				if (n.method === "turn/completed") {
					const completedTurnId =
						deepGet(n.params, "turn", "id") ?? deepGet(n.params, "turnId");
					// Only resolve if this is our active turn (not a child/collab turn)
					if (!ctx.activeTurnId || completedTurnId === ctx.activeTurnId) {
						ctx.activeTurnId = null;
						// Clean up any pending user inputs for this session
						for (const [id, p] of this.pendingUserInputs) {
							if (p.sessionId === sessionId) this.pendingUserInputs.delete(id);
						}
						for (const [id, p] of this.pendingApprovals) {
							if (p.sessionId === sessionId) this.pendingApprovals.delete(id);
						}
						ctx.turnResolve?.();
						ctx.turnResolve = null;
						ctx.turnReject = null;
					}
				}

				if (n.method === "thread/compacted") {
					ctx.activeTurnId = null;
					ctx.turnResolve?.();
					ctx.turnResolve = null;
					ctx.turnReject = null;
				}
			};

			const handleRequest = async (req: JsonRpcRequest) => {
				// Same gate as handleNotification: server-initiated
				// requests (tool approvals, user-input prompts) that
				// arrive during a `steer()` RPC window must not reach
				// the frontend UI before the synthetic user_prompt
				// event lands. Otherwise the permission/input panel
				// could pop before the steer bubble shows up, making
				// the interaction order look inconsistent.
				if (ctx.notificationGate) {
					await ctx.notificationGate;
				}

				if (APPROVAL_METHODS.has(req.method)) {
					const p = (req.params ?? {}) as Record<string, unknown>;
					const permissionId = `codex-${crypto.randomUUID()}`;

					this.pendingApprovals.set(permissionId, {
						jsonRpcId: req.id,
						sessionId,
					});

					emitter.permissionRequest(
						requestId,
						permissionId,
						approvalToolName(req.method),
						approvalToolInput(req.method, p),
						undefined,
						approvalDescription(req.method, p),
					);
					logger.debug(`Codex approval request`, {
						permissionId,
						method: req.method,
					});
					return;
				}
				if (req.method === "item/tool/requestUserInput") {
					const p = (req.params ?? {}) as Record<string, unknown>;
					const userInputId = `codex-input-${crypto.randomUUID()}`;
					const questions = Array.isArray(p.questions)
						? (p.questions as CodexQuestion[])
						: [];

					// Park the entry alongside the question array so we can
					// reverse-map the unified-form response back into Codex's
					// `{ id: { answers: [value] } }` shape.
					this.pendingUserInputs.set(userInputId, {
						kind: "codex-form",
						jsonRpcId: req.id,
						sessionId,
						questions,
					});

					emitter.userInputRequest(
						requestId,
						userInputId,
						"Codex",
						"Codex needs your input.",
						{ kind: "form", schema: buildCodexUserInputSchema(questions) },
					);
					logger.debug(`Codex user-input request`, { userInputId });
					return;
				}
				if (req.method === "mcpServer/elicitation/request") {
					// MCP elicitation forwarded by Codex. `mode: "form" | "url"`,
					// schema/URL passed through to the unified `userInputRequest`.
					const p = (req.params ?? {}) as Record<string, unknown>;

					// Empty-schema form == Codex's MCP tool-call approval
					// (`_meta.codex_approval_kind: "mcp_tool_call"`). `Never`
					// policy auto-accepts it; `Granular` doesn't, so we mirror
					// that here for bypass mode. Real forms still surface.
					const requestedSchema =
						typeof p.requestedSchema === "object" &&
						p.requestedSchema !== null &&
						!Array.isArray(p.requestedSchema)
							? (p.requestedSchema as Record<string, unknown>)
							: null;
					const properties =
						requestedSchema &&
						typeof requestedSchema.properties === "object" &&
						requestedSchema.properties !== null &&
						!Array.isArray(requestedSchema.properties)
							? (requestedSchema.properties as Record<string, unknown>)
							: {};
					const isEmptyApprovalForm =
						p.mode === "form" && Object.keys(properties).length === 0;
					if (isEmptyApprovalForm && permissionMode === "bypassPermissions") {
						ctx.server.sendResponse(req.id, {
							action: "accept",
							content: {},
							_meta: null,
						});
						logger.debug(
							"Codex MCP elicitation auto-accepted (empty schema in bypass mode)",
							{
								serverName:
									typeof p.serverName === "string" ? p.serverName : "(?)",
							},
						);
						return;
					}

					const userInputId = `codex-mcp-elicit-${crypto.randomUUID()}`;
					const serverName =
						typeof p.serverName === "string" ? p.serverName : "MCP server";
					const message =
						typeof p.message === "string"
							? p.message
							: "Server requested input.";

					this.pendingUserInputs.set(userInputId, {
						kind: "mcp-elicitation",
						jsonRpcId: req.id,
						sessionId,
					});

					if (p.mode === "url") {
						emitter.userInputRequest(
							requestId,
							userInputId,
							serverName,
							message,
							{
								kind: "url",
								url: typeof p.url === "string" ? p.url : "",
							},
						);
					} else {
						const schema = requestedSchema ?? {
							type: "object",
							properties: {},
						};
						emitter.userInputRequest(
							requestId,
							userInputId,
							serverName,
							message,
							{ kind: "form", schema },
						);
					}
					logger.debug(`Codex MCP elicitation request`, {
						userInputId,
						serverName,
						mode: p.mode,
					});
					return;
				}
				// Unknown server request — auto-reject
				ctx.server.sendResponse(req.id, undefined);
			};

			ctx.server.setHandlers(handleNotification, handleRequest);
			ctx.server.setActiveRequestId(requestId);

			if ((isCompactCommand || goalCommand) && !ctx.providerThreadId) {
				reject(
					new Error(
						`Cannot run /${isCompactCommand ? "compact" : "goal"} before a Codex thread has started`,
					),
				);
				return;
			}

			const dispatchPrompt = (): {
				method: string;
				promise: Promise<unknown>;
			} => {
				if (isCompactCommand) {
					return {
						method: "thread/compact/start",
						promise: ctx.server.sendRequest(
							"thread/compact/start",
							{ threadId: ctx.providerThreadId },
							20_000,
						),
					};
				}
				if (goalCommand) {
					return dispatchGoalCommand(
						ctx.server,
						ctx.providerThreadId as string,
						goalCommand,
					);
				}
				return {
					method: "turn/start",
					promise: ctx.server.sendRequest("turn/start", turnStartParams),
				};
			};

			const { method, promise: requestPromise } = dispatchPrompt();

			requestPromise
				.then((response) => {
					const turnId = deepGet(response, "turn", "id");
					if (typeof turnId === "string") {
						ctx.activeTurnId = turnId;
					}
				})
				.catch((err) => {
					logger.error(`${method} failed`, errorDetails(err));
					reject(err);
				});
		}).finally(() => {
			if (aborted) {
				emitter.aborted(requestId, "user_requested");
			} else {
				emitter.end(requestId);
			}
			if (ctx.activeRequestId === requestId) {
				ctx.activeRequestId = null;
				ctx.activeEmitter = null;
				ctx.lastRetryNotice = null;
			}
		});
	}

	// ── generateTitle ────────────────────────────────────────────────────

	async generateTitle(
		requestId: string,
		userMessage: string,
		branchRenamePrompt: string | null,
		emitter: SidecarEmitter,
		timeoutMs = TITLE_GENERATION_TIMEOUT_MS,
		options?: GenerateTitleOptions,
	): Promise<void> {
		const generateBranch = options?.generateBranch ?? true;
		const cwd = process.cwd();
		const model = options?.model?.trim() || pickFastestCodexModel();
		const fastMode = modelSupportsFastMode("codex", model);
		const server = new CodexAppServer({
			binaryPath: CODEX_BIN_PATH,
			cwd,
			onNotification: () => {},
			onRequest: (req) => {
				if (APPROVAL_METHODS.has(req.method)) {
					server.sendResponse(req.id, { decision: "accept" });
				}
			},
			onExit: () => {},
			onError: () => {},
		});

		const timeout = setTimeout(() => server.kill(), timeoutMs);

		try {
			await server.sendRequest("initialize", HELMOR_CLIENT_INFO);
			server.writeNotification("initialized");

			const threadStartParams: Record<string, unknown> = {
				model,
				approvalPolicy: BYPASS_GRANULAR_POLICY,
			};
			const threadResponse = await server.sendRequest<Record<string, unknown>>(
				"thread/start",
				threadStartParams,
			);
			const threadId = deepGet(threadResponse, "thread", "id") as
				| string
				| undefined;
			if (!threadId) throw new Error("thread/start did not return thread id");

			let raw = "";
			const done = new Promise<void>((resolve) => {
				server.setHandlers(
					(n) => {
						if (n.method === "item/agentMessage/delta") {
							const delta = deepGet(n.params, "delta");
							if (typeof delta === "string") raw += delta;
						}
						if (n.method === "turn/completed") resolve();
					},
					(req) => {
						if (APPROVAL_METHODS.has(req.method)) {
							server.sendResponse(req.id, { decision: "accept" });
						}
					},
				);
			});

			const turnStartParams: Record<string, unknown> = {
				threadId,
				input: [
					{
						type: "text",
						text: buildTitlePrompt(
							userMessage,
							branchRenamePrompt,
							generateBranch,
						),
						text_elements: [],
					},
				],
				model,
				effort: "minimal",
				approvalPolicy: BYPASS_GRANULAR_POLICY,
			};
			if (fastMode) turnStartParams.serviceTier = "fast";
			await server.sendRequest("turn/start", turnStartParams);

			await done;
			const { title, branchName } = parseTitleAndBranch(raw);
			emitter.titleGenerated(requestId, title, branchName);
		} finally {
			clearTimeout(timeout);
			server.kill();
		}
	}

	// ── listSlashCommands ────────────────────────────────────────────────

	async listSlashCommands(
		params: ListSlashCommandsParams,
	): Promise<readonly SlashCommandInfo[]> {
		const cwd = params.cwd ?? process.cwd();
		const cwds = collectSkillCwds(cwd, params.additionalDirectories);
		const server = new CodexAppServer({
			binaryPath: CODEX_BIN_PATH,
			cwd,
			onNotification: () => {},
			onRequest: () => {},
			onExit: () => {},
			onError: () => {},
		});

		try {
			await server.sendRequest("initialize", HELMOR_CLIENT_INFO);
			server.writeNotification("initialized");

			// 20s — mirrors the Claude sidecar slash-command timeout so both
			// providers fail the same way when their CLI is missing/slow.
			const result = await server.sendRequest<Record<string, unknown>>(
				"skills/list",
				{ cwds },
				20_000,
			);

			return parseSkillsResponse(result, cwds);
		} finally {
			server.kill();
		}
	}

	// ── listModels ───────────────────────────────────────────────────────

	async listModels(_opts?: {
		apiKey?: string;
	}): Promise<readonly ProviderModelInfo[]> {
		return listProviderModels("codex");
	}

	// ── mutateGoal ───────────────────────────────────────────────────────

	/**
	 * Out-of-band Codex `/goal` lifecycle control. Called when the user
	 * clicks Pause / Resume / Clear on the goal banner — these operations
	 * shouldn't appear in chat history, so they bypass the prompt-parsing
	 * path entirely and go straight to the right `thread/goal/*` RPC.
	 */
	async mutateGoal(
		sessionId: string,
		action: "pause" | "clear",
	): Promise<void> {
		const ctx = this.sessions.get(sessionId);
		logger.info("mutateGoal request", {
			sessionId,
			action,
			hasContext: !!ctx,
			threadId: ctx?.providerThreadId ?? "(none)",
			activeTurnId: ctx?.activeTurnId ?? "(none)",
			knownSessions: [...this.sessions.keys()],
		});
		if (!ctx?.providerThreadId) {
			// No live codex process or no thread yet — silent skip rather
			// than throw. The Composer Stop path fires this concurrently
			// with `stopAgentStream`, and a race where Stop kills the
			// process first must NOT surface as a user-facing error. The
			// Rust caller still applies the mutation to the local DB so
			// the banner reflects the new state.
			logger.debug("mutateGoal: no active codex context, skipping RPC", {
				sessionId,
				action,
			});
			return;
		}
		const threadId = ctx.providerThreadId;

		// Pause-only: codex's `thread/goal/set { paused }` stops the
		// continuation loop but doesn't abort the in-flight turn, leaving
		// helmor's loading spinner stuck. Issue `turn/interrupt` ourselves
		// to match the user intent ("pause = stop now"). The interrupt
		// produces a normal turn/completed downstream, which lets the
		// streaming pipeline transition out of the loading state.
		//
		// Clear deliberately does NOT interrupt — codex keeps streaming
		// the current turn naturally; clearing just removes the goal so
		// no further continuations spawn after the turn finishes.
		//
		// Contract on `ctx.activeTurnId`: it's only updated by
		// `setHandlers` from inside an active sendMessage stream, so a
		// goal-continuation turn that codex auto-spawns when no fresh
		// sendMessage is in flight will NOT be tracked here. In practice
		// `mutateGoal("pause")` is currently only fired by the Composer
		// Stop button, which runs `stopAgentStream` immediately after —
		// `stopSession` kills the codex child unconditionally, so any
		// untracked turn dies with the process. If a future caller fires
		// pause without that backup, this branch may silently no-op on
		// the untracked turn.
		if (action === "pause" && ctx.activeTurnId) {
			try {
				await ctx.server.sendRequest(
					"turn/interrupt",
					{ threadId, turnId: ctx.activeTurnId },
					5_000,
				);
			} catch (err) {
				// Best-effort — don't let an interrupt failure block the
				// goal state change. Codex may have just finished naturally.
				logger.debug("mutateGoal interrupt failed (best-effort)", {
					...errorDetails(err),
				});
			}
		}

		try {
			if (action === "clear") {
				await ctx.server.sendRequest("thread/goal/clear", { threadId }, 20_000);
				return;
			}
			// action === "pause"
			await ctx.server.sendRequest(
				"thread/goal/set",
				{ threadId, status: "paused" },
				20_000,
			);
		} catch (err) {
			// The codex child may have been killed (Composer Stop's parallel
			// stopSession path) — same idempotency rule as the no-ctx case.
			logger.debug("mutateGoal RPC failed (best-effort)", {
				...errorDetails(err),
			});
		}
	}

	// ── ensureCodexGoalsReady ────────────────────────────────────────────

	// Writes `[features] goals = true` if missing, then recycles any stale
	// codex process so the new config takes effect. Returns a resume thread
	// id (caller's wins; otherwise the stale ctx's). Best-effort — IO
	// failures are logged and the caller falls through to codex's own error.
	private async ensureCodexGoalsReady(
		sessionId: string,
		callerResume: string | undefined,
	): Promise<string | undefined> {
		let result: Awaited<ReturnType<typeof ensureCodexGoalsFeatureEnabled>>;
		try {
			result = await ensureCodexGoalsFeatureEnabled();
		} catch (err) {
			logger.error("ensureCodexGoalsFeatureEnabled failed", errorDetails(err));
			return callerResume;
		}
		if (result.kind !== "modified") return callerResume;

		const stale = this.sessions.get(sessionId);
		if (!stale) {
			logger.info("Enabled codex goals feature", {
				sessionId,
				path: result.path,
			});
			return callerResume;
		}

		logger.info("Enabled codex goals feature; recycling stale session", {
			sessionId,
			path: result.path,
			providerThreadId: stale.providerThreadId ?? "(none)",
		});
		const reuseThread = stale.providerThreadId ?? undefined;
		stale.server.kill();
		this.sessions.delete(sessionId);
		for (const [id, p] of this.pendingApprovals) {
			if (p.sessionId === sessionId) this.pendingApprovals.delete(id);
		}
		for (const [id, p] of this.pendingUserInputs) {
			if (p.sessionId === sessionId) this.pendingUserInputs.delete(id);
		}
		return callerResume ?? reuseThread;
	}

	// ── stopSession / shutdown ───────────────────────────────────────────

	async stopSession(sessionId: string): Promise<void> {
		const ctx = this.sessions.get(sessionId);
		if (!ctx) return;
		logger.info(`stopSession ${sessionId}`, {
			threadId: ctx.providerThreadId ?? "(none)",
		});

		for (const [id, p] of this.pendingApprovals) {
			if (p.sessionId === sessionId) this.pendingApprovals.delete(id);
		}
		for (const [id, p] of this.pendingUserInputs) {
			if (p.sessionId === sessionId) this.pendingUserInputs.delete(id);
		}

		const pendingReject = ctx.turnReject;
		const turnToInterrupt = ctx.activeTurnId;
		ctx.turnResolve = null;
		ctx.turnReject = null;
		ctx.activeTurnId = null;

		if (ctx.providerThreadId && turnToInterrupt) {
			try {
				await ctx.server.sendRequest(
					"turn/interrupt",
					{ threadId: ctx.providerThreadId, turnId: turnToInterrupt },
					5_000,
				);
			} catch {
				// best-effort
			}
		}

		ctx.server.kill();
		this.sessions.delete(sessionId);

		// Use AbortError so the index catch can distinguish user-stop from real errors
		const abortErr = new DOMException("Session stopped by user", "AbortError");
		pendingReject?.(abortErr);
	}

	/**
	 * Real mid-turn steer via Codex's native `turn/steer` RPC — appends
	 * user input to the active turn without starting a new one. Emits a
	 * `user_prompt` passthrough so the accumulator places the bubble at
	 * the current position AND streaming.rs persists it once (same DB
	 * shape as initial prompts; adapter reads it identically on reload).
	 *
	 * Two correctness properties this method enforces:
	 *
	 *   1. **No ghost steer on rejection.** RPC goes first; the synthetic
	 *      event is only emitted after the RPC resolves successfully. A
	 *      thrown RPC error (expectedTurnId mismatch, timeout, server
	 *      error) propagates up WITHOUT ever touching the pipeline.
	 *
	 *   2. **Strict ordering with post-steer notifications.** We install
	 *      a `notificationGate` promise for the RPC window. Any
	 *      server-side deltas that arrive before the RPC reply (possible
	 *      if the server buffers the reply and streams tokens first) hit
	 *      `handleNotification`, await the gate, and only flow into the
	 *      pipeline AFTER the synthetic user_prompt event is emitted.
	 *      JS microtask FIFO preserves their relative order.
	 *
	 * Returns `true` when accepted, `false` when no active turn exists.
	 */
	async steer(
		sessionId: string,
		prompt: string,
		files: readonly string[],
		// Codex's `turn/steer` RPC forwards text only; the SDK has no
		// hook to attach images mid-turn. We still carry `images` on the
		// synthetic `user_prompt` event below so the persisted shape
		// matches the optimistic render — the badges remain visible on
		// reload — but the model itself never sees the bytes. The
		// frontend should warn the user before they steer with images
		// attached on a Codex session.
		images: readonly string[],
	): Promise<boolean> {
		const ctx = this.sessions.get(sessionId);
		if (!ctx?.providerThreadId || !ctx.activeTurnId) {
			return false;
		}
		if (images.length > 0) {
			// `info` rather than a richer log level — the sidecar's
			// `Logger` only exposes debug/info/error. Surface the
			// limitation prominently so the user can correlate "Codex
			// didn't see my image" with this line in the JSONL log.
			logger.info(
				`steer ${sessionId}: ${images.length} image(s) dropped (codex turn/steer is text-only)`,
				{
					note: "images are persisted to the DB so the bubble keeps its badge after reload, but the model itself does not see them",
				},
			);
		}
		logger.info(`steer ${sessionId}`, {
			threadId: ctx.providerThreadId,
			turnId: ctx.activeTurnId,
			preview: prompt.slice(0, 60),
			fileCount: files.length,
			imageCount: images.length,
		});

		let releaseGate: () => void = () => {};
		ctx.notificationGate = new Promise<void>((resolve) => {
			releaseGate = resolve;
		});

		try {
			// RPC first. Thrown errors (reject, timeout, expectedTurnId
			// mismatch) propagate WITHOUT emitting the synthetic event.
			await ctx.server.sendRequest(
				"turn/steer",
				{
					threadId: ctx.providerThreadId,
					input: [{ type: "text", text: prompt }],
					expectedTurnId: ctx.activeTurnId,
				},
				5_000,
			);

			// Provider accepted. Emit the synthetic event BEFORE releasing
			// the gate so queued notifications land after it in FIFO.
			// `images` rides on the event purely for persistence/reload
			// fidelity (see the steer() doc above) — Codex's turn/steer
			// already returned without seeing them.
			if (ctx.activeEmitter && ctx.activeRequestId) {
				const event: {
					type: "user_prompt";
					text: string;
					steer: true;
					files?: string[];
					images?: string[];
				} = { type: "user_prompt", text: prompt, steer: true };
				if (files.length > 0) event.files = [...files];
				if (images.length > 0) event.images = [...images];
				ctx.activeEmitter.passthrough(ctx.activeRequestId, event);
			}
			return true;
		} finally {
			// Always release the gate — rejection path lets queued
			// notifications flow through normally (no synthetic ahead of
			// them; Codex shouldn't have sent deltas for a rejected
			// steer anyway, and if it did, treating them as main-stream
			// events is the conservative choice).
			ctx.notificationGate = null;
			releaseGate();
		}
	}

	async shutdown(): Promise<void> {
		for (const [_id, ctx] of this.sessions) {
			try {
				ctx.turnReject?.(new Error("Sidecar shutdown"));
				ctx.turnResolve = null;
				ctx.turnReject = null;
				ctx.server.kill();
			} catch (err) {
				logger.error("shutdown: kill failed", errorDetails(err));
			}
		}
		this.sessions.clear();
		this.pendingApprovals.clear();
		this.pendingUserInputs.clear();
	}

	// ── Private ──────────────────────────────────────────────────────────

	private settleUnexpectedExit(
		sessionId: string,
		ctx: AppServerContext,
		code: number | null,
		signal: string | null,
	): void {
		const hasActiveTurn =
			ctx.turnResolve !== null ||
			ctx.turnReject !== null ||
			ctx.activeTurnId !== null;
		if (!hasActiveTurn) return;

		for (const [id, p] of this.pendingApprovals) {
			if (p.sessionId === sessionId) this.pendingApprovals.delete(id);
		}
		for (const [id, p] of this.pendingUserInputs) {
			if (p.sessionId === sessionId) this.pendingUserInputs.delete(id);
		}

		const requestId = ctx.activeRequestId;
		const emitter = ctx.activeEmitter;
		logger.error("codex app-server exited during active turn", {
			sessionId,
			requestId: requestId ?? "(none)",
			turnId: ctx.activeTurnId ?? "(none)",
			code,
			signal,
		});
		ctx.activeTurnId = null;
		const resolve = ctx.turnResolve;
		ctx.turnResolve = null;
		ctx.turnReject = null;

		if (requestId && emitter) {
			emitter.error(requestId, "Codex app-server exited unexpectedly");
		}
		resolve?.();
	}

	/**
	 * Get an existing session context or create a new one. When `resume`
	 * is set (provider thread ID from a previous session), attempts
	 * `thread/resume` first, falling back to `thread/start` on
	 * recoverable errors.
	 */
	private async ensureContext(
		sessionId: string,
		cwd: string,
		resume?: string,
		model?: string,
		permissionMode?: string,
		fastMode?: boolean,
	): Promise<AppServerContext> {
		const existing = this.sessions.get(sessionId);
		if (existing && !existing.server.killed) return existing;

		// Forward-reference holder so the `onRetry` closure can reach the
		// context that's constructed below — the callback only fires once
		// the CodexAppServer is running, by which point `ctxRef.current`
		// has been populated.
		const ctxRef: { current: AppServerContext | null } = { current: null };

		const server = new CodexAppServer({
			binaryPath: CODEX_BIN_PATH,
			cwd,
			onNotification: () => {},
			onRequest: () => {},
			onExit: (code, signal) => {
				const ctx = ctxRef.current;
				if (ctx) {
					this.settleUnexpectedExit(sessionId, ctx, code, signal);
				}
				this.sessions.delete(sessionId);
			},
			onError: (err) => {
				logger.error("codex app-server error", errorDetails(err));
			},
			onRetry: (message) => {
				const c = ctxRef.current;
				if (!c) return;
				c.lastRetryAt = Date.now();
				// Pulse a synthetic heartbeat so Rust's 45s watchdog doesn't
				// declare the sidecar dead while Codex is silently retrying
				// against an upstream provider (e.g. Azure OpenAI mini-outage).
				if (c.activeRequestId) {
					emitRetryNotice(c, c.activeRequestId, message);
				}
				logger.debug("codex retry detected; suppression window armed", {
					sessionId,
					activeRequestId: c.activeRequestId,
				});
			},
		});

		await server.sendRequest("initialize", HELMOR_CLIENT_INFO);
		server.writeNotification("initialized");

		let threadId: string | null = null;

		if (resume) {
			try {
				logger.info(`Attempting thread/resume`, { threadId: resume });
				const response = await server.sendRequest<Record<string, unknown>>(
					"thread/resume",
					{ threadId: resume },
				);
				threadId = (deepGet(response, "thread", "id") as string) ?? resume;
				logger.info(`Resumed Codex thread`, { threadId });
			} catch (err) {
				if (isRecoverableResumeError(err)) {
					logger.debug(
						`thread/resume failed (recoverable), falling back to thread/start: ${err instanceof Error ? err.message : String(err)}`,
					);
				} else {
					server.kill();
					throw err;
				}
			}
		}

		if (!threadId) {
			logger.info("Starting new Codex thread", {
				cwd,
				model: model ?? "(default)",
			});
			const threadStartParams: Record<string, unknown> = {
				cwd,
				approvalPolicy:
					toCodexApprovalPolicy(permissionMode) ?? BYPASS_GRANULAR_POLICY,
				sandbox:
					permissionMode === "plan" ? "workspace-write" : "danger-full-access",
			};
			if (model) threadStartParams.model = model;
			if (fastMode) threadStartParams.serviceTier = "fast";
			const response = await server.sendRequest<Record<string, unknown>>(
				"thread/start",
				threadStartParams,
			);
			threadId = (deepGet(response, "thread", "id") as string) ?? null;
			logger.info("Codex thread started", { threadId: threadId ?? "(none)" });
		}

		const ctx: AppServerContext = {
			server,
			providerThreadId: threadId,
			activeTurnId: null,
			turnResolve: null,
			turnReject: null,
			activeRequestId: null,
			activeEmitter: null,
			notificationGate: null,
			lastSentModel: model ?? "",
			lastRetryAt: null,
			lastRetryNotice: null,
			subAgentTracker: new SubAgentTracker(server),
		};

		this.sessions.set(sessionId, ctx);
		ctxRef.current = ctx;
		return ctx;
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function retryNoticeKey(message: string): string {
	return message.replace(/…/g, "...").replace(/\s+/g, " ").trim();
}

function emitRetryNotice(
	ctx: AppServerContext,
	requestId: string,
	message: string,
): void {
	if (!ctx.activeEmitter) return;

	try {
		ctx.activeEmitter.heartbeat(requestId);
	} catch {
		return;
	}

	const now = Date.now();
	const key = retryNoticeKey(message);
	if (
		ctx.lastRetryNotice?.key === key &&
		now - ctx.lastRetryNotice.at < RETRY_NOTICE_DEDUPE_MS
	) {
		return;
	}
	ctx.lastRetryNotice = { key, at: now };

	const { attempt, max } = parseReconnectCounts(message);
	ctx.activeEmitter.passthrough(requestId, {
		type: "system",
		subtype: "codex_reconnecting",
		attempt,
		max_retries: max,
		retry_delay_ms: 0,
		error: message,
	});
}

function flattenNotification(
	n: JsonRpcNotification,
	sessionId: string | null,
): Record<string, unknown> {
	const params =
		n.params && typeof n.params === "object"
			? (n.params as Record<string, unknown>)
			: {};
	return {
		type: n.method,
		...params,
		...(sessionId ? { session_id: sessionId } : {}),
	};
}

/** params.threadId, or thread.id for thread/started. */
function extractEventThreadId(n: JsonRpcNotification): string | null {
	const params = n.params as Record<string, unknown> | undefined;
	if (!params) return null;
	const direct = params.threadId;
	if (typeof direct === "string") return direct;
	const fromThread = (params.thread as Record<string, unknown> | undefined)?.id;
	return typeof fromThread === "string" ? fromThread : null;
}

/** True for any `collabAgentToolCall` whose `receiverThreadIds` are
 *  populated. spawnAgent's `item/started` has empty receivers (new thread
 *  not created yet) so falls through; spawnAgent completed plus
 *  wait/sendInput/resumeAgent/closeAgent at started AND completed match. */
function shouldEnrichCollabItem(params: unknown): boolean {
	if (!params || typeof params !== "object") return false;
	const item = (params as Record<string, unknown>).item as
		| Record<string, unknown>
		| undefined;
	if (!item || item.type !== "collabAgentToolCall") return false;
	const receivers = item.receiverThreadIds;
	return Array.isArray(receivers) && receivers.length > 0;
}

/** Resolve nickname/role for each receiverThreadId via `thread/read` and
 *  merge into `agentsStates`. Existing values win. Used for any collab
 *  tool call (spawnAgent / sendInput / resumeAgent / wait / closeAgent). */
async function enrichCollabItem(
	tracker: SubAgentTracker,
	n: JsonRpcNotification,
): Promise<void> {
	const params = n.params as Record<string, unknown> | undefined;
	const item = params?.item as Record<string, unknown> | undefined;
	if (!item) return;
	const receivers = item.receiverThreadIds;
	if (!Array.isArray(receivers) || receivers.length === 0) return;

	// Resolve all receivers in parallel — usually it's exactly one per call.
	const metas = await Promise.all(
		receivers.map((tid) =>
			typeof tid === "string"
				? tracker.noteSpawned(tid)
				: Promise.resolve(null),
		),
	);

	const states = (item.agentsStates ?? {}) as Record<
		string,
		Record<string, unknown>
	>;
	for (let i = 0; i < receivers.length; i++) {
		const tid = receivers[i];
		const meta = metas[i];
		if (typeof tid !== "string" || !meta) continue;
		const state = (states[tid] as Record<string, unknown> | undefined) ?? {};
		// Existing values win — only fill in what's missing. Guards against
		// `noteSpawned` returning a fallback placeholder (thread/read timed
		// out / failed) blowing away whatever the upstream item already had.
		if (meta.agentNickname && state.agentNickname == null) {
			state.agentNickname = meta.agentNickname;
		}
		if (meta.agentRole && state.agentRole == null) {
			state.agentRole = meta.agentRole;
		}
		states[tid] = state;
	}
	item.agentsStates = states;
}

function buildTurnInput(
	prompt: string,
	images: readonly string[],
): Array<Record<string, unknown>> {
	const { text, imagePaths } = parseImageRefs(prompt, images);
	const parts: Array<Record<string, unknown>> = [];
	if (text) {
		parts.push({ type: "text", text, text_elements: [] });
	}
	for (const p of imagePaths) {
		parts.push({ type: "localImage", path: p });
	}
	if (parts.length === 0) {
		parts.push({ type: "text", text: prompt, text_elements: [] });
	}
	return parts;
}

function deepGet(obj: unknown, ...keys: string[]): unknown {
	let current = obj;
	for (const key of keys) {
		if (!current || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return current;
}

function collectSkillCwds(
	cwd: string,
	additionalDirectories: readonly string[] | undefined,
): string[] {
	const cwds = [cwd, ...(additionalDirectories ?? [])].map((dir) => dir.trim());
	return Array.from(new Set(cwds.filter(Boolean)));
}

function parseSkillsResponse(
	result: unknown,
	cwds: readonly string[],
): SlashCommandInfo[] {
	if (!result || typeof result !== "object") return [];
	const r = result as Record<string, unknown>;

	const skills: unknown[] = [];
	const dataBuckets = Array.isArray(r.data) ? r.data : [];
	const wantedCwds = new Set(cwds);
	for (const bucket of dataBuckets) {
		if (!bucket || typeof bucket !== "object") continue;
		const record = bucket as Record<string, unknown>;
		if (!wantedCwds.has(String(record.cwd ?? ""))) continue;
		const bucketSkills = record.skills;
		if (Array.isArray(bucketSkills)) skills.push(...bucketSkills);
	}
	if (skills.length === 0 && Array.isArray(r.skills)) {
		skills.push(...r.skills);
	}

	const commands = skills.flatMap((s) => {
		if (!s || typeof s !== "object") return [];
		const skill = s as Record<string, unknown>;
		const name = typeof skill.name === "string" ? skill.name : null;
		if (!name) return [];

		const desc =
			typeof skill.shortDescription === "string"
				? skill.shortDescription
				: typeof skill.description === "string"
					? skill.description
					: "";

		return [
			{
				name,
				description: desc,
				argumentHint: undefined,
				source: "skill" as const,
			},
		];
	});
	const byName = new Map<string, SlashCommandInfo>();
	for (const command of commands) {
		if (!byName.has(command.name)) byName.set(command.name, command);
	}
	return Array.from(byName.values());
}

/**
 * Map Helmor's permissionMode to Codex's collaborationMode.
 * Returns undefined when no override is needed (i.e. default mode).
 */
function toCodexCollaborationMode(
	permissionMode: string | undefined,
	model: string | undefined,
): Record<string, unknown> | undefined {
	if (permissionMode === "plan") {
		return {
			mode: "plan",
			settings: {
				...(model ? { model } : {}),
			},
		};
	}
	// Explicitly switch to default mode — Codex stays in plan mode
	// across turns unless told otherwise.
	if (
		permissionMode === "bypassPermissions" ||
		permissionMode === "acceptEdits"
	) {
		return {
			mode: "default",
			settings: {
				...(model ? { model } : {}),
			},
		};
	}
	return undefined;
}

// `bypassPermissions` uses `Granular` (not `"never"`) because Codex's
// `Never` policy also auto-declines MCP elicitations.
type CodexApprovalPolicy =
	| string
	| {
			granular: {
				sandbox_approval: boolean;
				rules: boolean;
				skill_approval: boolean;
				request_permissions: boolean;
				mcp_elicitations: boolean;
			};
	  };

const BYPASS_GRANULAR_POLICY: CodexApprovalPolicy = {
	granular: {
		sandbox_approval: false,
		rules: false,
		skill_approval: false,
		request_permissions: false,
		mcp_elicitations: true,
	},
};

function toCodexApprovalPolicy(
	permissionMode: string | undefined,
): CodexApprovalPolicy | undefined {
	if (permissionMode === "bypassPermissions") return BYPASS_GRANULAR_POLICY;
	if (permissionMode === "acceptEdits") return "untrusted";
	// plan mode is read-only by design — leave to Codex default
	return undefined;
}

async function mergeAdditionalDirectories(
	cwd: string | undefined,
	userDirectories: readonly string[] | undefined,
): Promise<string[]> {
	const seen = new Set<string>();
	const merged: string[] = [];
	for (const raw of userDirectories ?? []) {
		const trimmed = raw.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		merged.push(trimmed);
	}
	const gitDirs = await resolveGitAccessDirectories(cwd);
	for (const dir of gitDirs) {
		if (seen.has(dir)) continue;
		seen.add(dir);
		merged.push(dir);
	}
	return merged;
}

/**
 * Build the explicit per-turn sandbox policy for Codex. We always send a
 * policy so a thread that previously ran in plan mode can switch back to
 * full access on the next turn without being recreated.
 *
 * For plan mode we keep Codex in `workspaceWrite` and include cwd plus any
 * linked directories in `writableRoots`. For all other modes we explicitly
 * restore `dangerFullAccess`.
 */
export function buildTurnSandboxPolicy(
	permissionMode: string | undefined,
	cwd: string | undefined,
	additionalDirectories: readonly string[] | undefined,
):
	| {
			type: "dangerFullAccess";
	  }
	| {
			type: "workspaceWrite";
			writableRoots: string[];
			networkAccess: false;
	  } {
	if (permissionMode !== "plan") {
		return { type: "dangerFullAccess" };
	}
	const seen = new Set<string>();
	const out: string[] = [];
	const cwdTrimmed = cwd?.trim();
	if (cwdTrimmed) {
		seen.add(cwdTrimmed);
		out.push(cwdTrimmed);
	}
	for (const raw of additionalDirectories ?? []) {
		const trimmed = raw.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed);
	}
	return {
		type: "workspaceWrite",
		writableRoots: out,
		networkAccess: false,
	};
}
