// SessionManager over opencode's HTTP server. SSE `/event` is directory-scoped,
// so each session subscribes per-directory and we demux by `sessionID`.
// Does NO normalization: forwards events verbatim (namespaced `opencode/<type>`)
// for the Rust accumulator. Only transport + turn lifecycle (idle = turn end).

import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import type {
	FilePartInput,
	OpencodeClient,
	PermissionRuleset,
	TextPartInput,
} from "@opencode-ai/sdk/v2";
import { ActiveTurnRegistry } from "./active-turn-registry.js";
import type { SidecarEmitter } from "./emitter.js";
import { prependLinkedDirectoriesContext } from "./linked-directories-context.js";
import { errorDetails, logger } from "./logger.js";
import { OpencodeServer } from "./opencode-server.js";
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
	parseTitleAndBranchWithDiagnostics,
	TITLE_GENERATION_TIMEOUT_MS,
} from "./title.js";

interface TurnSettle {
	resolve: () => void;
	reject: (err: Error) => void;
}

interface SessionCtx {
	readonly helmorSessionId: string;
	openCodeSessionId: string;
	directory: string;
	activeRequestId: string | null;
	activeEmitter: SidecarEmitter | null;
	settle: TurnSettle | null;
	/** Mutable: replaced with a fresh controller when a stopped session is
	 *  reused, so the next turn's pump subscribes with a live signal. */
	abort: AbortController;
	pumpStarted: boolean;
	/** Client the live pump subscribed with. On `opencode serve` respawn a turn
	 *  gets a new client; we rebind the pump when this no longer matches it. */
	pumpClient?: OpencodeClient;
	/** Last turn's model + effort variant, reused by `steer`. */
	lastModel?: { providerID: string; modelID: string; variant?: string };
	contextTokens: number;
	contextParts: {
		input: number;
		output: number;
		reasoning: number;
		cacheRead: number;
		cacheWrite: number;
	};
	/** childSessionId → parent `task` tool callID (subagent nesting). */
	readonly subtaskParents: Map<string, string>;
	/** This turn runs opencode's read-only `plan` agent — no ExitPlanMode signal,
	 *  so we capture the assistant text and re-surface it as a plan-review card. */
	planMode: boolean;
	/** Per-turn plan text capture (reset at turn start). */
	readonly planCapture: PlanCapture;
}

interface OpencodeProviderList {
	readonly all?: ReadonlyArray<{
		readonly id?: string;
		readonly name?: string;
		readonly models?: Record<
			string,
			| {
					readonly id?: string;
					readonly name?: string;
					// Effort tiers keyed by name; non-empty ⟺ effort switch supported.
					readonly variants?: Record<string, unknown>;
			  }
			| undefined
		>;
	}>;
	readonly connected?: ReadonlyArray<string>;
}

// Flatten `provider.list()` to ProviderModelInfo[], keeping ONLY `connected`
// providers (valid auth). Slug = `providerID/modelID`; effortLevels = variant keys.
export function flattenOpencodeModels(
	data: OpencodeProviderList | undefined,
): ProviderModelInfo[] {
	const connected = new Set(data?.connected ?? []);
	const out: ProviderModelInfo[] = [];
	for (const provider of data?.all ?? []) {
		const providerId = provider.id;
		if (!providerId || !connected.has(providerId)) continue;
		const subProvider = (provider.name ?? "").trim();
		for (const model of Object.values(provider.models ?? {})) {
			const modelId = model?.id;
			const name = (model?.name ?? "").trim();
			if (!modelId || !name) continue;
			const slug = `${providerId}/${modelId}`;
			const effortLevels = Object.keys(model?.variants ?? {});
			out.push({
				id: slug,
				label: subProvider ? `${subProvider} · ${name}` : name,
				cliModel: slug,
				...(effortLevels.length > 0 ? { effortLevels } : {}),
			});
		}
	}
	return out.sort((a, b) => a.label.localeCompare(b.label));
}

// ── Plan-mode capture ────────────────────────────────────────────────────────
// opencode's `plan` agent has no ExitPlanMode signal — the plan is just streamed
// assistant text. Capture it and re-emit as `planCaptured` (Claude/Cursor's rail)
// for the plan-review card, suppressing the now-duplicate prose from the stream.

export interface PlanCapture {
	/** messageID → role. opencode can emit a part before its role event, so the
	 *  assistant-vs-user split is resolved at idle, not at part-arrival time. */
	readonly roleByMessageId: Map<string, string>;
	/** partID → text snapshot + owning messageID; insertion order = read order. */
	readonly text: Map<string, { messageId: string; text: string }>;
}

export function newPlanCapture(): PlanCapture {
	return { roleByMessageId: new Map(), text: new Map() };
}

export function resetPlanCapture(capture: PlanCapture): void {
	capture.roleByMessageId.clear();
	capture.text.clear();
}

/** Record a message's role (user or assistant) for the idle-time split. */
export function notePlanMessage(
	capture: PlanCapture,
	info: { role?: string; id?: string } | undefined,
): void {
	if (typeof info?.id === "string" && typeof info.role === "string") {
		capture.roleByMessageId.set(info.id, info.role);
	}
}

/** Suppress all token deltas + text snapshots in plan mode (the user echo is
 *  dropped by the accumulator anyway) and capture them. The assistant/user split
 *  is deferred to assemblePlanText. Returns true when the event is consumed. */
