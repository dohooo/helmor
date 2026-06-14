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
	styleLabel: "Provider type",
	styleOptions: [
		{
			value: "openai",
			label: "OpenAI",
			hint: "OpenAI Chat Completions (/v1/chat/completions).",
		},
		{
			value: "openai_responses",
			label: "OpenAI Responses",
			hint: "OpenAI Responses API (/v1/responses).",
		},
		{
			value: "anthropic",
			label: "Anthropic",
			hint: "Anthropic Messages API.",
		},
		{
			value: "kimi",
			label: "Kimi / Moonshot",
			hint: "Moonshot's OpenAI-compatible API.",
		},
	],
	customProvidersDescription:
		"Add an endpoint (provider type + base URL + key), then fetch its models. Saved to ~/.kimi-code/config.toml.",
	useCustomProviders: () => useKimiBackedProviders(),
	fetchModels: (provider) =>
		fetchProviderModels(
			"kimi",
			provider.baseUrl,
			provider.apiKey,
			provider.apiStyle,
		),
};
