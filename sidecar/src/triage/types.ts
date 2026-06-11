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
	/** Active model's real llama.cpp `-c` context window (tokens), reported by
	 *  Rust per tick. Drives the triage maxTokens budget so deep thinking has
	 *  room without starving input. Optional / 0 when unknown → buildLocalModel
	 *  falls back to a safe 32K default. */
	readonly contextWindow?: number;
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
	/** Why this item surfaced for the user when a concrete relation exists
	 *  (e.g. `review_requested` / `assigned` / `mentioned` / `author`).
	 *  camelCase of the Rust `involvement_reason` serde rename; `null` for
	 *  sources that don't stamp one. */
	readonly involvementReason: string | null;
	readonly payloadPath: string;
	readonly payloadBytes: number;
	/** Image attachments (base64) bundled by the Rust scheduler so the
	 *  vision-capable local LLM can see them without a host round-trip. */
	readonly attachments?: readonly TriageAttachment[];
}

export interface TriageAttachment {
	/** Anchor message id this attachment belongs to. */
	readonly messageId: string;
	/** Filename in the staging dir (preserved when moved to a workspace). */
	readonly filename: string;
	/** Display alt text — image_key / file name / title. */
	readonly alt: string | null;
	/** MIME like `image/png`. */
	readonly mimeType: string;
	/** Raw bytes base64-encoded (omit when too large). */
	readonly dataBase64: string;
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
	/** Anchor id; chat candidate can spawn N workspaces, one per anchor. */
	readonly taskAnchor: string;
	readonly repoId: string;
	readonly title: string;
	readonly branchName: string;
	readonly planMessage: string;
}

/** Subset of {@link TriageAttachment} the agent forwards to Rust on
 *  `propose_workspace`. The full base64 stays in the original candidate
 *  payload — only the identifying fields cross back. */
export interface TriageProposalAttachment {
	readonly messageId: string;
	readonly filename: string;
	readonly alt: string | null;
}