export function capturePlanPart(
	capture: PlanCapture,
	event: { type: string; properties?: Record<string, unknown> },
): boolean {
	// Drop token deltas; the later full-text snapshot is authoritative.
	if (event.type === "message.part.delta") return true;
	if (event.type !== "message.part.updated") return false;
	const part = (
		event.properties as
			| {
					part?: {
						type?: string;
						id?: string;
						messageID?: string;
						text?: string;
					};
			  }
			| undefined
	)?.part;
	if (part?.type !== "text") return false;
	if (typeof part.id === "string" && typeof part.messageID === "string") {
		capture.text.set(part.id, {
			messageId: part.messageID,
			text: typeof part.text === "string" ? part.text : "",
		});
	}
	return true;
}

/** Concatenate captured assistant text in arrival order (user echo excluded). */
export function assemblePlanText(capture: PlanCapture): string {
	const out: string[] = [];
	for (const { messageId, text } of capture.text.values()) {
		if (capture.roleByMessageId.get(messageId) === "assistant") out.push(text);
	}
	return out.join("\n\n").trim();
}

/** First assistant message id with plan text — seeds the synthetic tool-use id. */
export function planMessageId(capture: PlanCapture): string | null {
	for (const { messageId } of capture.text.values()) {
		if (capture.roleByMessageId.get(messageId) === "assistant")
			return messageId;
	}
	return null;
}

const IMAGE_MIME_BY_EXT: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
	svg: "image/svg+xml",
	heic: "image/heic",
};

function imageMime(path: string): string {
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	return IMAGE_MIME_BY_EXT[ext] ?? "image/png";
}

export function buildImageParts(images: readonly string[]): FilePartInput[] {
	return images.map((path) => ({
		type: "file",
		mime: imageMime(path),
		filename: basename(path),
		url: pathToFileURL(path).href,
	}));
}

export function buildPromptParts(
	prompt: string,
	images: readonly string[],
): Array<TextPartInput | FilePartInput> {
	const parts: Array<TextPartInput | FilePartInput> = [];
	if (prompt.trim().length > 0) {
		parts.push({ type: "text", text: prompt });
	}
	parts.push(...buildImageParts(images));
	// opencode requires at least one part; fall back to the raw prompt.
	if (parts.length === 0) parts.push({ type: "text", text: prompt });
	return parts;
}

// Leading `/<name> <args>`; no match for plain prompts, bare `/`, or `a/b`.
const SLASH_COMMAND_RE = /^\/([a-zA-Z0-9][\w-]*)(?:\s+([\s\S]*))?$/;

export function parseSlashCommand(
	prompt: string,
): { command: string; arguments: string } | null {
	const match = prompt.trim().match(SLASH_COMMAND_RE);
	const name = match?.[1];
	if (!name) return null;
	return { command: name, arguments: (match[2] ?? "").trim() };
}

export function parseModelSlug(
	slug: string | undefined,
): { providerID: string; modelID: string; variant?: string } | undefined {
	if (typeof slug !== "string") return undefined;
	const trimmed = slug.trim();
	const sep = trimmed.indexOf("/");
	if (sep <= 0 || sep === trimmed.length - 1) return undefined;
	return {
		providerID: trimmed.slice(0, sep),
		modelID: trimmed.slice(sep + 1),
	};
}

const OPENCODE_PERMISSION_PREFIX = "opencode-";

// opencode always runs full-access at the permission layer; plan mode's
// read-only behavior comes entirely from selecting the `plan` agent.
export function buildPermissionRules(): PermissionRuleset {
	return [{ permission: "*", pattern: "*", action: "allow" }];
}

// opencode pins permission rules on the session at creation. A session created
// by an older Helmor (default/acceptEdits → ask rules) keeps them on resume, so
// full access wouldn't take effect. Reassert the current rules when reusing an
// existing session. Best-effort — a failed update must not block the turn.
export async function reapplySessionPermission(
	client: OpencodeClient,
	sessionID: string,
	directory: string,
): Promise<void> {
	try {
		await client.session.update({
			sessionID,
			directory,
			permission: buildPermissionRules(),
		});
	} catch (error) {
		logger.debug("opencode permission reapply failed", errorDetails(error));
	}
}

// `percentage` is 0 when the model's context limit is unknown; zero buckets dropped.
export function buildContextUsageMeta(input: {
	modelId: string;
	usedTokens: number;
	maxTokens: number;
	cost: number;
	parts: {
		input: number;
		output: number;
		reasoning: number;
		cacheRead: number;
		cacheWrite: number;
	};
}): string {
	const { modelId, usedTokens, maxTokens, cost, parts } = input;
	const percentage =
		maxTokens > 0 ? Math.round((usedTokens / maxTokens) * 100) : 0;
	const categories = [
		{ name: "Input", tokens: parts.input },
		{ name: "Output", tokens: parts.output },
		{ name: "Reasoning", tokens: parts.reasoning },
		{ name: "Cache read", tokens: parts.cacheRead },
		{ name: "Cache write", tokens: parts.cacheWrite },
	].filter((c) => c.tokens > 0);
	return JSON.stringify({
		modelId,
		usedTokens,
		maxTokens,
		percentage,
		cost,
		categories,
	});
}

