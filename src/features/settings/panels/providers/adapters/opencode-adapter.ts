// OpenCode / MiMo Code provider adapters (file-backed). Presets are registry
// providers (`apiKeyOnly`). Models row uses the server-sync `SlugProviderModels`.

import { fetchProviderModels } from "@/lib/api";
import { MIMO_PROVIDER_PRESETS } from "../builtin-mimo-providers";
import {
	OPENCODE_PROVIDER_PRESETS,
	type OpencodeProviderPreset,
} from "../builtin-opencode-providers";
import type { ProviderConfigAdapter, ProviderPreset } from "../provider-config";
import { useSlugBackedProviders } from "./use-slug-backed-providers";

function toPreset(preset: OpencodeProviderPreset): ProviderPreset {
	return {
		key: preset.key,
		label: preset.label,
		icon: preset.icon,
		baseUrl: "",
		apiKeyUrl: preset.apiKeyUrl,
		apiKeyOnly: true,
	};
}

export const OPENCODE_CONFIG_ADAPTER: ProviderConfigAdapter = {
	family: "opencode",
	displayName: "OpenCode",
	presets: OPENCODE_PROVIDER_PRESETS.map(toPreset),
	caps: { baseUrlEditable: true, apiStyleSelectable: true },
	customProvidersDescription: "addRegistryProviderByApiKey2",
	useCustomProviders: () => useSlugBackedProviders("opencode"),
	fetchModels: (provider) =>
		fetchProviderModels("opencode", provider.baseUrl, provider.apiKey),
};

export const MIMO_CONFIG_ADAPTER: ProviderConfigAdapter = {
	family: "mimo",
	displayName: "MiMo Code",
	presets: MIMO_PROVIDER_PRESETS.map(toPreset),
	caps: { baseUrlEditable: true, apiStyleSelectable: true },
	customProvidersDescription: "addRegistryProviderByApiKey",
	useCustomProviders: () => useSlugBackedProviders("mimo"),
	fetchModels: (provider) =>
		fetchProviderModels("mimo", provider.baseUrl, provider.apiKey),
};
