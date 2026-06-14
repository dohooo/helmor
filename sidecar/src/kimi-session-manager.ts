/**
 * SessionManager for Kimi Code CLI over ACP (`kimi acp`).
 *
 * One shared `kimi acp` child hosts every Helmor session (ACP multiplexes
 * sessions over a single connection — same shape as `OpencodeSessionManager`'s
 * shared server). Each `session/update` notification is demuxed by `sessionId`
 * and forwarded verbatim (namespaced `kimi/*`) for the Rust accumulator; the
 * `session/prompt` response is the turn-end signal. Permission + fs requests
 * arrive as agent→client JSON-RPC and are answered here.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ActiveTurnRegistry } from "./active-turn-registry.js";
import type { SidecarEmitter } from "./emitter.js";
import {
	type JsonRpcNotification,
	type JsonRpcRequest,
	KimiAcpConnection,
} from "./kimi-acp-connection.js";
import type {
	AcpNewSessionResult,
	AcpPromptResult,
	AcpReadTextFileParams,
	AcpRequestPermissionParams,
	AcpSessionNotification,
	AcpWriteTextFileParams,
} from "./kimi-acp-types.js";
import {
	buildPromptBlocks,
	firstAnswerLabel,
	isSelectionRequest,
	toolContentText,
	translateSessionUpdate,
} from "./kimi-session-update.js";
import { prependLinkedDirectoriesContext } from "./linked-directories-context.js";
import { errorDetails, logger } from "./logger.js";
import { listProviderModels } from "./model-catalog.js";
import type {
	GenerateTitleOptions,
	ListSlashCommandsParams,
	ProviderModelInfo,
	SendMessageParams,
	SessionManager,
	SlashCommandInfo,
	UserInputResolution,
} from "./session-manager.js";
import { parseTitleAndBranch } from "./title.js";

const KIMI_PERMISSION_PREFIX = "kimi-";
const AUTH_REQUIRED_CODE = -32000;
/** `session/load` replays the full history before responding — give long
 *  sessions room well past the 60s default. */
const SESSION_LOAD_TIMEOUT_MS = 5 * 60_000;

interface SessionCtx {
	readonly helmorSessionId: string;
	acpSessionId: string;
	cwd: string;
	activeRequestId: string | null;
	activeEmitter: SidecarEmitter | null;
	/** Settles the active turn locally on Stop — never gate Stop behind the
	 *  agent's cancel handling (a wedged agent must not hold the session). */
	settleCancelledTurn: (() => void) | null;
	/** True while `session/load` replays history — drop those updates so the
	 *  Rust pipeline (which already holds the persisted history) doesn't
	 *  double-render. */
	replaying: boolean;
	/** Last model id applied via `session/set_model` — skip redundant re-applies. */
	appliedModel?: string;
}

interface PendingPrompt {
	readonly ctx: SessionCtx;
	readonly jsonRpcId: string | number;
	readonly options: AcpRequestPermissionParams["options"];
}

export class KimiSessionManager implements SessionManager {
	private readonly connection: KimiAcpConnection;
	private readonly sessions = new Map<string, SessionCtx>();
	private readonly byAcpId = new Map<string, SessionCtx>();
	/** In-flight first-turn session creation, shared so two racing turns on
	 *  the same Helmor session never create two ACP sessions. */
	private readonly sessionInit = new Map<string, Promise<SessionCtx>>();
	private readonly turns = new ActiveTurnRegistry();
	/** Binary tool approvals, answered via `resolvePermission`. */
	private readonly pendingPermissions = new Map<string, PendingPrompt>();
	/** Selection prompts (AskUserQuestion / plan review), answered via
	 *  `resolveUserInput`. */
	private readonly pendingQuestions = new Map<string, PendingPrompt>();
	/** Latest `available_commands_update`, surfaced by `listSlashCommands`. */
	private cachedCommands: SlashCommandInfo[] = [];

