// Pure provider-config domain types, shared across all four agent families.

export type ProviderFamily = "claude" | "codex" | "opencode" | "kimi";

export type ModelLimit = {
	context: number;
	output: number;
};

export type ModelCost = {
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
	contextOver200k?: ModelCost;
};

export type ModelModalities = {
	input?: string[];
	output?: string[];
};

export type ModelStatus = "alpha" | "beta" | "deprecated" | "active";

export type InterleavedConfig =
	| boolean
	| { field: "reasoning" | "reasoning_content" | "reasoning_details" };

export type CustomProviderModel = {
	slug: string;
	label: string;
	/** Non-empty ⟺ the composer shows an effort switch. */
	effortLevels?: string[];
	reasoning?: boolean;
	toolCall?: boolean;
	temperature?: boolean;
	attachment?: boolean;
	limit?: ModelLimit;
	modalities?: ModelModalities;
	cost?: ModelCost;
	family?: string;
	releaseDate?: string;
	status?: ModelStatus;
	interleaved?: InterleavedConfig;
	variants?: Record<string, unknown>;
};

export type ApiStyle = "chat" | "responses";

export type CustomProvider = {
	/** For Claude presets this IS the preset key (keeps the model id stable). */
	id: string;
	name: string;
	/** Set → built-in preset (base URL / style pinned). Undefined → manual. */
	presetKey?: string;
	baseUrl: string;
	apiKey: string;
	/** Wire protocol / API style. OpenCode: "chat" | "responses". Kimi:
	 *  "openai" | "openai_responses" | "anthropic" | "kimi". Claude:
	 *  "anthropic" (default) | "vertex". Interpreted by the family's backend. */
	apiStyle?: string;
	/** Vertex-type Claude providers (`apiStyle === "vertex"`) only. */
	vertexProjectId?: string;
	/** CLOUD_ML_REGION; empty → "global". */
	vertexRegion?: string;
	/** "token" (default — `apiKey` holds the gateway token) | "keychain".
	 *  Keychain item names are fixed: service `helmor-anthropic-auth-token`,
	 *  account = provider id. */
	vertexAuthMode?: string;
	headers?: Record<string, string>;
	models: CustomProviderModel[];
	/** Codex: per-provider enabled models (`null` = all). Merged families: unused. */
	enabledModelIds: string[] | null;
};

// `null` enabled → every available id.
export function resolveEnabled(
	enabled: string[] | null,
	available: readonly { slug: string }[],
): string[] {
	return enabled ?? available.map((m) => m.slug);
}

export function toggleEnabled(
	enabled: string[] | null,
	available: readonly { slug: string }[],
	id: string,
): string[] {
	const base = resolveEnabled(enabled, available);
	return base.includes(id) ? base.filter((v) => v !== id) : [...base, id];
}
