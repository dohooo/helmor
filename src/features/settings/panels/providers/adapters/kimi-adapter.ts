// Kimi provider-config adapter. File-backed (`~/.kimi-code/config.toml`) like
// OpenCode, but Kimi resolves models through its own runtime, so v1 exposes
// manual OpenAI-compatible endpoints only — no built-in presets or api-style
// switch (the registry-import path was intentionally dropped).

import { fetchProviderModels } from "@/lib/api";
import type { ProviderConfigAdapter } from "../provider-config";
import { useKimiBackedProviders } from "./use-kimi-backed-providers";

export const KIMI_CONFIG_ADAPTER: ProviderConfigAdapter = {
	family: "kimi",
	displayName: "Kimi",
	presets: [],
	caps: { baseUrlEditable: true, apiStyleSelectable: false },
	customProvidersDescription:
		"Add an OpenAI-compatible endpoint (base URL + key), then fetch its models. Saved to ~/.kimi-code/config.toml.",
	useCustomProviders: () => useKimiBackedProviders(),
	fetchModels: (provider) =>
		fetchProviderModels("kimi", provider.baseUrl, provider.apiKey),
};
