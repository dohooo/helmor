// Curated quick-pick of models.dev catalog providers for the Kimi "Custom
// Providers" panel — only ids verified to import cleanly via
// `kimi provider catalog add` (many catalog entries fail with "unsupported
// wire type"). Anything else can be added via the Custom (OpenAI-compatible)
// form. `id` is the models.dev provider id.

export type KimiCatalogPreset = {
	id: string;
	label: string;
	/** Where the user gets an API key, surfaced as a "Get your API key" link. */
	apiKeyUrl?: string;
};

export const KIMI_CATALOG_PRESETS: readonly KimiCatalogPreset[] = [
	{
		id: "moonshotai",
		label: "Moonshot AI",
		apiKeyUrl: "https://platform.moonshot.ai/console/api-keys",
	},
	{
		id: "anthropic",
		label: "Anthropic",
		apiKeyUrl: "https://console.anthropic.com/settings/keys",
	},
	{
		id: "openai",
		label: "OpenAI",
		apiKeyUrl: "https://platform.openai.com/api-keys",
	},
	{
		id: "google",
		label: "Google Gemini",
		apiKeyUrl: "https://aistudio.google.com/apikey",
	},
	{
		id: "deepseek",
		label: "DeepSeek",
		apiKeyUrl: "https://platform.deepseek.com/api_keys",
	},
	{
		id: "fireworks-ai",
		label: "Fireworks AI",
		apiKeyUrl: "https://app.fireworks.ai/settings/users/api-keys",
	},
];

export function findKimiPreset(id: string): KimiCatalogPreset | undefined {
	return KIMI_CATALOG_PRESETS.find((p) => p.id === id);
}
