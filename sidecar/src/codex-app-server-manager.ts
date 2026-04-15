/**
 * SessionManager backed by the Codex App Server (JSON-RPC over stdin/stdout).
 *
 * Each Helmor session maps to one `codex app-server` child process.
 * Events are stripped of their JSON-RPC envelope and forwarded as flat
 * JSON via `emitter.passthrough()`. All semantic normalization (camelCase,
 * delta accumulation) happens downstream in Rust.
 */

import crypto from "node:crypto";
import {
	CodexAppServer,
	type JsonRpcNotification,
	type JsonRpcRequest,
} from "./codex-app-server.js";
import type { SidecarEmitter } from "./emitter.js";
import { parseImageRefs } from "./images.js";
import { errorDetails, logger } from "./logger.js";
import {
	formatModelLabel,
	type ListSlashCommandsParams,
	type ProviderModelInfo,
	type SendMessageParams,
	type SessionManager,
	type SlashCommandInfo,
	sortModelsByVersion,
} from "./session-manager.js";
import {
	buildTitlePrompt,
	parseTitleAndBranch,
	TITLE_GENERATION_TIMEOUT_MS,
} from "./title.js";

const CODEX_BIN_PATH = process.env.HELMOR_CODEX_BIN_PATH || "codex";

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

// ---------------------------------------------------------------------------
// Per-session context
// ---------------------------------------------------------------------------

interface PendingApproval {
	jsonRpcId: string | number;
	sessionId: string;
}

interface AppServerContext {
	server: CodexAppServer;
	providerThreadId: string | null;
	activeTurnId: string | null;
	turnResolve: (() => void) | null;
	turnReject: ((err: Error) => void) | null;
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
	private pendingUserInputs = new Map<string, PendingApproval>();

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

	/** Called by index.ts when Rust responds to a user-input request. */
	resolveUserInput(userInputId: string, answers: unknown): void {
		const pending = this.pendingUserInputs.get(userInputId);
		if (!pending) return;
		this.pendingUserInputs.delete(userInputId);

		const ctx = this.sessions.get(pending.sessionId);
		if (!ctx) return;

		ctx.server.sendResponse(pending.jsonRpcId, { answers });
		logger.debug(`Codex user-input resolved`, { userInputId });
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
		} = params;
		const workDir = cwd ?? process.cwd();

		logger.debug(`[${requestId}] codex sendMessage`, {
			sessionId,
			model: model ?? "(default)",
			cwd: workDir,
			resume: resume ?? "(none)",
			promptLen: prompt.length,
		});

		const ctx = await this.ensureContext(
			sessionId,
			workDir,
			resume,
			model,
			permissionMode,
		);

		const input = buildTurnInput(prompt);
		const turnStartParams: Record<string, unknown> = {
			threadId: ctx.providerThreadId,
			input,
		};
		if (model) turnStartParams.model = model;
		if (effortLevel) turnStartParams.effort = effortLevel;
		const codexMode = toCodexCollaborationMode(permissionMode, model);
		if (codexMode) turnStartParams.collaborationMode = codexMode;
		const codexApproval = toCodexApprovalPolicy(permissionMode);
		if (codexApproval) turnStartParams.approvalPolicy = codexApproval;

		let aborted = false;

		return new Promise<void>((resolve, reject) => {
			ctx.turnResolve = resolve;
			ctx.turnReject = (err) => {
				aborted = true;
				reject(err);
			};

			const emit = (event: object) => {
				emitter.passthrough(requestId, event);
			};

			const handleNotification = (n: JsonRpcNotification) => {
				const flat = flattenNotification(n, ctx.providerThreadId);
				emit(flat);

				if (n.method === "thread/started") {
					const threadId = deepGet(n.params, "thread", "id");
					if (typeof threadId === "string") {
						ctx.providerThreadId = threadId;
					}
				}

				if (n.method === "turn/started") {
					const turnId = deepGet(n.params, "turn", "id");
					if (typeof turnId === "string") {
						ctx.activeTurnId = turnId;
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
			};

			const handleRequest = (req: JsonRpcRequest) => {
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
					const questions = Array.isArray(p.questions) ? p.questions : [];

					this.pendingUserInputs.set(userInputId, {
						jsonRpcId: req.id,
						sessionId,
					});

					emitter.userInputRequest(requestId, userInputId, questions);
					logger.debug(`Codex user-input request`, { userInputId });
					return;
				}
				// Unknown server request — auto-reject
				ctx.server.sendResponse(req.id, undefined);
			};

			ctx.server.setHandlers(handleNotification, handleRequest);
			ctx.server.setActiveRequestId(requestId);

			ctx.server
				.sendRequest("turn/start", turnStartParams)
				.then((response) => {
					const turnId = deepGet(response, "turn", "id");
					if (typeof turnId === "string") {
						ctx.activeTurnId = turnId;
					}
				})
				.catch((err) => {
					logger.error("turn/start failed", errorDetails(err));
					reject(err);
				});
		}).finally(() => {
			if (aborted) {
				emitter.aborted(requestId, "user_requested");
			} else {
				emitter.end(requestId);
			}
		});
	}

	// ── generateTitle ────────────────────────────────────────────────────

