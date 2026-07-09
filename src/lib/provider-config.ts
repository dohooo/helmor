// Pure provider-config domain types, shared across all four agent families.

export type ProviderFamily = "claude" | "codex" | "opencode" | "kimi";

export const DEFAULT_CODEX_MODEL_IDS = [
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
] as const;

export const DEFAULT_CLAUDE_MODEL_IDS = [
	"claude-fable-5[1m]",
	"claude-opus-4-8[1m]",
	"sonnet",
	"haiku",
] as const;

export type CustomProviderModel = {
	slug: string;
	label: string;
	/** Non-empty ⟺ the composer shows an effort switch. */
	effortLevels?: string[];
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

export function resolveOfficialEnabled(
	family: "claude" | "codex",
	enabled: string[] | null,
	available: readonly { slug: string }[],
): string[] {
	if (enabled !== null) return resolveEnabled(enabled, available);

	const defaultIds =
		family === "codex" ? DEFAULT_CODEX_MODEL_IDS : DEFAULT_CLAUDE_MODEL_IDS;
	const customPrefix = family === "codex" ? "codex:" : "claude-custom|";

	return available
		.filter(
			(model) =>
				defaultIds.some((id) => id === model.slug) ||
				model.slug.startsWith(customPrefix),
		)
		.map((model) => model.slug);
}

export function toggleEnabled(
	enabled: string[] | null,
	available: readonly { slug: string }[],
	id: string,
): string[] {
	const base = resolveEnabled(enabled, available);
	return base.includes(id) ? base.filter((v) => v !== id) : [...base, id];
}
