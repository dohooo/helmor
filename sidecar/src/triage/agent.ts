// Runs one Layer-2 triage tick. Emits `triageProposal` events; `skip` decisions go through `triage.record_decision`.

import { Agent } from "@earendil-works/pi-agent-core";
import {
	type Model,
	registerBuiltInApiProviders,
	streamSimple,
} from "@earendil-works/pi-ai";

import { logger } from "../logger";
import { buildSystemPrompt, buildTickUserMessage } from "./prompts";
import {
	buildListReposTool,
	buildMarkNotActionableTool,
	buildProposeWorkspaceTool,
	buildReadCandidateTool,
	ProposalAccumulator,
} from "./tools/helmor";
import type { TriageProposal, TriageTickParams } from "./types";

registerBuiltInApiProviders();

const PROVIDER_ID = "helmor-local";
const PREVIEW_CHARS = 240;

function buildLocalModel(
	params: TriageTickParams["localModel"],
): Model<"openai-completions"> {
	// Real server `-c` for the active model (Rust reports it per tick); falls back
	// to 32K when unknown. Drives the maxTokens budget below.
	const ctx =
		params.contextWindow && params.contextWindow > 0
			? params.contextWindow
			: 32_768;
	return {
		id: params.model,
		name: params.model,
		api: "openai-completions",
		provider: PROVIDER_ID,
		baseUrl: params.baseUrl.replace(/\/$/, ""),
		// Proposed-task generation is a background, accuracy-critical job with no
		// latency pressure (slow is fine, it just has to be right). Turn ON native
		// thinking so the model deliberates before each owed / not-owed verdict —
		// empirically this kills the cross-source hallucinations + brittle tool use
		// we saw with thinking off. llama-server launches with `--reasoning off`, but
		// a per-request `chat_template_kwargs.enable_thinking=true` re-enables it at
		// the generation layer (verified live). "qwen-chat-template" emits exactly
		// that kwarg, which is GENERIC: Qwen3 AND Gemma 4 both read `enable_thinking`,
		// while templates that don't (Gemma 3, Llama) silently ignore it (llama.cpp's
		// minja treats undefined as null) — so this survives a model switch. The
		// OpenAI `reasoning_effort` knob does nothing here (llama.cpp ignores it for
		// these models); the real depth lever is maxTokens below.
		reasoning: true,
		// `maxTokensField: "max_tokens"` forces the classic OpenAI field that
		// llama.cpp reliably honours — the SDK would otherwise default localhost to
		// `max_completion_tokens`, which older llama.cpp builds ignore (→ our budget
		// would be silently dropped).
		compat: {
			thinkingFormat: "qwen-chat-template",
			maxTokensField: "max_tokens",
		},
		// Multimodal — IM candidates may carry image attachments the
		// fetcher inlined as base64.
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		// Match the SDK's context view to the server's real `-c` so its overflow
		// detection is accurate (the agent loop does no contextWindow trimming).
		contextWindow: ctx,
		// Depth lever: since reasoning_effort is ignored, the only way to let the
		// model think harder is a bigger budget for the shared <think> + answer span
		// (Qwen recommends ~32K output for thinking). Scale to the real context so
		// we never starve input on a small-ctx machine.
		maxTokens: Math.min(32_768, Math.max(4_096, Math.floor(ctx / 4))),
	};
}

function preview(value: unknown, max = PREVIEW_CHARS): string {
	const s = typeof value === "string" ? value : JSON.stringify(value);
	if (s == null) return "";
	return s.length <= max ? s : `${s.slice(0, max)}…(+${s.length - max})`;
}

export interface RunTriageOutcome {
	proposals: TriageProposal[];
	finalMessage: string | null;
	cancelled: boolean;
}

let activeTick: { tickId: string; abort: () => void } | null = null;

export function abortCurrentTick(tickId?: string): boolean {
	if (!activeTick) return false;
	if (tickId && tickId !== activeTick.tickId) return false;
	try {
		activeTick.abort();
		return true;
	} catch {
		return false;
	}
}

function extractAssistantText(message: unknown): string | null {
	if (!message || typeof message !== "object") return null;
	const m = message as { role?: unknown; content?: unknown };
	if (m.role !== "assistant" || !Array.isArray(m.content)) return null;
	const parts: string[] = [];
	for (const block of m.content) {
		if (block && typeof block === "object") {
			const b = block as { type?: unknown; text?: unknown };
			if (b.type === "text" && typeof b.text === "string") {
				parts.push(b.text);
			}
		}
	}
	const joined = parts.join("\n").trim();
	return joined.length > 0 ? joined : null;
}

