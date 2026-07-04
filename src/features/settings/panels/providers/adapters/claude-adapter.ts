// Claude Code provider adapter (settings-backed, merged placement).

import { fetchProviderModels } from "@/lib/api";
import { BUILTIN_CLAUDE_PROVIDERS } from "../../builtin-claude-providers";
import type { ProviderConfigAdapter, ProviderPreset } from "../provider-config";
import { useOfficialSectionModels, useSettingsBackedProviders } from "./hooks";

const CLAUDE_PRESETS: ProviderPreset[] = BUILTIN_CLAUDE_PROVIDERS.map(
	(provider) => ({
		key: provider.key,
		label: provider.label,
		icon: provider.icon,
		baseUrl: provider.baseUrl,
		apiKeyUrl: provider.apiKeyUrl,
	}),
);

export const CLAUDE_ADAPTER: ProviderConfigAdapter = {
	family: "claude",
	displayName: "Claude Code",
	presets: CLAUDE_PRESETS,
	caps: { baseUrlEditable: true, apiStyleSelectable: true },
	// Provider kind, not a wire protocol: "vertex" switches the CLI to
	// Google Vertex AI mode (CLAUDE_CODE_USE_VERTEX) behind an LLM gateway.
	styleLabel: "providerType",
	styleOptions: [
		{
			value: "anthropic",
			label: "Anthropic",
			hint: "anthropicCompatibleEndpoint",
		},
		{
			value: "vertex",
			label: "Vertex AI",
			hint: "vertexProviderHint",
		},
	],
	customProvidersDescription: "addThirdPartyAnthropicCompatibleModels",
	useCustomProviders: () => useSettingsBackedProviders("claude"),
	fetchModels: (provider) =>
		fetchProviderModels("claude", provider.baseUrl, provider.apiKey),
	useSectionModels: () => useOfficialSectionModels("claude"),
};