	constructor() {
		this.connection = new KimiAcpConnection({
			onNotification: (n) => this.onNotification(n),
			onRequest: (r) => this.onRequest(r),
			onExit: (code, signal) => this.onConnectionExit(code, signal),
		});
	}

	/** Answer a parked selection prompt (AskUserQuestion / plan review): map
	 *  the chosen label back to its ACP optionId; anything else cancels. */
	resolveUserInput(
		userInputId: string,
		resolution: UserInputResolution,
	): boolean {
		const pending = this.pendingQuestions.get(userInputId);
		if (!pending) return false;
		this.pendingQuestions.delete(userInputId);
		let outcome: Record<string, unknown> = { outcome: "cancelled" };
		if (resolution.action === "submit") {
			const label = firstAnswerLabel(resolution.content);
			const option = label
				? pending.options.find((o) => (o.name ?? o.optionId) === label)
				: undefined;
			if (option) outcome = { outcome: "selected", optionId: option.optionId };
		}
		this.connection.sendResponse(pending.jsonRpcId, { outcome });
		return true;
	}

	resolvePermission(permissionId: string, behavior: "allow" | "deny"): void {
		const pending = this.pendingPermissions.get(permissionId);
		if (!pending) return;
		this.pendingPermissions.delete(permissionId);
		const optionId = selectPermissionOption(pending.options, behavior);
		const outcome =
			optionId !== null
				? { outcome: "selected", optionId }
				: { outcome: "cancelled" };
		this.connection.sendResponse(pending.jsonRpcId, { outcome });
	}

	async sendMessage(
		requestId: string,
		params: SendMessageParams,
		emitter: SidecarEmitter,
	): Promise<void> {
		// Register before startup so a Stop mid-spawn emits `aborted` instantly.
		this.turns.begin(params.sessionId, requestId, emitter, () =>
			this.cancelTurn(params.sessionId),
		);
		const cwd = params.cwd ?? process.cwd();

		try {
			await this.connection.start();
		} catch (error) {
			this.failTurn(
				params.sessionId,
				requestId,
				emitter,
				`kimi: ${errorMessage(error)}`,
			);
			return;
		}
		if (this.turns.isAbortRequested(params.sessionId)) {
			this.turns.end(params.sessionId, requestId);
			return;
		}

		let ctx: SessionCtx;
		try {
			ctx = await this.ensureSession(params, cwd, requestId, emitter);
		} catch (error) {
			if (isAuthRequired(error)) {
				this.failTurn(
					params.sessionId,
					requestId,
					emitter,
					"Kimi authentication required — sign in via Settings → Providers (kimi login).",
				);
			} else {
				this.failTurn(
					params.sessionId,
					requestId,
					emitter,
					`kimi: ${errorMessage(error)}`,
				);
			}
			return;
		}
		if (this.turns.isAbortRequested(params.sessionId)) {
			this.turns.end(params.sessionId, requestId);
			return;
		}

		ctx.activeRequestId = requestId;
		ctx.activeEmitter = emitter;
		this.connection.setActiveRequestId(requestId);
		await this.applyModel(ctx, params.model);

		const prompt = await buildPromptBlocks(
			prependLinkedDirectoriesContext(
				params.prompt,
				params.additionalDirectories,
			),
			params.images,
		);

		// ACP carries no turn timing, so measure it here for the duration footer.
		const turnStartedAt = Date.now();
		let turnError: Error | null = null;
		let result: AcpPromptResult | null = null;
		try {
			// No timeout: a turn legitimately runs for minutes; heartbeats keep
			// Rust's watchdog satisfied. The response resolves at turn end.
			const promptDone = this.connection.sendRequest<AcpPromptResult>(
				"session/prompt",
				{ sessionId: ctx.acpSessionId, prompt },
				0,
			);
			// If Stop settles the race first, the abandoned branch must not
			// surface an unhandled rejection when the child later dies.
			promptDone.catch(() => {});
			const stopped = new Promise<null>((resolve) => {
				ctx.settleCancelledTurn = () => resolve(null);
			});
			result = await Promise.race([promptDone, stopped]);
		} catch (error) {
			turnError = error instanceof Error ? error : new Error(String(error));
		} finally {
			// Guard on requestId: after a Stop unblocked this turn locally, a NEW
			// turn may already own ctx — never clobber its slots or its prompts.
			if (ctx.activeRequestId === requestId) {
				this.cancelPendingPrompts(ctx);
				ctx.activeRequestId = null;
				ctx.activeEmitter = null;
				ctx.settleCancelledTurn = null;
				this.connection.setActiveRequestId(null);
			}
		}

		// Stop pressed — `requestStop` already emitted the terminal `aborted`
		// and the Rust abort path flushes the in-flight turn.
		if (this.turns.isAbortRequested(params.sessionId)) {
			this.turns.end(params.sessionId, requestId);
			return;
		}
		if (turnError) {
			emitter.error(requestId, `kimi: ${turnError.message}`);
		} else if (result?.stopReason === "refusal") {
			// Spec: a refusal must be reflected in the UI — the prompt did not
			// enter the agent's context.
			emitter.error(
				requestId,
				"kimi: the agent declined to continue (refusal).",
			);
		} else {
			if (result && result.stopReason !== "end_turn") {
				logger.debug("kimi turn ended early", {
					stopReason: result.stopReason,
				});
			}
			// Finalize the turn so the Rust accumulator persists it (the
			// `session/prompt` response is the turn-end signal). MUST precede
			// `end` — the Rust stream loop stops reading at the terminal event.
			emitter.passthrough(requestId, {
				type: "kimi/turn_complete",
				session_id: ctx.acpSessionId,
				duration_ms: Date.now() - turnStartedAt,
			});
		}
		emitter.end(requestId);
		this.turns.end(params.sessionId, requestId);
	}