export class OpencodeSessionManager implements SessionManager {
	// The shared server's process death is a terminal signal for every
	// in-flight turn bound to it — settle them so `await turnDone` can't hang.
	private readonly server = new OpencodeServer(() => this.handleServerExit());
	private readonly sessions = new Map<string, SessionCtx>();
	private readonly byOpencodeId = new Map<string, SessionCtx>();
	private readonly turns = new ActiveTurnRegistry();
	/** `provider/model` slug → context-window size, for the usage ring. */
	private readonly modelContextLimits = new Map<string, number>();
	private readonly pendingPermissions = new Map<
		string,
		{ ctx: SessionCtx; requestID: string }
	>();
	private readonly pendingQuestions = new Map<
		string,
		{ ctx: SessionCtx; requestID: string; questions: OpencodeQuestion[] }
	>();

	resolveUserInput(
		userInputId: string,
		resolution: UserInputResolution,
	): boolean {
		const pending = this.pendingQuestions.get(userInputId);
		if (!pending) return false;
		this.pendingQuestions.delete(userInputId);
		void this.replyQuestion(pending, resolution);
		return true;
	}

	resolvePermission(permissionId: string, behavior: "allow" | "deny"): void {
		const pending = this.pendingPermissions.get(permissionId);
		if (!pending) return;
		this.pendingPermissions.delete(permissionId);
		const reply = behavior === "allow" ? "once" : "reject";
		void this.replyPermission(pending.ctx, pending.requestID, reply);
	}

	private async replyPermission(
		ctx: SessionCtx,
		requestID: string,
		reply: "once" | "always" | "reject",
	): Promise<void> {
		try {
			const { client } = await this.server.start(process.env);
			await client.permission.reply({
				requestID,
				reply,
				directory: ctx.directory,
			});
		} catch (error) {
			logger.debug("opencode permission.reply failed", errorDetails(error));
		}
	}

	private async replyQuestion(
		pending: {
			ctx: SessionCtx;
			requestID: string;
			questions: OpencodeQuestion[];
		},
		resolution: UserInputResolution,
	): Promise<void> {
		try {
			const { client } = await this.server.start(process.env);
			if (resolution.action === "submit") {
				const answers = mapQuestionAnswers(
					pending.questions,
					resolution.content,
				);
				await client.question.reply({
					requestID: pending.requestID,
					answers,
					directory: pending.ctx.directory,
				});
			} else {
				await client.question.reject({
					requestID: pending.requestID,
					directory: pending.ctx.directory,
				});
			}
			// Mark the resolved Q&A in the live stream so Rust persists the
			// transcript card at this position (see emitter doc).
			const { ctx } = pending;
			if (
				ctx.activeEmitter &&
				ctx.activeRequestId &&
				resolution.action !== "cancel"
			) {
				ctx.activeEmitter.userQuestionResolved(
					ctx.activeRequestId,
					pending.requestID,
					"OpenCode",
					pending.questions as unknown as Array<Record<string, unknown>>,
					resolution.action === "submit"
						? (resolution.content.answers as
								| Record<string, unknown>
								| undefined)
						: undefined,
					resolution.action,
				);
			}
		} catch (error) {
			logger.debug("opencode question reply failed", errorDetails(error));
		}
	}

	private async sessionExists(
		client: OpencodeClient,
		sessionID: string,
		directory: string,
	): Promise<boolean> {
		try {
			const got = await client.session.get({ sessionID, directory });
			return Boolean(got.data?.id);
		} catch {
			return false;
		}
	}

