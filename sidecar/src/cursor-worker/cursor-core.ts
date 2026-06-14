/** SessionManager backed by @cursor/sdk. One Agent per Helmor session;
 * stream events forwarded with `type` namespaced as `cursor/<original>`
 * so Rust dispatch doesn't collide with claude/codex event types. */

import {
	Agent,
	Cursor,
	type ModelParameterValue,
	type Run,
	type SDKAgent,
} from "@cursor/sdk";
import { ActiveTurnRegistry } from "../active-turn-registry.js";
import { scanCursorSkills } from "../cursor-skill-scanner.js";
import type { SidecarEmitter } from "../emitter.js";
import { parseImageRefs } from "../images.js";
import { errorDetails, logger } from "../logger.js";
import { listProviderModels } from "../model-catalog.js";
import type {
	CursorModelParameter,
	GenerateTitleOptions,
	ListSlashCommandsParams,
	ProviderModelInfo,
	SendMessageParams,
	SlashCommandInfo,
} from "../session-manager.js";
import {
	buildTitlePrompt,
	parseTitleAndBranchWithDiagnostics,
	TITLE_GENERATION_TIMEOUT_MS,
} from "../title.js";
import {
	buildCursorMessage,
	computeModelParameterValues,
	extractCreatePlanText,
	isAgentBusyError,
	isRetryableCursorError,
	modelInfoToProviderInfo,
	namespaceEvent,
	toCursorMode,
} from "./cursor-helpers.js";

/// Cheapest model on the title-gen hot path.
const TITLE_MODEL_ID = "composer-2";

/// Retry transient network failures (Cursor's API intermittently resets the
/// TLS handshake) on the SDK's connection-setup calls. 3 attempts, linear
/// backoff. Non-retryable errors throw immediately.
const RETRY_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 400;

async function withCursorRetry<T>(
	label: string,
	fn: () => Promise<T>,
): Promise<T> {
	let lastErr: unknown;
	for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
		try {
			return await fn();
		} catch (err) {
			lastErr = err;
			if (attempt === RETRY_ATTEMPTS || !isRetryableCursorError(err)) throw err;
			const wait = RETRY_BACKOFF_MS * attempt;
			logger.info(
				`[cursor] ${label} transient network failure (attempt ${attempt}/${RETRY_ATTEMPTS}), retrying in ${wait}ms: ${err instanceof Error ? err.message : String(err)}`,
			);
			await new Promise((resolve) => setTimeout(resolve, wait));
		}
	}
	throw lastErr;
}

interface LiveSession {
	readonly agent: SDKAgent;
	/// Updated per turn — composer can switch model mid-conversation.
	modelId: string;
	currentRun: Run | null;
	currentRequestId: string | null;
}

export class CursorCore {
	private readonly sessions = new Map<string, LiveSession>();
	private readonly turns = new ActiveTurnRegistry();
	/// Per-wire-id parameters[] cache. Populated by listModels(), read
	/// by sendMessage() to build ModelParameterValue[].
	private readonly modelParameters = new Map<
		string,
		readonly CursorModelParameter[]
	>();
	/// API key, pushed in via Rust's `updateConfig` RPC (UI-configured only —
	/// no env-var fallback). `null` means not configured → cursor errors out.
	private apiKey: string | null = null;

	setApiKey(apiKey: string | null): void {
		const next = apiKey?.trim() ? apiKey.trim() : null;
		if (next === this.apiKey) return; // unchanged — keep live sessions
		this.apiKey = next;
		// Drop existing sessions — they were minted with the old key.
		// In-flight cursor turns abort; claude/codex unaffected.
		for (const [sessionId, session] of this.sessions) {
			this.turns.requestStop(sessionId);
			try {
				session.agent.close();
			} catch {
				/* ignored */
			}
		}
		this.sessions.clear();
		logger.info(
			next === null
				? "Cursor API key cleared"
				: "Cursor API key updated; existing cursor sessions invalidated",
		);
	}

	private resolveApiKey(): string | null {
		return this.apiKey;
	}