	/** Reuse the cached ctx, else resume (`session/load`) or create
	 *  (`session/new`) — concurrent first turns share one in-flight creation. */
	private ensureSession(
		params: SendMessageParams,
		cwd: string,
		requestId: string,
		emitter: SidecarEmitter,
	): Promise<SessionCtx> {
		const existing = this.sessions.get(params.sessionId);
		if (existing) {
			existing.cwd = cwd;
			return Promise.resolve(existing);
		}
		let creating = this.sessionInit.get(params.sessionId);
		if (!creating) {
			creating = this.createSession(params, cwd, requestId, emitter).finally(
				() => this.sessionInit.delete(params.sessionId),
			);
			this.sessionInit.set(params.sessionId, creating);
		}
		return creating;
	}

	private async createSession(
		params: SendMessageParams,
		cwd: string,
		requestId: string,
		emitter: SidecarEmitter,
	): Promise<SessionCtx> {
		const ctx: SessionCtx = {
			helmorSessionId: params.sessionId,
			acpSessionId: "",
			cwd,
			activeRequestId: null,
			activeEmitter: null,
			settleCancelledTurn: null,
			replaying: false,
		};

		const resumeId = params.resume?.trim();
		const canLoad =
			this.connection.initializeResult?.agentCapabilities?.loadSession;
		if (resumeId && canLoad) {
			ctx.acpSessionId = resumeId;
			ctx.replaying = true;
			this.byAcpId.set(resumeId, ctx);
			try {
				await this.connection.sendRequest(
					"session/load",
					{ sessionId: resumeId, cwd, mcpServers: [] },
					SESSION_LOAD_TIMEOUT_MS,
				);
				ctx.replaying = false;
				this.sessions.set(params.sessionId, ctx);
				return ctx;
			} catch (error) {
				// Stale/absent id → fall through to a fresh session.
				ctx.replaying = false;
				this.byAcpId.delete(resumeId);
				logger.debug(
					"kimi session/load failed; creating fresh",
					errorDetails(error),
				);
			}
		}

		const res = await this.connection.sendRequest<AcpNewSessionResult>(
			"session/new",
			{ cwd, mcpServers: [] },
		);
		const acpSessionId = res?.sessionId;
		if (!acpSessionId) throw new Error("session/new returned no sessionId");
		ctx.acpSessionId = acpSessionId;
		this.sessions.set(params.sessionId, ctx);
		this.byAcpId.set(acpSessionId, ctx);
		// Synthetic init so Rust records provider_session_id even on an empty turn.
		emitter.passthrough(requestId, {
			type: "kimi/session_init",
			session_id: acpSessionId,
			...(params.model ? { model: params.model } : {}),
		});
		return ctx;
	}