export interface RunTriageHooks {
	emitProgress(payload: {
		turn?: number;
		tool?: string;
		argsPreview?: string;
	}): void;
}

export async function runTriageTick(
	params: TriageTickParams,
	hooks: RunTriageHooks,
): Promise<RunTriageOutcome> {
	const tickId = params.tickId || "(no-tick-id)";
	const logTag = `triage[${tickId}]`;

	if (params.candidates.length === 0) {
		logger.info(`${logTag} no candidates, skipping LLM call`);
		return { proposals: [], finalMessage: null, cancelled: false };
	}

	const accumulator = new ProposalAccumulator();
	const tools: unknown[] = [
		buildListReposTool(params.repos),
		buildProposeWorkspaceTool(accumulator, { max: params.maxPerTick }),
		buildMarkNotActionableTool(accumulator),
		buildReadCandidateTool(),
	];

	const model = buildLocalModel(params.localModel);
	const systemPrompt = buildSystemPrompt({
		userPromptSuffix: params.systemPrompt,
		maxPerTick: params.maxPerTick,
		candidates: params.candidates,
	});
	const { text: userText, images: userImages } = buildTickUserMessage(
		params.candidates,
		params.repos,
	);

	logger.info(`${logTag} agent.build`, {
		toolCount: tools.length,
		candidateCount: params.candidates.length,
		imageCount: userImages.length,
		userMessagePreview: preview(userText),
	});

	const agent = new Agent({
		initialState: {
			systemPrompt,
			model,
			tools: tools as never,
		},
		convertToLlm: (messages) =>
			messages.filter(
				(m) =>
					m.role === "user" ||
					m.role === "assistant" ||
					m.role === "toolResult",
			) as never,
		// Background generation trades latency for accuracy. Qwen3 thinking mode
		// wants temperature ~0.6 (greedy temp 0 degrades / loops once thinking is
		// on), and `reasoning: "high"` is what flips enable_thinking=true through
		// the qwen-chat-template compat set on the model above. We MUST also forward
		// `maxTokens` here: pi-agent-core's loop config does not propagate the
		// model's maxTokens to the request, and the wire `max_tokens` is only set
		// from the per-call option — so without this the server falls back to its own
		// default and our depth budget is silently ignored. The lightweight local-LLM
		// call sites (title / commit in local_llm/manager.rs) keep their own separate
		// temp-0, no-think path — they are untouched.
		streamFn: (m, ctx, opts) =>
			streamSimple(m, ctx, {
				...opts,
				reasoning: "high",
				temperature: 0.6,
				maxTokens: m.maxTokens,
			}),
		getApiKey: (provider) =>
			provider === PROVIDER_ID ? params.localModel.token : undefined,
	});

	// Cap is runaway protection; ~1 turn per candidate + a few read_candidate calls.
	const MAX_TURNS = Math.max(20, params.candidates.length * 2 + 10);
	let turnIndex = 0;
	let aborted = false;
	let cancelledByUser = false;
	let lastAssistantText: string | null = null;
	activeTick = {
		tickId,
		abort: () => {
			cancelledByUser = true;
			aborted = true;
			try {
				agent.abort();
			} catch {}
		},
	};
	agent.subscribe((event) => {
		const e = event as { type: string } & Record<string, unknown>;
		switch (e.type) {
			case "turn_start": {
				turnIndex += 1;
				hooks.emitProgress({ turn: turnIndex });
				if (turnIndex > MAX_TURNS && !aborted) {
					aborted = true;
					logger.info(`${logTag} MAX_TURNS hit, aborting`);
					try {
						agent.abort();
					} catch {}
				}
				break;
			}
			case "tool_execution_start": {
				const { toolName, args } = e as { toolName?: string; args?: unknown };
				if (toolName) {
					hooks.emitProgress({
						tool: toolName,
						argsPreview: preview(args, 120),
					});
				}
				break;
			}
			case "message_end": {
				const text = extractAssistantText((e as { message?: unknown }).message);
				if (text) lastAssistantText = text;
				break;
			}
		}
	});

	try {
		try {
			await agent.prompt(userText, userImages);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			if (aborted) {
				logger.info(`${logTag} aborted by cap`, { error: msg });
			} else {
				logger.error(`${logTag} agent.prompt threw`, { error: msg });
				throw error;
			}
		}

		const proposals = accumulator.drain();
		logger.info(`${logTag} agent.done`, {
			proposalCount: proposals.length,
			aborted,
			cancelledByUser,
			turnsRun: turnIndex,
			finalMessage: lastAssistantText,
		});
		return {
			proposals,
			finalMessage: lastAssistantText,
			cancelled: cancelledByUser,
		};
	} finally {
		activeTick = null;
	}
}