	async sendMessage(
		requestId: string,
		params: SendMessageParams,
		emitter: SidecarEmitter,
	): Promise<void> {
		// Register before startup (server.start + session.create) so a Stop
		// pressed mid-startup emits `aborted` instantly via `tearDownTurn`.
		this.turns.begin(params.sessionId, requestId, emitter, () =>
			this.tearDownTurn(params.sessionId),
		);
		let handle: Awaited<ReturnType<OpencodeServer["start"]>>;
		try {
			handle = await this.server.start(process.env);
		} catch (error) {
			if (!this.turns.isAbortRequested(params.sessionId)) {
				emitter.error(requestId, `opencode: ${errorMessage(error)}`);
				emitter.end(requestId);
			}
			this.turns.end(params.sessionId);
			return;
		}
		const { client } = handle;
		const directory = params.cwd ?? process.cwd();

		// Stop pressed during server startup — `requestStop` already emitted
		// `aborted`; clear the turn and bail before creating a session.
		if (this.turns.isAbortRequested(params.sessionId)) {
			this.turns.end(params.sessionId);
			return;
		}

		// Reuse cached session, else resume an existing id, else create fresh.
		let ctx = this.sessions.get(params.sessionId);
		if (!ctx) {
			let openCodeSessionId: string | null = null;
			const resumeId = params.resume?.trim();
			if (resumeId && (await this.sessionExists(client, resumeId, directory))) {
				openCodeSessionId = resumeId;
				// A resumed session may carry stale (older-version) permission
				// rules — reassert full access so non-plan turns aren't gated.
				await reapplySessionPermission(client, resumeId, directory);
			} else {
				// Stale/absent id → create fresh so old chats recover.
				if (resumeId) {
					logger.debug(
						`opencode resume ${resumeId} not found; creating a fresh session`,
					);
				}
				try {
					const created = await client.session.create({
						directory,
						title: `Helmor ${params.sessionId}`,
						permission: buildPermissionRules(),
					});
					openCodeSessionId = created.data?.id ?? null;
				} catch (error) {
					if (!this.turns.isAbortRequested(params.sessionId)) {
						emitter.error(requestId, `opencode: ${errorMessage(error)}`);
						emitter.end(requestId);
					}
					this.turns.end(params.sessionId);
					return;
				}
			}
			if (!openCodeSessionId) {
				if (!this.turns.isAbortRequested(params.sessionId)) {
					emitter.error(requestId, "opencode: session.create returned no id");
					emitter.end(requestId);
				}
				this.turns.end(params.sessionId);
				return;
			}
			ctx = {
				helmorSessionId: params.sessionId,
				openCodeSessionId,
				directory,
				activeRequestId: null,
				activeEmitter: null,
				settle: null,
				abort: new AbortController(),
				pumpStarted: false,
				subtaskParents: new Map(),
				planMode: false,
				planCapture: newPlanCapture(),
				contextTokens: 0,
				contextParts: {
					input: 0,
					output: 0,
					reasoning: 0,
					cacheRead: 0,
					cacheWrite: 0,
				},
			};
			this.sessions.set(params.sessionId, ctx);
			this.byOpencodeId.set(openCodeSessionId, ctx);
			// Synthetic init — Rust persists session_id as provider_session_id.
			emitter.passthrough(requestId, {
				type: "opencode/session_init",
				session_id: openCodeSessionId,
				...(params.model ? { model: params.model } : {}),
			});
		}

		// Stop pressed during session create/resume — `requestStop` already
		// emitted `aborted`; clear the turn and bail.
		if (this.turns.isAbortRequested(params.sessionId)) {
			this.turns.end(params.sessionId);
			return;
		}

		ctx.directory = directory;
		ctx.activeRequestId = requestId;
		ctx.activeEmitter = emitter;
		ctx.planMode = params.permissionMode === "plan";
		resetPlanCapture(ctx.planCapture);
		this.ensureSessionPump(client, ctx);

		const turnDone = new Promise<void>((resolve, reject) => {
			ctx!.settle = { resolve, reject };
		});

		const model = parseModelSlug(params.model);
		// Stray/unknown variant resolves to no-op, so safe for no-effort models.
		const effort = params.effortLevel?.trim();
		if (model && effort) model.variant = effort;
		if (model) ctx.lastModel = model;
		// Plan mode runs opencode's read-only `plan` agent; its text is captured at
		// idle and re-surfaced as a plan-review card (see ctx.planMode below).
		const planAgent = ctx.planMode ? "plan" : undefined;
		// `/compact` uses session.summarize (V2 compact is still a 503 stub in
		// 1.16.x); it BLOCKS until idle and requires providerID/modelID.
		const isCompact = params.prompt.trim() === "/compact";
		const compactModel = model ?? ctx.lastModel;
		// `/command` goes through the command endpoint (server-side expansion);
		// falls back to a normal prompt for unknown names.
		const command = isCompact
			? null
			: await this.resolveSlashCommand(client, directory, params.prompt);
		try {
			if (isCompact) {
				if (!compactModel) {
					throw new Error("select a model before /compact");
				}
				await client.session.summarize({
					sessionID: ctx.openCodeSessionId,
					directory,
					providerID: compactModel.providerID,
					modelID: compactModel.modelID,
				});
			} else if (command) {
				await client.session.command({
					sessionID: ctx.openCodeSessionId,
					directory,
					command: command.command,
					arguments: command.arguments,
					...(params.model ? { model: params.model } : {}),
					...(effort ? { variant: effort } : {}),
					parts: buildImageParts(params.images),
				});
			} else {
				await client.session.promptAsync({
					sessionID: ctx.openCodeSessionId,
					directory,
					...(model
						? {
								model: { providerID: model.providerID, modelID: model.modelID },
							}
						: {}),
					// Effort is a TOP-LEVEL variant; promptAsync ignores a nested model.variant.
					...(effort ? { variant: effort } : {}),
					...(planAgent ? { agent: planAgent } : {}),
					// opencode has no additional-directories API param, so tell the
					// model about /add-dir linked dirs in-prompt (it reaches them via
					// absolute paths; bypass mode already allows external_directory).
					parts: buildPromptParts(
						prependLinkedDirectoriesContext(
							params.prompt,
							params.additionalDirectories,
						),
						params.images,
					),
				});
			}
		} catch (error) {
			ctx.settle = null;
			ctx.activeRequestId = null;
			ctx.activeEmitter = null;
			if (!this.turns.isAbortRequested(params.sessionId)) {
				emitter.error(requestId, `opencode: ${errorMessage(error)}`);
				emitter.end(requestId);
			}
			this.turns.end(params.sessionId);
			return;
		}

		let turnError: Error | null = null;
		try {
			await turnDone;
		} catch (error) {
			turnError = error instanceof Error ? error : new Error(String(error));
		} finally {
			ctx.settle = null;
			ctx.activeRequestId = null;
			ctx.activeEmitter = null;
		}

		// Stop pressed — `requestStop` already emitted the terminal `aborted`.
		if (this.turns.isAbortRequested(params.sessionId)) {
			this.turns.end(params.sessionId);
			return;
		}

		if (turnError) {
			emitter.error(requestId, `opencode: ${turnError.message}`);
		} else if (ctx.planMode) {
			// Re-surface the captured plan as a plan-review card (lands after the
			// turn's prose, before `end`) so the Implement / Request-Changes CTA shows.
			const planText = assemblePlanText(ctx.planCapture);
			if (planText) {
				emitter.planCaptured(
					requestId,
					`opencode-plan-${planMessageId(ctx.planCapture) ?? requestId}`,
					planText,
				);
			}
		}
		// Emit BEFORE `end`: Rust's stream loop breaks on the terminal event.
		await this.emitContextUsage(ctx, requestId, emitter);
		// Re-check: a Stop landing during the await above already emitted the
		// terminal `aborted`, so skip `end` to avoid a double terminal.
		if (!this.turns.isAbortRequested(params.sessionId)) {
			emitter.end(requestId);
		}
		this.turns.end(params.sessionId);
	}

