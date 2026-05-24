// Runs one triage tick and collects proposals.

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
	// Agent's final assistant text, shown as the "nothing actionable" tooltip.
	finalMessage: string | null;
	// True when the user clicked Stop.
	cancelled: boolean;
	// Providers whose preflight passed AND the tick completed normally
	// (no MAX_TURNS abort, no user cancel). Rust uses this to gate
	// `advance_sync` so preflight-failed or partially-scanned providers
	// don't get their time floor bumped past unseen items.
	scannedProviders: string[];
}

// Handle to the currently-running tick for Stop. Only one tick runs at a time.
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
	// Emits a `triageProgress` event on tool/turn start.
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
	const preflightOk: string[] = [];

	// Cold-start fallback so a missing checkpoint doesn't trigger a full-history scan.
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
		preflightOk.push(id);
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
				// Keep the last assistant text as the model's stated reason for stopping.
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
		// Only advance sync floors for providers we actually scanned end-to-end.
		// MAX_TURNS or user cancel ⇒ tick truncated, no advance for anything.
		const completedNormally = !aborted && !cancelledByUser;
		const scannedProviders = completedNormally ? preflightOk.slice() : [];
		logger.info(`${logTag} agent.done`, {
			proposalCount: proposals.length,
			aborted,
			cancelledByUser,
			turnsRun: turnIndex,
			finalMessage: lastAssistantText,
			scannedProviders,
		});
		return {
			proposals,
			finalMessage: lastAssistantText,
			cancelled: cancelledByUser,
			scannedProviders,
		};
	} finally {
		activeTick = null;
		await scratch.dispose();
	}
}

export { PROVIDERS };
