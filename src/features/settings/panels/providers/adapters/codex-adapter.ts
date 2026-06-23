// Codex provider adapter. No presets (Codex requires a Responses-API endpoint).
// Settings UI is merged; in the composer each custom Codex provider is its own section.

import { fetchProviderModels } from "@/lib/api";
import type { ProviderConfigAdapter } from "../provider-config";
import { useOfficialSectionModels, useSettingsBackedProviders } from "./hooks";

export const CODEX_ADAPTER: ProviderConfigAdapter = {
	family: "codex",
	displayName: "Codex",
	presets: [],
	caps: { baseUrlEditable: true, apiStyleSelectable: false },
	customProvidersDescription: "addOpenaiCompatibleEndpointResponsesApi",
	useCustomProviders: () => useSettingsBackedProviders("codex"),
	fetchModels: (provider) =>
		fetchProviderModels("codex", provider.baseUrl, provider.apiKey),
	useSectionModels: () => useOfficialSectionModels("codex"),
};