	/** Apply the composer-selected model via ACP `session/set_model`. Best-effort:
	 *  if the agent rejects it (model not configured, or set_model unsupported),
	 *  warn and let the turn run on the agent's default model. */
	private async applyModel(
		ctx: SessionCtx,
		model: string | undefined,
	): Promise<void> {
		const next = model?.trim();
		if (!next || next === ctx.appliedModel) return;
		try {
			await this.connection.sendRequest("session/set_model", {
				sessionId: ctx.acpSessionId,
				modelId: next,
			});
			ctx.appliedModel = next;
		} catch (error) {
			logger.info("kimi session/set_model failed; using the agent default", {
				model: next,
				...errorDetails(error),
			});
		}
	}

	private onNotification(notification: JsonRpcNotification): void {
		if (notification.method !== "session/update") return;
		const params = notification.params as AcpSessionNotification | undefined;
		const acpSessionId = params?.sessionId;
		if (!acpSessionId || !params?.update) return;
		const ctx = this.byAcpId.get(acpSessionId);
		if (!ctx) return;

		const translated = translateSessionUpdate(acpSessionId, params.update);
		if (translated.commands) this.cachedCommands = translated.commands;
		if (!translated.passthrough) return;
		// Drop history replay + post-abort content (Rust stops at the terminal event).
		if (ctx.replaying || this.turns.isAbortRequested(ctx.helmorSessionId))
			return;
		if (ctx.activeEmitter && ctx.activeRequestId) {
			ctx.activeEmitter.passthrough(
				ctx.activeRequestId,
				translated.passthrough,
			);
		}
	}

	private onRequest(request: JsonRpcRequest): void {
		switch (request.method) {
			case "session/request_permission":
				this.handlePermissionRequest(request);
				return;
			case "fs/read_text_file":
				void this.handleReadTextFile(request);
				return;
			case "fs/write_text_file":
				void this.handleWriteTextFile(request);
				return;
			default:
				this.connection.sendError(
					request.id,
					-32601,
					`Method not found: ${request.method}`,
				);
		}
	}

	private handlePermissionRequest(request: JsonRpcRequest): void {
		const params = request.params as AcpRequestPermissionParams | undefined;
		const ctx = params?.sessionId
			? this.byAcpId.get(params.sessionId)
			: undefined;
		if (
			!params ||
			!ctx?.activeEmitter ||
			!ctx.activeRequestId ||
			this.turns.isAbortRequested(ctx.helmorSessionId)
		) {
			// Can't surface it — cancel so the agent isn't left blocking.
			this.connection.sendResponse(request.id, {
				outcome: { outcome: "cancelled" },
			});
			return;
		}
		const options = params.options ?? [];
		// Kimi reuses the permission channel for AskUserQuestion / plan review;
		// those must surface every option, not be flattened to Allow/Deny.
		if (isSelectionRequest(options)) {
			this.handleSelectionRequest(request, params, ctx, options);
			return;
		}
		const permissionId = `${KIMI_PERMISSION_PREFIX}${request.id}`;
		this.pendingPermissions.set(permissionId, {
			ctx,
			jsonRpcId: request.id,
			options,
		});
		const tool = params.toolCall ?? {};
		const toolName = tool.title || tool.kind || "tool";
		const toolInput =
			tool.rawInput && typeof tool.rawInput === "object"
				? (tool.rawInput as Record<string, unknown>)
				: {};
		ctx.activeEmitter.permissionRequest(
			ctx.activeRequestId,
			permissionId,
			toolName,
			toolInput,
			tool.title,
			undefined,
		);
	}