	async sendMessage(
		requestId: string,
		params: SendMessageParams,
		emitter: SidecarEmitter,
	): Promise<void> {
		const apiKey = this.resolveApiKey();
		if (!apiKey) {
			emitter.error(
				requestId,
				"Cursor API key is not configured. Add it in Settings → Models → Cursor.",
			);
			emitter.end(requestId);
			return;
		}

		// Register the turn before any startup await so a Stop pressed during
		// Agent.create / agent.send aborts instantly. Teardown reads the run
		// lazily — it's null until agent.send resolves.
		this.turns.begin(params.sessionId, requestId, emitter, () => {
			void this.sessions
				.get(params.sessionId)
				?.currentRun?.cancel()
				.catch(() => {});
		});

		const modelId = params.model ?? "composer-2";
		const cwd = params.cwd ?? process.cwd();

		let session = this.sessions.get(params.sessionId);
		if (!session) {
			try {
				const agent = await withCursorRetry("Agent.create", () =>
					params.resume
						? Agent.resume(params.resume, { apiKey, local: { cwd } })
						: Agent.create({
								apiKey,
								model: { id: modelId },
								local: { cwd },
								mode: toCursorMode(params.permissionMode),
							}),
				);
				session = {
					agent,
					modelId,
					currentRun: null,
					currentRequestId: null,
				};
				this.sessions.set(params.sessionId, session);
				// Synthetic event — Rust persists agentId as provider_session_id.
				emitter.passthrough(requestId, {
					type: "cursor/agent_init",
					session_id: agent.agentId,
					model: modelId,
				});
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				logger.error(`[${requestId}] Cursor Agent.create failed: ${msg}`, {
					...errorDetails(error),
				});
				emitter.error(requestId, `Cursor: ${msg}`);
				emitter.end(requestId);
				return;
			}
		}

		// Stop pressed during Agent.create — `requestStop` already emitted
		// `aborted`. Keep the freshly-minted agent for reuse; just bail.
		if (this.turns.isAbortRequested(params.sessionId)) {
			this.turns.end(params.sessionId, requestId);
			return;
		}

		// Use this turn's modelId, not the agent's create-time pick —
		// composer can switch models mid-conversation. `thinking` is
		// auto-enabled inside buildSendModelParams when present.
		session.modelId = modelId;
		const modelParams = await this.buildSendModelParams(
			modelId,
			params.effortLevel,
			params.fastMode,
			apiKey,
		);
		// Lift `@<path>` image markers out of the prompt and materialize
		// them as base64 attachments. Local agents only accept the
		// `{ data, mimeType }` SDKImage variant (`url` throws).
		const { text, imagePaths } = parseImageRefs(params.prompt, params.images);
		const message = await buildCursorMessage(text, imagePaths);
		const activeSession = session;
		// `local.force` expires a wedged active run (left non-terminal in the
		// cwd-scoped store by a worker that died mid-turn) before starting this
		// one. Only set on the recovery retry — never force-expire a run that's
		// legitimately in flight.
		const sendOptions = (force: boolean) => ({
			// Pass mode every turn — Cursor sticks with the create-time mode
			// otherwise, so toggling Plan on/off mid-conversation (incl.
			// "Implement" → back to agent) wouldn't take effect.
			mode: toCursorMode(params.permissionMode),
			model: {
				id: modelId,
				...(modelParams.length > 0 ? { params: modelParams } : {}),
			},
			...(force ? { local: { force: true } } : {}),
		});
		let run: Run;
		try {
			run = await withCursorRetry("agent.send", () =>
				activeSession.agent.send(message, sendOptions(false)),
			);
		} catch (error) {
			// A run wedged in the local store ("already has active run") blocks
			// every follow-up send and survives app restarts. Retry once with
			// `local.force` — the SDK's recovery path for agents left wedged by a
			// crashed CLI/worker process — before surfacing a hard failure.
			if (!isAgentBusyError(error)) {
				const msg = error instanceof Error ? error.message : String(error);
				logger.error(`[${requestId}] Cursor agent.send failed: ${msg}`, {
					...errorDetails(error),
				});
				emitter.error(requestId, `Cursor: ${msg}`);
				emitter.end(requestId);
				return;
			}
			logger.info(
				`[${requestId}] Cursor agent has a wedged active run; retrying agent.send with local.force`,
			);
			try {
				run = await withCursorRetry("agent.send(force)", () =>
					activeSession.agent.send(message, sendOptions(true)),
				);
			} catch (retryError) {
				const msg =
					retryError instanceof Error ? retryError.message : String(retryError);
				logger.error(`[${requestId}] Cursor agent.send(force) failed: ${msg}`, {
					...errorDetails(retryError),
				});
				emitter.error(requestId, `Cursor: ${msg}`);
				emitter.end(requestId);
				return;
			}
		}
		session.currentRun = run;
		session.currentRequestId = requestId;

		// Stop pressed during agent.send — the run now exists, so cancel it.
		if (this.turns.isAbortRequested(params.sessionId)) {
			void run.cancel().catch(() => {});
			this.turns.end(params.sessionId, requestId);
			return;
		}

		// Plan mode ends by calling the `createPlan` tool, whose `args.plan`
		// is the finished plan markdown. We suppress the raw tool_call (so it
		// doesn't render inline) and re-surface it on the same rail as Claude's
		// ExitPlanMode (`planCaptured`) — but only AFTER the terminal FINISHED
		// has flushed the assistant text, so the plan-review card lands after
		// the turn's prose rather than racing ahead of it.
		let pendingPlan: { callId: string; text: string | null } | null = null;
		try {
			for await (const event of run.stream()) {
				const e = event as unknown as Record<string, unknown>;
				if (e.type === "tool_call" && e.name === "createPlan") {
					if (e.status === "completed") {
						pendingPlan = {
							callId: typeof e.call_id === "string" ? e.call_id : "",
							text: extractCreatePlanText(e),
						};
					}
					continue;
				}
				emitter.passthrough(requestId, namespaceEvent(event));
				// Cursor SDK stream may not close on its own after FINISHED;
				// break explicitly so emitter.end() is called promptly.
				if (e.type === "status" && e.status === "FINISHED") {
					if (pendingPlan) {
						emitter.planCaptured(
							requestId,
							pendingPlan.callId,
							pendingPlan.text,
						);
						pendingPlan = null;
					}
					break;
				}
			}
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			if (this.turns.isAbortRequested(params.sessionId)) {
				// run.cancel() throws inside stream() — clean abort, not failure.
				logger.debug(`[${requestId}] Cursor stream aborted by user`);
			} else {
				logger.error(`[${requestId}] Cursor stream error: ${msg}`, {
					...errorDetails(error),
				});
				emitter.error(requestId, `Cursor: ${msg}`);
			}
		} finally {
			session.currentRun = null;
			session.currentRequestId = null;
		}

		// `aborted` is terminal — `requestStop` already emitted it. Only emit
		// `end` on natural completion, then clear the turn.
		if (!this.turns.isAbortRequested(params.sessionId)) {
			emitter.end(requestId);
		}
		this.turns.end(params.sessionId, requestId);
	}