	private ensureSessionPump(client: OpencodeClient, ctx: SessionCtx): void {
		// Already pumping on the SAME server → reuse it.
		if (ctx.pumpStarted && ctx.pumpClient === client) return;
		// Server respawned → new client; tear down the old pump (dead socket) first.
		if (ctx.pumpStarted && ctx.pumpClient !== client) {
			ctx.abort.abort();
			ctx.pumpStarted = false;
		}
		// A stopped/torn-down session left `ctx.abort` aborted; swap in a fresh one
		// so the reused turn's pump subscribes with a live signal.
		if (ctx.abort.signal.aborted) ctx.abort = new AbortController();
		ctx.pumpStarted = true;
		ctx.pumpClient = client;
		void this.runSessionPump(client, ctx);
	}

	private async runSessionPump(
		client: OpencodeClient,
		ctx: SessionCtx,
	): Promise<void> {
		// Capture THIS pump's controller — `ctx.abort` may be swapped out by a
		// concurrent reuse, and we must check the signal we actually subscribed
		// with, not whatever is current when the loop unwinds.
		const abort = ctx.abort;
		try {
			const subscription = await client.event.subscribe(
				{ directory: ctx.directory },
				{ signal: abort.signal },
			);
			for await (const event of subscription.stream) {
				this.handleEvent(ctx, event as OpencodeEvent);
			}
			// Clean exit (server closed the SSE) WITHOUT an intentional stop:
			// the turn will never see `session.idle`, so settle it as an error
			// instead of leaving `await turnDone` pending forever.
			if (!abort.signal.aborted) {
				ctx.settle?.reject(
					new Error("opencode event stream ended before the turn finished"),
				);
			}
		} catch (error) {
			if (abort.signal.aborted) return;
			logger.error("opencode session pump failed", errorDetails(error));
			ctx.settle?.reject(new Error("opencode event stream disconnected"));
		} finally {
			// Only clear the flag if we still own the current controller — a
			// reuse may have already started a replacement pump.
			if (ctx.abort === abort) ctx.pumpStarted = false;
		}
	}

	/**
	 * The shared opencode server process exited. Every session bound to it has
	 * a dead SSE + dead provider state, so reject any in-flight turn rather
	 * than let `await turnDone` hang. A later turn restarts the server (via
	 * `server.start()`) and a fresh pump.
	 */
	private handleServerExit(): void {
		for (const ctx of this.sessions.values()) {
			ctx.settle?.reject(new Error("opencode server exited unexpectedly"));
			// Tear down the pump bound to the dead server (its SSE may hang, leaving
			// `pumpStarted` stuck true); the next turn rebinds to the respawned one.
			ctx.abort.abort();
			ctx.pumpStarted = false;
		}
	}

	private handleEvent(ctx: SessionCtx, event: OpencodeEvent): void {
		// Demux sibling sessions; keep only child sessions of this turn's `task`.
		const evSid = event.properties?.sessionID;
		if (evSid !== ctx.openCodeSessionId) {
			this.forwardSubtaskEvent(ctx, event, evSid);
			return;
		}

		// A `task` tool part names its child session; register it for routing.
		if (event.type === "message.part.updated") {
			const part = (
				event.properties as { part?: OpencodeToolPartLike } | undefined
			)?.part;
			if (part?.type === "tool" && part.tool === "task" && part.callID) {
				const childSid = part.state?.metadata?.sessionId;
				if (typeof childSid === "string" && childSid) {
					ctx.subtaskParents.set(childSid, part.callID);
				}
			}
		}

		// Track context size for the usage ring (input+output+reasoning+cache).
		if (event.type === "message.updated") {
			const info = (
				event.properties as
					| { info?: OpencodeMessageInfo & { id?: string } }
					| undefined
			)?.info;
			if (ctx.planMode) notePlanMessage(ctx.planCapture, info);
			const t = info?.tokens;
			if (info?.role === "assistant" && t && (t.output ?? 0) > 0) {
				ctx.contextParts = {
					input: t.input ?? 0,
					output: t.output ?? 0,
					reasoning: t.reasoning ?? 0,
					cacheRead: t.cache?.read ?? 0,
					cacheWrite: t.cache?.write ?? 0,
				};
				ctx.contextTokens =
					ctx.contextParts.input +
					ctx.contextParts.output +
					ctx.contextParts.reasoning +
					ctx.contextParts.cacheRead +
					ctx.contextParts.cacheWrite;
			}
		}

		// Approval / user-input ride the typed emitter, not the content stream.
		switch (event.type) {
			case "permission.asked":
				this.handlePermissionAsked(ctx, event);
				return;
			case "question.asked":
				this.handleQuestionAsked(ctx, event);
				return;
			case "permission.replied":
			case "question.replied":
			case "question.rejected":
				// Already resolved (by us or externally) — nothing to forward.
				return;
			default:
				break;
		}

		// Plan mode: capture the plan text and drop it from the live stream so it
		// re-surfaces once as a plan-review card (planCaptured at idle) rather than
		// duplicated as prose. Lifecycle events (session.idle) fall through.
		if (ctx.planMode && capturePlanPart(ctx.planCapture, event)) return;

		// Verbatim passthrough, namespaced. Skip `session.next.*`: it's the
		// redundant raw form of the `message.part.*` the accumulator consumes.
		if (
			ctx.activeEmitter &&
			ctx.activeRequestId &&
			!event.type.startsWith("session.next.")
		) {
			ctx.activeEmitter.passthrough(ctx.activeRequestId, {
				...event.properties,
				type: `opencode/${event.type}`,
				session_id: ctx.openCodeSessionId,
			});
		}

		// Turn lifecycle: only idle = done. `session.error` is a visible provider
		// notice, not a terminal signal; opencode TUI also keeps the turn busy until
		// a later idle/status event arrives.
		switch (event.type) {
			case "session.idle":
				ctx.settle?.resolve();
				break;
			case "session.status":
				if (event.properties?.status?.type === "idle") {
					ctx.settle?.resolve();
				}
				break;
			default:
				break;
		}
	}