	async generateTitle(
		requestId: string,
		userMessage: string,
		emitter: SidecarEmitter,
	): Promise<void> {
		const cwd = process.cwd();
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

		const timeout = setTimeout(
			() => server.kill(),
			TITLE_GENERATION_TIMEOUT_MS,
		);

		try {
			await server.sendRequest("initialize", HELMOR_CLIENT_INFO);
			server.writeNotification("initialized");

			const threadResponse = await server.sendRequest<Record<string, unknown>>(
				"thread/start",
				{},
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

			await server.sendRequest("turn/start", {
				threadId,
				input: [
					{
						type: "text",
						text: buildTitlePrompt(userMessage),
						text_elements: [],
					},
				],
			});

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

			const result = await server.sendRequest<Record<string, unknown>>(
				"skills/list",
				{ cwds: [cwd] },
			);

			return parseSkillsResponse(result, cwd);
		} finally {
			server.kill();
		}
	}

	// ── listModels ───────────────────────────────────────────────────────

	async listModels(): Promise<readonly ProviderModelInfo[]> {
		const cwd = process.cwd();
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

			const result = await server.sendRequest<Record<string, unknown>>(
				"model/list",
				{},
			);

			const models = parseModelListResponse(result);
			logger.info("Codex model/list", { count: models.length });
			return models;
		} finally {
			server.kill();
		}
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
	): Promise<AppServerContext> {
		const existing = this.sessions.get(sessionId);
		if (existing && !existing.server.killed) return existing;

		const server = new CodexAppServer({
			binaryPath: CODEX_BIN_PATH,
			cwd,
			onNotification: () => {},
			onRequest: () => {},
			onExit: () => {
				this.sessions.delete(sessionId);
			},
			onError: (err) => {
				logger.error("codex app-server error", errorDetails(err));
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
				approvalPolicy: toCodexApprovalPolicy(permissionMode) ?? "never",
				sandbox:
					permissionMode === "plan" ? "workspace-write" : "danger-full-access",
			};
			if (model) threadStartParams.model = model;
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
		};

		this.sessions.set(sessionId, ctx);
		return ctx;
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function buildTurnInput(prompt: string): Array<Record<string, unknown>> {
	const { text, imagePaths } = parseImageRefs(prompt);
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

function parseSkillsResponse(result: unknown, cwd: string): SlashCommandInfo[] {
	if (!result || typeof result !== "object") return [];
	const r = result as Record<string, unknown>;

	let skills: unknown[] = [];
	const dataBuckets = Array.isArray(r.data) ? r.data : [];
	const bucket = dataBuckets.find(
		(b: unknown) =>
			typeof b === "object" &&
			b !== null &&
			(b as Record<string, unknown>).cwd === cwd,
	);
	if (bucket && typeof bucket === "object") {
		const s = (bucket as Record<string, unknown>).skills;
		if (Array.isArray(s)) skills = s;
	}
	if (skills.length === 0 && Array.isArray(r.skills)) {
		skills = r.skills;
	}

	return skills.flatMap((s) => {
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
}

/** Parse the Codex model/list RPC response.
 *  Official format: `{data: [{id, model, displayName, hidden, isDefault,
 *  supportedReasoningEfforts, defaultReasoningEffort, ...}]}` */
function parseModelListResponse(result: unknown): ProviderModelInfo[] {
	if (!result || typeof result !== "object") return [];
	const r = result as Record<string, unknown>;
	const entries = Array.isArray(r.data)
		? r.data
		: Array.isArray(r.models)
			? r.models
			: [];

	const models = entries.flatMap((m) => {
		if (!m || typeof m !== "object") return [];
		const entry = m as Record<string, unknown>;
		if (entry.hidden === true) return [];

		const id =
			typeof entry.id === "string"
				? entry.id
				: typeof entry.model === "string"
					? entry.model
					: null;
		if (!id) return [];

		const rawLabel =
			typeof entry.displayName === "string"
				? entry.displayName
				: typeof entry.name === "string"
					? entry.name
					: id;
		const label = formatModelLabel(id, rawLabel);

		const cliModel = typeof entry.model === "string" ? entry.model : id;

		// Each entry is {reasoningEffort: string, description: string}
		const rawEfforts = Array.isArray(entry.supportedReasoningEfforts)
			? entry.supportedReasoningEfforts
			: [];
		const parsedEfforts = rawEfforts
			.map((e: unknown) => {
				if (typeof e === "string") return e;
				if (e && typeof e === "object")
					return (e as Record<string, unknown>).reasoningEffort;
				return null;
			})
			.filter((e): e is string => typeof e === "string");
		const effortLevels =
			parsedEfforts.length > 0
				? parsedEfforts
				: ["low", "medium", "high", "xhigh"];

		return [{ id, label, cliModel, effortLevels }];
	});
	return sortModelsByVersion(models);
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

/**
 * Map Helmor's permissionMode to Codex's approvalPolicy.
 * "never" = full auto (no approval popups).
 * Only override on non-plan modes — plan mode is read-only by design.
 */
function toCodexApprovalPolicy(
	permissionMode: string | undefined,
): string | undefined {
	if (permissionMode === "bypassPermissions") return "never";
	if (permissionMode === "acceptEdits") return "untrusted";
	// plan mode: don't override — Codex plan mode is inherently read-only
	return undefined;
}
