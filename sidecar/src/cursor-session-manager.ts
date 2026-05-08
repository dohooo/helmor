/**
 * `SessionManager` implementation backed by `@cursor/sdk`.
 *
 * One Cursor `Agent` per Helmor session, cached in `sessions` map. Events
 * from `run.stream()` are forwarded through the sidecar emitter as
 * passthrough JSON with `type` namespaced as `cursor/<original>` so the
 * Rust accumulator can dispatch them without colliding with claude/codex
 * event types of the same name.
 *
 * The Cursor SDK runs in-process (no spawned child) and talks to
 * `api.cursor.com` via Connect RPC. It bundles a small native sandbox
 * helper (`cursorsandbox`) for shell tool execution.
 */

import {
	Agent,
	Cursor,
	type ModelListItem,
	type ModelParameterValue,
	type Run,
	type SDKAgent,
	type SDKMessage,
} from "@cursor/sdk";
import { scanCursorSkills } from "./cursor-skill-scanner.js";
import type { SidecarEmitter } from "./emitter.js";
import { errorDetails, logger } from "./logger.js";
import { listProviderModels } from "./model-catalog.js";
import type {
	CursorModelParameter,
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

/// Cheapest cursor model that handles the title prompt reliably. Picked
/// here because title generation is on the hot path of "user submits
/// first message" — pay the smallest possible inference cost.
const TITLE_MODEL_ID = "composer-2";

interface LiveSession {
	readonly agent: SDKAgent;
	readonly modelId: string;
	currentRun: Run | null;
	currentRequestId: string | null;
	aborted: boolean;
}

export class CursorSessionManager implements SessionManager {
	private readonly sessions = new Map<string, LiveSession>();
	/// Per-model `parameters[]` cache. Filled by `listModels()` (the
	/// settings panel hits this on key save / refresh) and consulted by
	/// `sendMessage()` to build `ModelParameterValue[]`. Keyed by Cursor
	/// wire id (`composer-2`, `gpt-5.3-codex`, `default`, ...) — the same
	/// id stored in `cli_model` on the Rust side and threaded through as
	/// `params.model` on each send.
	private readonly modelParameters = new Map<
		string,
		readonly CursorModelParameter[]
	>();
	/// In-memory copy of the Cursor API key, hot-pushed by the Rust host
	/// via the `updateConfig` RPC on app startup and on every settings
	/// change. Falling back to `process.env.CURSOR_API_KEY` keeps the dev
	/// loop and tests usable without going through the host.
	private apiKey: string | null = process.env.CURSOR_API_KEY ?? null;

	setApiKey(apiKey: string | null): void {
		const next = apiKey?.trim() ? apiKey.trim() : null;
		if (next === this.apiKey) return;
		this.apiKey = next;
		// Old SDK agents were created with the previous key — closing
		// them now means in-flight cursor turns abort, but that's
		// preferable to silently keeping stale auth. Claude and Codex
		// sessions are unaffected (different manager).
		for (const [, session] of this.sessions) {
			session.aborted = true;
			void session.currentRun?.cancel().catch(() => {
				/* ignored — session may have already finished */
			});
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
		return this.apiKey ?? process.env.CURSOR_API_KEY ?? null;
	}

	resolveUserInput(
		_userInputId: string,
		_resolution: UserInputResolution,
	): boolean {
		// Cursor SDK's `request` event is reserved for permission prompts the
		// SDK currently auto-handles. No pending waiters yet.
		return false;
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

		const modelId = params.model ?? "composer-2";
		const cwd = params.cwd ?? process.cwd();

		let session = this.sessions.get(params.sessionId);
		if (!session) {
			try {
				const agent = params.resume
					? await Agent.resume(params.resume, { apiKey })
					: await Agent.create({
							apiKey,
							model: { id: modelId },
							local: { cwd },
						});
				session = {
					agent,
					modelId,
					currentRun: null,
					currentRequestId: null,
					aborted: false,
				};
				this.sessions.set(params.sessionId, session);
				// Surface the agentId so Rust persists it as `provider_session_id`
				// for resume on next launch. Synthetic event — no SDK origin.
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

		// Resume drops the model — pass it on every send. Build the
		// per-turn `ModelParameterValue[]` from the cached `parameters[]`
		// for this wire id. `thinking` is auto-enabled here for any
		// model that exposes it (Claude lineage on Cursor); not a UI
		// dimension, so users don't have to think about it.
		const modelParams = await this.buildSendModelParams(
			session.modelId,
			params.effortLevel,
			params.fastMode,
			apiKey,
		);
		let run: Run;
		try {
			run = await session.agent.send(params.prompt, {
				model: {
					id: session.modelId,
					...(modelParams.length > 0 ? { params: modelParams } : {}),
				},
			});
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			logger.error(`[${requestId}] Cursor agent.send failed: ${msg}`, {
				...errorDetails(error),
			});
			emitter.error(requestId, `Cursor: ${msg}`);
			emitter.end(requestId);
			return;
		}
		session.currentRun = run;
		session.currentRequestId = requestId;
		session.aborted = false;

		try {
			for await (const event of run.stream()) {
				emitter.passthrough(requestId, namespaceEvent(event));
			}
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			if (session.aborted) {
				// Expected — cancel triggers a Connect "canceled" error inside
				// the streaming iterator. Treat as clean abort, not failure.
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

		if (session.aborted) {
			emitter.aborted(requestId, "user_requested");
		}
		emitter.end(requestId);
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

		// Always ephemeral — title prompts must NOT contaminate any
		// existing user-facing session. `Agent.prompt` is the SDK's
		// dedicated one-shot API: spin up agent, run one turn, close.
		const titleRun = Agent.prompt(prompt, {
			apiKey,
			model: { id: modelId },
			local: { cwd },
		});
		const result = await Promise.race([
			titleRun,
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
		const { title, branchName } = parseTitleAndBranch(text);
		emitter.titleGenerated(requestId, title, branchName);
	}

	async listSlashCommands(
		params: ListSlashCommandsParams,
	): Promise<readonly SlashCommandInfo[]> {
		// Cursor's SDK has no slash-command RPC, but Cursor itself documents
		// a filesystem-based skill discovery scheme (see
		// https://cursor.com/cn/docs/skills). We replicate that scan locally
		// so Helmor's composer popup mirrors what the user already has wired
		// into Cursor proper — including the legacy `.claude/skills/` and
		// `.codex/skills/` paths Cursor still honours.
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

	async listModels(): Promise<readonly ProviderModelInfo[]> {
		const apiKey = this.resolveApiKey();
		if (!apiKey) {
			return listProviderModels("cursor");
		}
		try {
			const models = await Cursor.models.list({ apiKey });
			const out = models.map(modelInfoToProviderInfo);
			// Refresh the per-wire-id parameter cache so subsequent
			// sendMessage calls can build params without a second RPC.
			this.cacheModelParameters(out);
			return out;
		} catch (error) {
			logger.info(
				`Cursor.models.list failed; using static fallback: ${error instanceof Error ? error.message : String(error)}`,
				errorDetails(error),
			);
			return listProviderModels("cursor");
		}
	}

	/// Look up the `parameters[]` for `wireId`, refreshing the cache from
	/// `Cursor.models.list` when missing. `null` when the upstream call
	/// fails or the model is unknown — caller must still tolerate.
	private async getModelParameters(
		wireId: string,
		apiKey: string,
	): Promise<readonly CursorModelParameter[] | null> {
		const cached = this.modelParameters.get(wireId);
		if (cached) return cached;
		try {
			const models = await Cursor.models.list({ apiKey });
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

	/// Wrapper that resolves the wire id's cached `parameters[]` (lazy
	/// fetching when missing) and delegates the pure mapping to
	/// `computeModelParameterValues`. Split this way so the mapping logic
	/// is unit-testable without an SDK round-trip. `thinking` is always
	/// auto-enabled when present, so we resolve parameters even when
	/// effort/fast are off.
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
		const session = this.sessions.get(sessionId);
		if (!session) return;
		session.aborted = true;
		if (session.currentRun) {
			try {
				await session.currentRun.cancel();
			} catch (error) {
				logger.debug(
					`[cursor] cancel rejected: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}

	async steer(
		_sessionId: string,
		_prompt: string,
		_files: readonly string[],
		_images: readonly string[],
	): Promise<boolean> {
		// Cursor SDK doesn't expose mid-turn injection. Caller falls back
		// to queue-then-fire-as-new-turn semantics in the frontend.
		return false;
	}

	async shutdown(): Promise<void> {
		const tasks: Promise<void>[] = [];
		for (const [, session] of this.sessions) {
			session.aborted = true;
			if (session.currentRun) {
				tasks.push(
					session.currentRun.cancel().catch(() => {
						/* swallow during shutdown */
					}),
				);
			}
		}
		await Promise.all(tasks);
		for (const [, session] of this.sessions) {
			try {
				session.agent.close();
			} catch {
				/* swallow */
			}
		}
		this.sessions.clear();
	}
}

/// Wrap the SDK event with a `cursor/` namespace on `type` so Rust dispatch
/// is unambiguous — claude/codex both emit non-namespaced types like
/// `assistant`, `status`, etc., and the accumulator's match arms must not
/// collide. For a `tool_call`, also normalize the lifecycle marker into
/// the new type (`cursor/tool_call_start` vs `cursor/tool_call_end`) so
/// the accumulator can branch without inspecting the inner `status` field.
function namespaceEvent(event: SDKMessage): Record<string, unknown> {
	const e = event as unknown as Record<string, unknown>;
	if (e.type === "tool_call") {
		const status = typeof e.status === "string" ? e.status : "running";
		return {
			...e,
			type:
				status === "completed"
					? "cursor/tool_call_end"
					: "cursor/tool_call_start",
		};
	}
	return { ...e, type: `cursor/${String(e.type)}` };
}

/// Param ids the API uses for "effort level" — Claude models expose
/// `effort` (low/medium/high/[xhigh]/max), GPT/Codex models expose
/// `reasoning` (low/medium/high/extra-high). Same semantic knob, different
/// wire id depending on the model lineage. Order matters: when both are
/// present `effort` wins (Claude exposes both `effort` AND `thinking`,
/// and `effort` is the levels one).
const CURSOR_EFFORT_PARAM_IDS = ["effort", "reasoning"] as const;

/// Translate composer toolbar state into the `ModelParameterValue[]`
/// Cursor's SDK accepts on `agent.send`. Toolbar surfaces only effort
/// (`effort` / `reasoning`) and fast (`fast`); `thinking` (Claude
/// extended thinking) is auto-enabled on any model that exposes it,
/// without a UI knob. `effort` wins over `reasoning` when both present.
///
/// Pure — exported via `__CURSOR_INTERNAL` so unit tests can pin its
/// behavior without spinning up an SDK agent.
function computeModelParameterValues(
	parameters: readonly CursorModelParameter[],
	effortLevel: string | undefined,
	fastMode: boolean | undefined,
): ModelParameterValue[] {
	const out: ModelParameterValue[] = [];

	if (typeof effortLevel === "string" && effortLevel !== "") {
		for (const id of CURSOR_EFFORT_PARAM_IDS) {
			const param = parameters.find((p) => p.id === id);
			if (!param) continue;
			// Picker already constrains effortLevel to the model's allowed
			// set; double-check here so an out-of-band value can't poison
			// the whole turn (the API rejects unknown values).
			if (param.values.some((v) => v.value === effortLevel)) {
				out.push({ id: param.id, value: effortLevel });
			}
			break;
		}
	}

	// Auto-enable `thinking` on any model that exposes it. Wire shape is
	// `[{value:"false"}, {value:"true", ...}]`.
	const thinkingParam = parameters.find((p) => p.id === "thinking");
	if (thinkingParam?.values.some((v) => v.value === "true")) {
		out.push({ id: "thinking", value: "true" });
	}

	if (fastMode === true) {
		const param = parameters.find((p) => p.id === "fast");
		if (param?.values.some((v) => v.value === "true")) {
			out.push({ id: "fast", value: "true" });
		}
	}

	return out;
}

function modelInfoToProviderInfo(model: ModelListItem): ProviderModelInfo {
	const params = model.parameters ?? [];
	const effortParam = CURSOR_EFFORT_PARAM_IDS.map((id) =>
		params.find((p) => p.id === id),
	).find((p): p is NonNullable<typeof p> => p !== undefined);
	const fastParam = params.find((p) => p.id === "fast");
	const effortLevels = effortParam?.values
		.map((v) => v.value)
		.filter((v): v is string => typeof v === "string");
	const supportsFastMode = Boolean(fastParam);
	const cursorParameters: CursorModelParameter[] | undefined = model.parameters
		? model.parameters.map((p) => ({
				id: p.id,
				...(p.displayName !== undefined ? { displayName: p.displayName } : {}),
				values: p.values.map((v) => ({
					value: v.value,
					...(v.displayName !== undefined
						? { displayName: v.displayName }
						: {}),
				})),
			}))
		: undefined;
	return {
		id: model.id,
		label: model.displayName ?? model.id,
		cliModel: model.id,
		...(effortLevels && effortLevels.length > 0 ? { effortLevels } : {}),
		...(supportsFastMode ? { supportsFastMode } : {}),
		...(cursorParameters && cursorParameters.length > 0
			? { cursorParameters }
			: {}),
	};
}

// Re-export for unit tests so internals can be exercised without
// spinning up an actual SDK agent.
export const __CURSOR_INTERNAL = {
	namespaceEvent,
	modelInfoToProviderInfo,
	computeModelParameterValues,
};

// Touch the `Agent` class import so TS doesn't drop it under `verbatimModuleSyntax`.
void Agent;