	private async emitContextUsage(
		ctx: SessionCtx,
		requestId: string,
		emitter: SidecarEmitter,
	): Promise<void> {
		if (ctx.contextTokens <= 0) return;
		const model = ctx.lastModel;
		const modelId = model ? `${model.providerID}/${model.modelID}` : "";
		const maxTokens = this.modelContextLimits.get(modelId) ?? 0;
		let cost = 0;
		try {
			const { client } = await this.server.start(process.env);
			const got = await client.session.get({
				sessionID: ctx.openCodeSessionId,
				directory: ctx.directory,
			});
			cost = (got.data as { cost?: number } | undefined)?.cost ?? 0;
		} catch (error) {
			logger.debug(
				"opencode context-usage cost fetch failed",
				errorDetails(error),
			);
		}
		emitter.contextUsageUpdated(
			requestId,
			ctx.helmorSessionId,
			buildContextUsageMeta({
				modelId,
				usedTokens: ctx.contextTokens,
				maxTokens,
				cost,
				parts: ctx.contextParts,
			}),
		);
	}

	private captureContextLimits(data: OpencodeProviderList | undefined): void {
		for (const provider of data?.all ?? []) {
			const providerId = provider.id;
			if (!providerId) continue;
			for (const model of Object.values(provider.models ?? {})) {
				const modelId = model?.id;
				const limit = (model as { limit?: { context?: number } } | undefined)
					?.limit?.context;
				if (modelId && typeof limit === "number" && limit > 0) {
					this.modelContextLimits.set(`${providerId}/${modelId}`, limit);
				}
			}
		}
	}

	// Forward a subagent child session's message events tagged with the parent
	// `task` callID. message.updated / message.part.updated / message.part.delta
	// (so subagent text + reasoning stream token-by-token); lifecycle ignored.
	private forwardSubtaskEvent(
		ctx: SessionCtx,
		event: OpencodeEvent,
		childSessionId: string | undefined,
	): void {
		if (!childSessionId || !ctx.activeEmitter || !ctx.activeRequestId) return;
		const parentCallID = ctx.subtaskParents.get(childSessionId);
		if (!parentCallID) return;
		if (
			event.type !== "message.updated" &&
			event.type !== "message.part.updated" &&
			event.type !== "message.part.delta"
		) {
			return;
		}
		ctx.activeEmitter.passthrough(ctx.activeRequestId, {
			...event.properties,
			type: `opencode/subtask.${event.type}`,
			parent_call_id: parentCallID,
			session_id: childSessionId,
		});
	}

	private handlePermissionAsked(ctx: SessionCtx, event: OpencodeEvent): void {
		if (!ctx.activeEmitter || !ctx.activeRequestId) return;
		const props = event.properties ?? {};
		const requestID = typeof props.id === "string" ? props.id : null;
		if (!requestID) return;
		const permission =
			typeof props.permission === "string" ? props.permission : "tool";
		const patterns = Array.isArray(props.patterns)
			? props.patterns.filter((p): p is string => typeof p === "string")
			: [];
		const metadata =
			props.metadata && typeof props.metadata === "object"
				? (props.metadata as Record<string, unknown>)
				: {};
		const permissionId = `${OPENCODE_PERMISSION_PREFIX}${requestID}`;
		this.pendingPermissions.set(permissionId, { ctx, requestID });
		ctx.activeEmitter.permissionRequest(
			ctx.activeRequestId,
			permissionId,
			permission,
			metadata,
			undefined,
			patterns.length > 0 ? patterns.join("\n") : permission,
		);
	}

	private handleQuestionAsked(ctx: SessionCtx, event: OpencodeEvent): void {
		if (!ctx.activeEmitter || !ctx.activeRequestId) return;
		const props = event.properties ?? {};
		const requestID = typeof props.id === "string" ? props.id : null;
		if (!requestID) return;
		const questions: OpencodeQuestion[] = Array.isArray(props.questions)
			? (props.questions as OpencodeQuestion[])
			: [];
		this.pendingQuestions.set(requestID, { ctx, requestID, questions });
		// Raw OpenCode questions (`multiple` flag and all) ride the unified
		// ask-user-question payload — Rust normalizes them into the
		// canonical shape before the frontend sees them.
		ctx.activeEmitter.userInputRequest(
			ctx.activeRequestId,
			requestID,
			"OpenCode",
			questions[0]?.question ?? "OpenCode needs your input",
			{
				kind: "ask-user-question",
				questions: questions as unknown as Array<Record<string, unknown>>,
			},
		);
	}