	/** Surface a selection prompt through the unified userInputRequest UI so
	 *  the user picks an actual option (Allow/Deny would silently pick the
	 *  first answer of a question, or "Revise" instead of "Reject" on a plan). */
	private handleSelectionRequest(
		request: JsonRpcRequest,
		params: AcpRequestPermissionParams,
		ctx: SessionCtx,
		options: AcpRequestPermissionParams["options"],
	): void {
		const userInputId = `${KIMI_PERMISSION_PREFIX}q-${request.id}`;
		this.pendingQuestions.set(userInputId, {
			ctx,
			jsonRpcId: request.id,
			options,
		});
		const tool = params.toolCall ?? {};
		const question =
			toolContentText(tool.content) || tool.title || "Kimi needs your input";
		ctx.activeEmitter?.userInputRequest(
			ctx.activeRequestId ?? "",
			userInputId,
			"Kimi",
			question,
			{
				kind: "ask-user-question",
				questions: [
					{
						question,
						header: tool.title ?? "Kimi",
						options: options.map((o) => ({ label: o.name ?? o.optionId })),
						multiSelect: false,
					},
				],
			},
		);
	}

	private async handleReadTextFile(request: JsonRpcRequest): Promise<void> {
		const params = request.params as AcpReadTextFileParams | undefined;
		try {
			if (!params?.path) throw new Error("missing path");
			const raw = await readFile(params.path, "utf8");
			let content = raw;
			if (params.line || params.limit) {
				const lines = raw.split(/\r?\n/);
				const start = Math.max((params.line ?? 1) - 1, 0);
				const end = params.limit ? start + params.limit : undefined;
				content = lines.slice(start, end).join("\n");
			}
			this.connection.sendResponse(request.id, { content });
		} catch (error) {
			this.connection.sendError(
				request.id,
				isFileNotFound(error) ? -32002 : -32603,
				errorMessage(error),
			);
		}
	}

	private async handleWriteTextFile(request: JsonRpcRequest): Promise<void> {
		const params = request.params as AcpWriteTextFileParams | undefined;
		try {
			if (!params?.path) throw new Error("missing path");
			await mkdir(dirname(params.path), { recursive: true });
			await writeFile(params.path, params.content ?? "", "utf8");
			this.connection.sendResponse(request.id, {});
		} catch (error) {
			this.connection.sendError(request.id, -32603, errorMessage(error));
		}
	}

	private cancelTurn(sessionId: string): void {
		const ctx = this.sessions.get(sessionId);
		if (!ctx?.acpSessionId) return;
		// Best-effort ACP cancel — kimi then resolves the prompt `cancelled`.
		try {
			this.connection.writeNotification("session/cancel", {
				sessionId: ctx.acpSessionId,
			});
		} catch (error) {
			logger.debug("kimi session/cancel failed", errorDetails(error));
		}
		this.cancelPendingPrompts(ctx);
		ctx.settleCancelledTurn?.();
	}

	/** ACP: a cancelled turn MUST settle outstanding `session/request_permission`
	 *  requests with a `cancelled` outcome — the agent blocks awaiting each. */
	private cancelPendingPrompts(ctx: SessionCtx): void {
		for (const [id, p] of this.pendingPermissions) {
			if (p.ctx !== ctx) continue;
			this.pendingPermissions.delete(id);
			this.connection.sendResponse(p.jsonRpcId, {
				outcome: { outcome: "cancelled" },
			});
		}
		for (const [id, p] of this.pendingQuestions) {
			if (p.ctx !== ctx) continue;
			this.pendingQuestions.delete(id);
			this.connection.sendResponse(p.jsonRpcId, {
				outcome: { outcome: "cancelled" },
			});
		}
	}

