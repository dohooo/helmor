// runTriageTick dispatcher.

import type { SidecarEmitter } from "../emitter";
import { logger } from "../logger";
import { abortCurrentTick, runTriageTick } from "./agent";
import type { TriageTickParams } from "./types";

export function handleStopTriageTick(
	requestId: string,
	rawParams: Record<string, unknown>,
	emitter: SidecarEmitter,
): void {
	const tickId =
		typeof rawParams.tickId === "string" ? rawParams.tickId : undefined;
	const stopped = abortCurrentTick(tickId);
	logger.info(`[${requestId}] stopTriageTick`, { tickId, stopped });
	// `runTriageTick` will emit its own `end` once the abort lands; we
	// just ack the stop request so the Rust caller's listener resolves.
	emitter.end(requestId);
}

function coerceParams(raw: Record<string, unknown>): TriageTickParams {
	const obj = (v: unknown) =>
		v && typeof v === "object" ? (v as Record<string, unknown>) : {};
	const strArr = (v: unknown): string[] =>
		Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
	const strRecord = (v: unknown): Record<string, string> => {
		const out: Record<string, string> = {};
		for (const [k, val] of Object.entries(obj(v))) {
			if (typeof val === "string") out[k] = val;
		}
		return out;
	};
	const local = obj(raw.localModel);
	const repos = Array.isArray(raw.repos)
		? (raw.repos as TriageTickParams["repos"])
		: [];
	return {
		tickId: String(raw.tickId ?? ""),
		systemPrompt: typeof raw.systemPrompt === "string" ? raw.systemPrompt : "",
		maxPerTick: Math.max(1, Math.min(50, Number(raw.maxPerTick ?? 5))),
		providers: strArr(raw.providers),
		lastTriagedAt: strRecord(raw.lastTriagedAt),
		repos,
		localModel: {
			baseUrl: String(local.baseUrl ?? ""),
			token: String(local.token ?? ""),
			model: String(local.model ?? "local"),
		},
	};
}

export async function handleRunTriageTick(
	requestId: string,
	rawParams: Record<string, unknown>,
	emitter: SidecarEmitter,
	write: (event: object) => void,
): Promise<void> {
	const params = coerceParams(rawParams);
	logger.debug(`[${requestId}] triage tick start`, {
		tickId: params.tickId,
		providers: params.providers,
	});

	if (!params.localModel.baseUrl) {
		emitter.error(
			requestId,
			"Local model endpoint missing — is local LLM running?",
		);
		return;
	}
	if (params.providers.length === 0) {
		emitter.end(requestId);
		return;
	}

	try {
		const outcome = await runTriageTick(params, {
			emitProgress(payload) {
				write({ id: requestId, type: "triageProgress", ...payload });
			},
		});
		for (const proposal of outcome.proposals) {
			write({
				id: requestId,
				type: "triageProposal",
				params: {
					sourceType: proposal.sourceType,
					sourceRef: proposal.sourceRef,
					repoId: proposal.repoId,
					planMessage: proposal.planMessage,
					attachments: proposal.attachments ?? [],
				},
			});
		}
		if (outcome.finalMessage) {
			write({
				id: requestId,
				type: "triageSummary",
				message: outcome.finalMessage,
			});
		}
		if (outcome.cancelled) {
			write({ id: requestId, type: "triageCancelled" });
		}
		emitter.end(requestId);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		logger.error(`[${requestId}] triage failed`, { error: msg });
		emitter.error(requestId, `triage: ${msg}`);
	}
}