	private clearPending(ctx: SessionCtx): void {
		for (const [id, p] of this.pendingPermissions) {
			if (p.ctx === ctx) this.pendingPermissions.delete(id);
		}
		for (const [id, p] of this.pendingQuestions) {
			if (p.ctx === ctx) this.pendingQuestions.delete(id);
		}
	}

	// Throwaway session, SYNCHRONOUS session.prompt so text returns inline.
	// Never throws — emits a fallback title on failure.
	async generateTitle(
		requestId: string,
		userMessage: string,
		branchRenamePrompt: string | null,
		emitter: SidecarEmitter,
		timeoutMs?: number,
		options?: GenerateTitleOptions,
	): Promise<void> {
		const generateBranch = options?.generateBranch ?? true;
		const prompt = buildTitlePrompt(
			userMessage,
			branchRenamePrompt,
			generateBranch,
		);
		const timeout = timeoutMs ?? TITLE_GENERATION_TIMEOUT_MS;
		const model = parseModelSlug(options?.model);
		const directory = process.cwd();

		let text = "";
		let client: OpencodeClient | null = null;
		let sessionID: string | null = null;
		try {
			const handle = await this.server.start(process.env);
			client = handle.client;
			const created = await client.session.create({
				directory,
				title: "Helmor title",
				permission: [{ permission: "*", pattern: "*", action: "allow" }],
			});
			sessionID = created.data?.id ?? null;
			if (!sessionID) throw new Error("session.create returned no id");

			const promptCall = client.session.prompt({
				sessionID,
				directory,
				...(model ? { model } : {}),
				parts: [{ type: "text", text: prompt }],
			});
			const res = await Promise.race([
				promptCall,
				new Promise<never>((_, reject) =>
					setTimeout(
						() =>
							reject(
								new Error(
									`opencode title generation timed out after ${timeout}ms`,
								),
							),
						timeout,
					).unref?.(),
				),
			]);
			text = extractTitleText(res.data?.parts);
		} catch (error) {
			logger.debug("opencode generateTitle failed", errorDetails(error));
		} finally {
			if (client && sessionID) {
				const abandoned = client;
				const sid = sessionID;
				void abandoned.session
					.abort({ sessionID: sid, directory })
					.catch(() => {})
					.then(() => abandoned.session.delete({ sessionID: sid, directory }))
					.catch(() => {});
			}
		}

		const { title, branchName } = parseTitleAndBranchWithDiagnostics(
			requestId,
			text,
			{
				...(options?.model ? { model: options.model } : {}),
				generateBranch,
				logError: (message, meta) => logger.error(message, meta),
			},
		);
		emitter.titleGenerated(requestId, title, branchName);
	}

	async listSlashCommands(
		params: ListSlashCommandsParams,
	): Promise<readonly SlashCommandInfo[]> {
		let handle: Awaited<ReturnType<OpencodeServer["start"]>>;
		try {
			handle = await this.server.start(process.env);
		} catch (error) {
			logger.debug(
				"opencode listSlashCommands: server unavailable",
				errorDetails(error),
			);
			return [];
		}
		try {
			const res = await handle.client.command.list({
				directory: params.cwd ?? process.cwd(),
			});
			const out: SlashCommandInfo[] = [];
			const seen = new Set<string>();
			for (const cmd of res.data ?? []) {
				const name = (cmd?.name ?? "").trim();
				if (!name || seen.has(name)) continue;
				seen.add(name);
				out.push({
					name,
					description: (cmd?.description ?? "").trim(),
					argumentHint: undefined,
					source: cmd?.source === "skill" ? "skill" : "builtin",
				});
			}
			out.sort((a, b) => a.name.localeCompare(b.name));
			return out;
		} catch (error) {
			logger.debug("opencode command.list failed", errorDetails(error));
			return [];
		}
	}

	// Returns the command if `/name` is known, else null (sent as a normal prompt).
	private async resolveSlashCommand(
		client: OpencodeClient,
		directory: string,
		prompt: string,
	): Promise<{ command: string; arguments: string } | null> {
		const parsed = parseSlashCommand(prompt);
		if (!parsed) return null;
		try {
			const res = await client.command.list({ directory });
			const known = (res.data ?? []).some(
				(cmd) => (cmd?.name ?? "") === parsed.command,
			);
			return known ? parsed : null;
		} catch (error) {
			logger.debug(
				"opencode command.list (resolve) failed",
				errorDetails(error),
			);
			return null;
		}
	}

	async listModels(opts?: {
		forceReload?: boolean;
	}): Promise<readonly ProviderModelInfo[]> {
		// Restart to re-read global config (its cache TTL is infinity).
		if (opts?.forceReload) void this.server.kill();
		let handle: Awaited<ReturnType<OpencodeServer["start"]>>;
		try {
			handle = await this.server.start(process.env);
		} catch (error) {
			logger.debug(
				"opencode listModels: server unavailable",
				errorDetails(error),
			);
			return [];
		}
		try {
			const res = await handle.client.provider.list({
				directory: process.cwd(),
			});
			this.captureContextLimits(res.data);
			return flattenOpencodeModels(res.data);
		} catch (error) {
			logger.debug("opencode provider.list failed", errorDetails(error));
			return [];
		}
	}