	async generateTitle(
		requestId: string,
		userMessage: string,
		branchRenamePrompt: string | null,
		emitter: SidecarEmitter,
		timeoutMs?: number,
		options?: GenerateTitleOptions,
	): Promise<void> {
		const apiKey = this.resolveApiKey();
		if (!apiKey) {
			throw new Error("Cursor API key is not configured");
		}
		const generateBranch = options?.generateBranch ?? true;
		const prompt = buildTitlePrompt(
			userMessage,
			branchRenamePrompt,
			generateBranch,
		);
		const modelId = options?.model ?? TITLE_MODEL_ID;
		const cwd = process.cwd();
		const timeout = timeoutMs ?? TITLE_GENERATION_TIMEOUT_MS;

		// One-shot — never reuses an existing user session.
		const result = await Promise.race([
			withCursorRetry("Agent.prompt", () =>
				Agent.prompt(prompt, {
					apiKey,
					model: { id: modelId },
					local: { cwd },
				}),
			),
			new Promise<never>((_, reject) =>
				setTimeout(
					() =>
						reject(
							new Error(`Cursor title generation timed out after ${timeout}ms`),
						),
					timeout,
				).unref(),
			),
		]);
		const text = typeof result?.result === "string" ? result.result : "";
		const { title, branchName } = parseTitleAndBranchWithDiagnostics(
			requestId,
			text,
			{
				model: modelId,
				generateBranch,
				logError: (message, meta) => logger.error(message, meta),
			},
		);
		emitter.titleGenerated(requestId, title, branchName);
	}

