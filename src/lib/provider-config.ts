// Pure provider-config domain types, shared across all four agent families.

export type ProviderFamily = "claude" | "codex" | "opencode" | "mimo" | "kimi";

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
	/** Wire protocol / API style. OpenCode/MiMo: "chat" | "responses". Kimi:
	 *  "openai" | "openai_responses" | "anthropic" | "kimi". Interpreted by the
	 *  family's backend. */
	apiStyle?: string;
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
