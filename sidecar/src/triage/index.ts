// runTriageTick dispatcher.

import type { SidecarEmitter } from "../emitter";
import { logger } from "../logger";
import { abortCurrentTick, runTriageTick } from "./agent";
import type { TriageCandidate, TriageTickParams } from "./types";

export function handleStopTriageTick(
	requestId: string,
	rawParams: Record<string, unknown>,
	emitter: SidecarEmitter,
): void {
	const tickId =
		typeof rawParams.tickId === "string" ? rawParams.tickId : undefined;
	const stopped = abortCurrentTick(tickId);
	logger.info(`[${requestId}] stopTriageTick`, { tickId, stopped });
	emitter.end(requestId);
}

function coerceParams(raw: Record<string, unknown>): TriageTickParams {
	const obj = (v: unknown) =>
		v && typeof v === "object" ? (v as Record<string, unknown>) : {};
	const local = obj(raw.localModel);
	const repos = Array.isArray(raw.repos)
		? (raw.repos as TriageTickParams["repos"])
		: [];
	const candidates = Array.isArray(raw.candidates)
		? (raw.candidates as TriageCandidate[])
		: [];
	return {
		tickId: String(raw.tickId ?? ""),
		provider: raw.provider === "local" ? "local" : "codex",
		systemPrompt: typeof raw.systemPrompt === "string" ? raw.systemPrompt : "",
		maxPerTick: Math.max(1, Math.min(50, Number(raw.maxPerTick ?? 5))),
		candidates,
		repos,
		localModel:
			raw.provider === "local"
				? {
						baseUrl: String(local.baseUrl ?? ""),
						token: String(local.token ?? ""),
						model: String(local.model ?? "local"),
					}
				: undefined,
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
		candidateCount: params.candidates.length,
	});

	if (params.provider === "local" && !params.localModel?.baseUrl) {
		emitter.error(
			requestId,
			"Local model endpoint missing — is local LLM running?",
		);
		return;
	}
	if (params.candidates.length === 0) {
		// Nothing to decide — let scheduler record an empty-tick outcome.
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
					candidateId: proposal.candidateId,
					taskAnchor: proposal.taskAnchor,
					repoId: proposal.repoId,
					title: proposal.title,
					branchName: proposal.branchName,
					planMessage: proposal.planMessage,
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
