// Runs one tick: provider preflight → mount tools → PI agent loop →
// collect proposals. Emits progress events for Rust to surface in the UI.

import { Agent } from "@earendil-works/pi-agent-core";
import {
	type Model,
	registerBuiltInApiProviders,
	streamSimple,
} from "@earendil-works/pi-ai";

import { logger } from "../logger";
import { buildSystemPrompt, buildTickUserMessage } from "./prompts";
import { findProvider, PROVIDERS } from "./providers/registry";
import type { ProviderContext } from "./providers/types";
import { ScratchSession, sweepStaleScratch } from "./scratch";
import {
	buildListReposTool,
	buildProposeWorkspaceTool,
	ProposalAccumulator,
} from "./tools/helmor";
import { buildScratchTools } from "./tools/scratch";
import type { TriageProposal, TriageTickParams } from "./types";

registerBuiltInApiProviders();

const PROVIDER_ID = "helmor-local";
const PREVIEW_CHARS = 240;
const COLD_START_LOOKBACK_HOURS = 120;

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
	/// The agent's final assistant text, captured from the last
	/// `message_end` event with `role: "assistant"`. Surfaced to the UI as
	/// the "nothing actionable" tooltip so the user can see why the agent
	/// decided not to propose anything.
	finalMessage: string | null;
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
	/** Called whenever a tool execution starts or a turn starts.
	 *  Sidecar dispatcher uses this to emit a `triageProgress` event. */
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

	void sweepStaleScratch();
	const scratch = new ScratchSession(tickId);
	await scratch.init();

	const accumulator = new ProposalAccumulator();
	const tools: unknown[] = [
		buildListReposTool(params.repos),
		buildProposeWorkspaceTool(accumulator, { max: params.maxPerTick }),
	];
	for (const t of buildScratchTools(scratch)) tools.push(t);

	const providerHints: string[] = [];
	const disabledProviders: { displayName: string; reason: string }[] = [];

	// Resolve a non-null time floor for every provider. If the DB has no
	// checkpoint yet (cold start), fall back to "now - 48h" so the agent
	// never gets a "scan all of history" budget on the first run.
	const coldStartFloor = new Date(
		Date.now() - COLD_START_LOOKBACK_HOURS * 3_600_000,
	).toISOString();
	const effectiveLastTriagedAt: Record<string, string> = {};
	for (const id of params.providers) {
		effectiveLastTriagedAt[id] = params.lastTriagedAt[id] ?? coldStartFloor;
	}

	for (const id of params.providers) {
		const provider = findProvider(id);
		if (!provider) {
			logger.info(`${logTag} unknown provider id`, { id });
			continue;
		}
		const ctx: ProviderContext = {
			scratch,
			lastTriagedAt: effectiveLastTriagedAt[id] ?? coldStartFloor,
		};
		if (provider.preflight) {
			try {
				const pre = await provider.preflight();
				if (!pre.ok) {
					logger.info(`${logTag} preflight failed`, {
						id,
						reason: pre.reason,
					});
					disabledProviders.push({
						displayName: provider.displayName,
						reason: pre.reason ?? "unavailable",
					});
					continue;
				}
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				disabledProviders.push({
					displayName: provider.displayName,
					reason: msg,
				});
				continue;
			}
		}
		for (const t of provider.buildTools(ctx)) tools.push(t);
		const hint = provider.promptHint(ctx);
		if (hint) providerHints.push(hint);
	}

	const model = buildLocalModel(params.localModel);
	const systemPrompt = buildSystemPrompt({
		userPromptSuffix: params.systemPrompt,
		maxPerTick: params.maxPerTick,
		providerHints,
		disabledProviders,
	});
	const userMessage = buildTickUserMessage(
		params.providers,
		params.repos,
		effectiveLastTriagedAt,
	);

	logger.info(`${logTag} agent.build`, {
		toolCount: tools.length,
		providers: params.providers,
		disabled: disabledProviders.length,
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

	const MAX_TURNS = 100;
	let turnIndex = 0;
	let aborted = false;
	let lastAssistantText: string | null = null;
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
				// Stash every assistant text — the *last* one we see (after the
				// agent loop terminates without further tool_calls) is the
				// model's stated reason for stopping.
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
			turnsRun: turnIndex,
			// Persist the agent's full final message in jsonl — this is the
			// only post-hoc record of its reasoning, so don't truncate.
			finalMessage: lastAssistantText,
		});
		return { proposals, finalMessage: lastAssistantText };
	} finally {
		// Always clean up scratch — every prior return path leaked the dir
		// when the agent aborted by cap or threw post-drain.
		await scratch.dispose();
	}
}

// Re-export so the dispatcher can verify a provider exists if needed.
export { PROVIDERS };
