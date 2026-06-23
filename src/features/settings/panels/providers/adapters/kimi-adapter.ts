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
	caps: { baseUrlEditable: true, apiStyleSelectable: true },
	// Kimi's `type` field — the wire protocol. `google-genai` / `vertexai` need
	// a different input flow (no api_key / env table) and aren't offered here.
	styleLabel: "providerType",
	styleOptions: [
		{
			value: "openai",
			label: "OpenAI",
			hint: "openaiChatCompletions",
		},
		{
			value: "openai_responses",
			label: "OpenAI Responses",
			hint: "openaiResponsesApi",
		},
		{
			value: "anthropic",
			label: "Anthropic",
			hint: "anthropicMessagesApi",
		},
		{
			value: "kimi",
			label: "Kimi / Moonshot",
			hint: "moonshotOpenAICompatible",
		},
	],
	customProvidersDescription: "settingsAddEndpointProviderTypeBaseUrlKey",
	useCustomProviders: () => useKimiBackedProviders(),
	fetchModels: (provider) =>
		fetchProviderModels(
			"kimi",
			provider.baseUrl,
			provider.apiKey,
			provider.apiStyle,
		),
};
