/**
 * Wire shapes for one triage tick.
 *
 * Layer-2 lives entirely on `triage_candidate` rows the Rust fetcher
 * has already collected. The sidecar receives:
 *   - the candidate slice to judge,
 *   - the repo list (so propose_workspace can match),
 *   - local-model endpoint.
 *
 * Provider-discovery params (`providers` / `lastTriagedAt`) are gone —
 * Rust does all data fetching now.
 */

export interface TriageRepo {
	readonly id: string;
	readonly name: string;
	readonly remoteUrl: string | null;
	readonly forgeProvider: string | null;
	readonly forgeLogin: string | null;
}

export interface TriageLocalModel {
	readonly baseUrl: string;
	readonly token: string;
	readonly model: string;
}

export interface TriageCandidate {
	readonly id: string;
	readonly source: string;
	readonly sourceKind: string;
	readonly sourceRef: string;
	readonly sourceParent: string | null;
	readonly sourceTime: string;
	readonly sender: string | null;
	readonly title: string | null;
	readonly preview: string | null;
	readonly externalUrl: string | null;
	readonly payloadPath: string;
	readonly payloadBytes: number;
}

export interface TriageTickParams {
	readonly tickId: string;
	readonly systemPrompt: string;
	readonly maxPerTick: number;
	readonly candidates: readonly TriageCandidate[];
	readonly repos: readonly TriageRepo[];
	readonly localModel: TriageLocalModel;
}

export interface TriageProposal {
	readonly candidateId: string;
	readonly repoId: string;
	readonly title: string;
	readonly branchName: string;
	readonly planMessage: string;
}