	private onConnectionExit(code: number | null, signal: string | null): void {
		logger.debug("kimi acp exited", { code, signal });
		// The child is gone: every in-flight `sendRequest` was just rejected,
		// so each live turn settles exactly once through its own rejection
		// path (a failAll here would double-fire the terminal events). The
		// pending agent→client prompts need no response — the requester died.
		this.sessions.clear();
		this.byAcpId.clear();
		this.pendingPermissions.clear();
		this.pendingQuestions.clear();
		this.cachedCommands = [];
	}

	private failTurn(
		sessionId: string,
		requestId: string,
		emitter: SidecarEmitter,
		message: string,
	): void {
		if (!this.turns.isAbortRequested(sessionId)) {
			emitter.error(requestId, message);
			emitter.end(requestId);
		}
		this.turns.end(sessionId, requestId);
	}

	// Title generation flows through claude/codex/cursor (see index.ts title
	// order) — this is only a defensive fallback if ever invoked directly.
	async generateTitle(
		requestId: string,
		userMessage: string,
		_branchRenamePrompt: string | null,
		emitter: SidecarEmitter,
		_timeoutMs?: number,
		_options?: GenerateTitleOptions,
	): Promise<void> {
		const firstLine =
			userMessage.split("\n").find((l) => l.trim()) ?? userMessage;
		const { title } = parseTitleAndBranch(`title: ${firstLine}`);
		emitter.titleGenerated(requestId, title, undefined);
	}

	async listSlashCommands(
		_params: ListSlashCommandsParams,
	): Promise<readonly SlashCommandInfo[]> {
		return [...this.cachedCommands].sort((a, b) =>
			a.name.localeCompare(b.name),
		);
	}

	async listModels(): Promise<readonly ProviderModelInfo[]> {
		return listProviderModels("kimi");
	}

	async stopSession(sessionId: string): Promise<void> {
		// Emits `aborted` instantly + runs `cancelTurn` (cancel notification,
		// pending-prompt cleanup, local turn settle).
		this.turns.requestStop(sessionId);
	}

	// ACP allows only one foreground turn per session; mid-turn injection isn't
	// supported (capability `supports_steer: false`).
	async steer(): Promise<boolean> {
		return false;
	}

	async shutdown(): Promise<void> {
		for (const ctx of this.sessions.values()) {
			this.turns.requestStop(ctx.helmorSessionId);
		}
		this.sessions.clear();
		this.byAcpId.clear();
		this.pendingPermissions.clear();
		this.pendingQuestions.clear();
		this.connection.kill();
	}
}

/** allow → an allow_* option (prefer once); deny → a reject_* option or null. */
function selectPermissionOption(
	options: AcpRequestPermissionParams["options"],
	behavior: "allow" | "deny",
): string | null {
	const byKind = (k: string) => options.find((o) => o.kind === k)?.optionId;
	if (behavior === "allow") {
		return (
			byKind("allow_once") ??
			byKind("allow_always") ??
			options[0]?.optionId ??
			null
		);
	}
	return byKind("reject_once") ?? byKind("reject_always") ?? null;
}

function isAuthRequired(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const code = (error as { code?: unknown }).code;
	if (code === AUTH_REQUIRED_CODE) return true;
	const message = (error as { message?: unknown }).message;
	return (
		typeof message === "string" && /authentication required/i.test(message)
	);
}

function isFileNotFound(error: unknown): boolean {
	return (
		!!error &&
		typeof error === "object" &&
		(error as { code?: unknown }).code === "ENOENT"
	);
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}
