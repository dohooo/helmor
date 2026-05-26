// Runs one Layer-2 triage tick.
//
// Inputs: pre-fetched candidate list, repo list, local-model endpoint.
// Output: a stream of `triageProposal` events the Rust scheduler turns
// into workspaces. Decisions of kind `skip` are recorded inline via the
// `triage.record_decision` host bridge.

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
import { buildThinkTool } from "./tools/reasoning";
import type { TriageProposal, TriageTickParams } from "./types";

registerBuiltInApiProviders();

const PROVIDER_ID = "helmor-local";
const PREVIEW_CHARS = 240;

function buildLocalModel(
	params: TriageTickParams["localModel"],
): Model<"openai-completions"> {
	return {
		id: params.model,
		name: params.model,
		api: "openai-completions",
		provider: PROVIDER_ID,
		baseUrl: params.baseUrl.replace(/\/$/, ""),
		reasoning: false,
		// Layer-2 doesn't pass image blocks (attachments aren't handled at
		// this layer). Vision capability is irrelevant; text-only is enough.
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_768,
		maxTokens: 4_096,
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
		// Scratchpad — no side effect. Compensates for a small local
		// model's missing chain-of-thought stability. Time anchors are
		// injected statically into the system prompt instead of a tool.
		buildThinkTool(),
	];

	const model = buildLocalModel(params.localModel);
	const systemPrompt = buildSystemPrompt({
		userPromptSuffix: params.systemPrompt,
		maxPerTick: params.maxPerTick,
	});
	const userMessage = buildTickUserMessage(params.candidates, params.repos);

	logger.info(`${logTag} agent.build`, {
		toolCount: tools.length,
		candidateCount: params.candidates.length,
		userMessagePreview: preview(userMessage),
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
		streamFn: (m, ctx, opts) => streamSimple(m, ctx, opts),
		getApiKey: (provider) =>
			provider === PROVIDER_ID ? params.localModel.token : undefined,
	});

	// Layer-2 needs many fewer turns than the old "discover-then-judge"
	// loop. The cap is mainly a runaway-protection (one prompt cycle per
	// candidate + a few read_candidate drilldowns).
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
			await agent.prompt(userMessage);
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
