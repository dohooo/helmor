/** SessionManager backed by @cursor/sdk. One Agent per Helmor session;
 * stream events forwarded with `type` namespaced as `cursor/<original>`
 * so Rust dispatch doesn't collide with claude/codex event types. */

import { basename, extname } from "node:path";
import {
	Agent,
	Cursor,
	type ModelListItem,
	type ModelParameterValue,
	type Run,
	type SDKAgent,
	type SDKImage,
	type SDKMessage,
	type SDKUserMessage,
} from "@cursor/sdk";
import { scanCursorSkills } from "./cursor-skill-scanner.js";
import type { SidecarEmitter } from "./emitter.js";
import { readImageWithResize } from "./image-resize.js";
import { parseImageRefs } from "./images.js";
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
	parseTitleAndBranchWithDiagnostics,
	TITLE_GENERATION_TIMEOUT_MS,
} from "./title.js";

/// Cheapest model on the title-gen hot path.
const TITLE_MODEL_ID = "composer-2";

interface LiveSession {
	readonly agent: SDKAgent;
	/// Updated per turn — composer can switch model mid-conversation.
	modelId: string;
	currentRun: Run | null;
	currentRequestId: string | null;
	aborted: boolean;
}

export class CursorSessionManager implements SessionManager {
	private readonly sessions = new Map<string, LiveSession>();
	/// Per-wire-id parameters[] cache. Populated by listModels(), read
	/// by sendMessage() to build ModelParameterValue[].
	private readonly modelParameters = new Map<
		string,
		readonly CursorModelParameter[]
	>();
	/// API key pushed in via Rust's `updateConfig` RPC. `null` until the
	/// host says something; env-var fallback only before that.
	private apiKey: string | null = null;
	/// True once the host has spoken (incl. explicit clear). Once set,
	/// we never silent-fallback to CURSOR_API_KEY — a user who cleared
	/// the key would not expect env-var auth to keep working.
	private apiKeyHostManaged = false;

	setApiKey(apiKey: string | null): void {
		const next = apiKey?.trim() ? apiKey.trim() : null;
		if (this.apiKeyHostManaged && next === this.apiKey) return;
		this.apiKey = next;
		this.apiKeyHostManaged = true;
		// Drop existing sessions — they were minted with the old key.
		// In-flight cursor turns abort; claude/codex unaffected.
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
		// Host decision is authoritative once made; env var only before.
		if (this.apiKeyHostManaged) return this.apiKey;
		return this.apiKey ?? process.env.CURSOR_API_KEY ?? null;
	}

	resolveUserInput(
		_userInputId: string,
		_resolution: UserInputResolution,
	): boolean {
		// SDK auto-handles permission prompts; no waiters to resolve.
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
							mode: toCursorMode(params.permissionMode),
						});
				session = {
					agent,
					modelId,
					currentRun: null,
					currentRequestId: null,
					aborted: false,
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
		let run: Run;
		try {
			run = await session.agent.send(message, {
				// Pass mode every turn — Cursor sticks with the create-time
				// mode otherwise, so toggling Plan on/off mid-conversation
				// (incl. "Implement" → back to agent) wouldn't take effect.
				mode: toCursorMode(params.permissionMode),
				model: {
					id: modelId,
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
			if (session.aborted) {
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

		// One-shot — never reuses an existing user session.
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
		const models = await Cursor.models.list({ apiKey });
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
		// SDK has no mid-turn injection; caller queues as a new turn.
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

/// Map Helmor's permissionMode to Cursor's conversation mode. Plan mode
/// runs Cursor read-only; everything else is the normal agent mode.
function toCursorMode(permissionMode: string | undefined): "agent" | "plan" {
	return permissionMode === "plan" ? "plan" : "agent";
}

/// Pull the plan markdown out of a `createPlan` tool_call event
/// (`args.plan`). Returns null when absent/blank so `planCaptured` falls
/// back to a bare marker rather than an empty plan card.
function extractCreatePlanText(e: Record<string, unknown>): string | null {
	const args = e.args as Record<string, unknown> | undefined;
	const plan = args?.plan;
	return typeof plan === "string" && plan.trim() !== "" ? plan : null;
}

function extToMimeType(filePath: string): string {
	switch (extname(filePath).toLowerCase()) {
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".png":
			return "image/png";
		case ".gif":
			return "image/gif";
		case ".webp":
			return "image/webp";
		default:
			return "image/png";
	}
}

/// Build the `agent.send` payload. Returns a plain string when there are
/// no attachments (cheapest path); otherwise an SDKUserMessage carrying
/// base64 images. Unreadable files degrade to a `[Image not found]` note
/// appended to the text so the turn still goes through.
async function buildCursorMessage(
	text: string,
	imagePaths: readonly string[],
): Promise<string | SDKUserMessage> {
	if (imagePaths.length === 0) return text;
	const images: SDKImage[] = [];
	const notes: string[] = [];
	for (const imgPath of imagePaths) {
		try {
			const { buffer } = await readImageWithResize(imgPath);
			images.push({
				data: buffer.toString("base64"),
				mimeType: extToMimeType(imgPath),
			});
		} catch (err) {
			logger.error("Failed to read Cursor image attachment", {
				imageName: basename(imgPath),
				...errorDetails(err),
			});
			notes.push(`[Image not found: ${imgPath}]`);
		}
	}
	const finalText = [text, ...notes].filter(Boolean).join("\n");
	if (images.length === 0) return finalText;
	return { text: finalText, images };
}

/// Prefix `type` with `cursor/` so Rust dispatch doesn't collide with
/// claude/codex. `tool_call` is split into `tool_call_start` /
/// `tool_call_end` based on `status` so accumulator can branch on type.
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

/// Effort wire ids in priority order: Claude uses `effort`, GPT/Codex
/// uses `reasoning`. Both can carry levels; when both present, `effort`
/// wins (Claude has effort + thinking; thinking is the boolean one).
const CURSOR_EFFORT_PARAM_IDS = ["effort", "reasoning"] as const;

/// Build agent.send params from composer toolbar state. Toolbar surfaces
/// effort + fast; `thinking` is auto-enabled when the model exposes it.
/// Pure — exported via __CURSOR_INTERNAL for unit tests.
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
			// Reject out-of-band values — API rejects unknown values.
			if (param.values.some((v) => v.value === effortLevel)) {
				out.push({ id: param.id, value: effortLevel });
			}
			break;
		}
	}

	// Auto-enable `thinking` when present (Claude extended thinking).
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

// Test-only export.
export const __CURSOR_INTERNAL = {
	namespaceEvent,
	modelInfoToProviderInfo,
	computeModelParameterValues,
	buildCursorMessage,
	extToMimeType,
	toCursorMode,
	extractCreatePlanText,
};

// Keep `Agent` import live under verbatimModuleSyntax.
void Agent;
