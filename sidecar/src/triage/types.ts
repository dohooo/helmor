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

export interface TriageTickParams {
	readonly tickId: string;
	readonly systemPrompt: string;
	readonly maxPerTick: number;
	/** Enabled provider ids in order. */
	readonly providers: readonly string[];
	/** ISO timestamp per provider id; missing = first run. */
	readonly lastTriagedAt: Readonly<Record<string, string>>;
	readonly repos: readonly TriageRepo[];
	readonly localModel: TriageLocalModel;
}

export interface TriageAttachment {
	readonly id: string;
	readonly alt?: string;
}

export interface TriageProposal {
	readonly sourceType: string;
	readonly sourceRef: string;
	readonly repoId: string;
	readonly planMessage: string;
	readonly attachments?: readonly TriageAttachment[];
}