	/** Tear down the active turn: unblock `await turnDone`, abort the pump, and
	 *  fire a best-effort remote abort. No-op if no ctx is registered yet
	 *  (mid-startup) — the post-startup abort checks bail instead. */
	private tearDownTurn(sessionId: string): void {
		const ctx = this.sessions.get(sessionId);
		if (!ctx) return;
		this.clearPending(ctx);
		// Unblock the local turn FIRST — never gate it behind the remote abort
		// RPC, which can hang against a wedged server and strand `await
		// turnDone` forever. Stop the pump too so we don't leak the SSE
		// subscription; reuse swaps in a fresh controller.
		ctx.settle?.resolve();
		ctx.abort.abort();
		ctx.pumpStarted = false;
		// Best-effort remote abort, fire-and-forget: tells opencode to stop
		// server-side work but must not block (or fail) the local teardown.
		void this.server
			.start(process.env)
			.then((handle) =>
				handle.client.session.abort({
					sessionID: ctx.openCodeSessionId,
					directory: ctx.directory,
				}),
			)
			.catch((error) =>
				logger.debug("opencode abort failed", errorDetails(error)),
			);
	}

	async stopSession(sessionId: string): Promise<void> {
		// Emits `aborted` instantly + runs `tearDownTurn` — works at any point,
		// including during the first turn's startup (server.start + create).
		this.turns.requestStop(sessionId);
	}

	// Mid-turn steer via a second promptAsync on the busy session. RPC-first:
	// emit the synthetic user_prompt bubble only after opencode accepts.
	async steer(
		sessionId: string,
		prompt: string,
		files: readonly string[],
		images: readonly string[],
	): Promise<boolean> {
		const ctx = this.sessions.get(sessionId);
		if (!ctx?.activeRequestId || !ctx.activeEmitter || !ctx.settle) {
			return false;
		}
		try {
			const { client } = await this.server.start(process.env);
			await client.session.promptAsync({
				sessionID: ctx.openCodeSessionId,
				directory: ctx.directory,
				...(ctx.lastModel
					? {
							model: {
								providerID: ctx.lastModel.providerID,
								modelID: ctx.lastModel.modelID,
							},
						}
					: {}),
				...(ctx.lastModel?.variant ? { variant: ctx.lastModel.variant } : {}),
				parts: buildPromptParts(prompt, images),
			});
		} catch (error) {
			logger.debug("opencode steer failed", errorDetails(error));
			return false;
		}
		// Accepted → render the steer bubble.
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
		return true;
	}

	async shutdown(): Promise<void> {
		for (const ctx of this.byOpencodeId.values()) {
			this.turns.requestStop(ctx.helmorSessionId);
		}
		this.sessions.clear();
		this.byOpencodeId.clear();
		this.pendingPermissions.clear();
		this.pendingQuestions.clear();
		await this.server.kill();
	}
}

interface OpencodeEvent {
	readonly type: string;
	readonly properties?: {
		readonly sessionID?: string;
		readonly status?: { readonly type?: string };
		readonly error?: unknown;
		readonly [key: string]: unknown;
	};
}

interface OpencodeMessageInfo {
	readonly role?: string;
	readonly tokens?: {
		readonly input?: number;
		readonly output?: number;
		readonly reasoning?: number;
		readonly cache?: { readonly read?: number; readonly write?: number };
	};
}

interface OpencodeToolPartLike {
	readonly type?: string;
	readonly tool?: string;
	readonly callID?: string;
	readonly state?: { readonly metadata?: { readonly sessionId?: string } };
}

interface OpencodeQuestion {
	readonly question: string;
	readonly header: string;
	readonly options?: ReadonlyArray<{ label: string; description: string }>;
	readonly multiple?: boolean;
}

// AUQ response `{ answers: { [questionText]: "label, label" } }` → one
// string[] per question, in order. Multi-select labels are comma-joined.
export function mapQuestionAnswers(
	questions: ReadonlyArray<{ question: string }>,
	content: Record<string, unknown> | undefined,
): string[][] {
	const byQuestion = (content?.answers ?? {}) as Record<string, unknown>;
	return questions.map((q) => {
		const raw = byQuestion[q.question];
		if (typeof raw === "string") {
			return raw
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
		}
		if (Array.isArray(raw)) {
			return raw.filter((v): v is string => typeof v === "string");
		}
		return [];
	});
}

// Concatenate every `type: "text"` part, dropping reasoning/tool/step parts.
export function extractTitleText(parts: unknown): string {
	if (!Array.isArray(parts)) return "";
	const out: string[] = [];
	for (const part of parts) {
		if (
			part &&
			typeof part === "object" &&
			(part as { type?: unknown }).type === "text" &&
			typeof (part as { text?: unknown }).text === "string"
		) {
			out.push((part as { text: string }).text);
		}
	}
	return out.join("\n").trim();
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (error && typeof error === "object") {
		const anyErr = error as Record<string, unknown>;
		const body = anyErr.error ?? anyErr.data ?? anyErr.body;
		try {
			return JSON.stringify(body ?? error);
		} catch {
			/* fall through */
		}
	}
	return String(error);
}