	async listSlashCommands(
		params: ListSlashCommandsParams,
	): Promise<readonly SlashCommandInfo[]> {
		// SDK has no slash-command RPC; replicate Cursor's filesystem
		// skill scan (https://cursor.com/cn/docs/skills) locally.
		try {
			return await scanCursorSkills(params);
		} catch (err) {
			logger.error(
				`cursor listSlashCommands failed: ${err instanceof Error ? err.message : String(err)}`,
				errorDetails(err),
			);
			return [];
		}
	}

	async listModels(opts?: {
		apiKey?: string;
	}): Promise<readonly ProviderModelInfo[]> {
		// Override key (onboarding validation) bypasses the stored key
		// and never updates internal state — caller decides what to do
		// with success/failure. No-key path still returns the static
		// fallback so the picker has something to show.
		const overrideKey = opts?.apiKey?.trim();
		const apiKey = overrideKey ?? this.resolveApiKey();
		if (!apiKey) {
			return listProviderModels("cursor");
		}
		// On override mode we propagate errors so the caller can probe
		// key validity. On stored-key mode we also propagate now (the
		// older silent-fallback path masked "key invalid" failures).
		const models = await withCursorRetry("Cursor.models.list", () =>
			Cursor.models.list({ apiKey }),
		);
		const out = models.map(modelInfoToProviderInfo);
		if (!overrideKey) this.cacheModelParameters(out);
		return out;
	}

	/// `parameters[]` for `wireId`; lazy-refreshes from Cursor.models.list
	/// when missing. `null` on RPC failure or unknown model.
	private async getModelParameters(
		wireId: string,
		apiKey: string,
	): Promise<readonly CursorModelParameter[] | null> {
		const cached = this.modelParameters.get(wireId);
		if (cached) return cached;
		try {
			const models = await withCursorRetry("Cursor.models.list", () =>
				Cursor.models.list({ apiKey }),
			);
			this.cacheModelParameters(models.map(modelInfoToProviderInfo));
			return this.modelParameters.get(wireId) ?? null;
		} catch (error) {
			logger.info(
				`Cursor.models.list (lazy) failed: ${error instanceof Error ? error.message : String(error)}`,
				errorDetails(error),
			);
			return null;
		}
	}

	private cacheModelParameters(infos: readonly ProviderModelInfo[]): void {
		for (const info of infos) {
			if (info.cursorParameters) {
				this.modelParameters.set(info.cliModel, info.cursorParameters);
			}
		}
	}

	/// Cache resolution + delegation to the pure mapper. We always
	/// resolve parameters[] so `thinking` can be auto-added when present.
	private async buildSendModelParams(
		wireId: string,
		effortLevel: string | undefined,
		fastMode: boolean | undefined,
		apiKey: string,
	): Promise<ModelParameterValue[]> {
		const parameters = await this.getModelParameters(wireId, apiKey);
		if (!parameters) return [];
		return computeModelParameterValues(parameters, effortLevel, fastMode);
	}

	async stopSession(sessionId: string): Promise<void> {
		// Emits `aborted` instantly + cancels the run via teardown — works at
		// any point, including during the first turn's Agent.create startup.
		this.turns.requestStop(sessionId);
	}

	async shutdown(): Promise<void> {
		for (const [sessionId] of this.sessions) {
			this.turns.requestStop(sessionId);
		}
		for (const [, session] of this.sessions) {
			try {
				session.agent.close();
			} catch {
				/* swallow */
			}
		}
		this.sessions.clear();
	}

	/// Terminal-fail every in-flight turn with a clean error and drop all
	/// sessions (their HTTP/2 connections are presumed dead). Called by the
	/// worker's uncaughtException net so a transient network blow-up surfaces
	/// as a real error instead of a silent worker death. Returns the affected
	/// requestIds so the caller can release the proxy's awaiting send promises.
	failActiveTurns(message: string): string[] {
		const requestIds = this.turns.failAll(message);
		for (const [, session] of this.sessions) {
			try {
				session.agent.close();
			} catch {
				/* swallow */
			}
		}
		this.sessions.clear();
		return requestIds;
	}
}
