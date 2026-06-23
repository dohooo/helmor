import type { ProviderBrandIconKey } from "@/components/icons";
import catalog from "@/shared/provider-catalog.json";

export type OpencodeProviderPreset = {
	/** Canonical models.dev provider id (the `provider.<key>` config key). */
	key: string;
	label: string;
	icon: ProviderBrandIconKey;
	apiKeyUrl?: string;
};

export const OPENCODE_PROVIDER_NPM = "@ai-sdk/openai-compatible";

export const OPENCODE_RESPONSES_NPM = "@ai-sdk/openai";

export const OPENCODE_API_STYLES = [
	{
		npm: OPENCODE_PROVIDER_NPM,
		label: "Chat Completions",
		hint: "/v1/chat/completions — widest compatibility.",
	},
	{
		npm: OPENCODE_RESPONSES_NPM,
		label: "Responses API",
		hint: "/v1/responses — advanced reasoning & tools.",
	},
] as const;

// Dropdown order IS the catalog order — no runtime sort. "Custom" is rendered separately and always first.
export const OPENCODE_PROVIDER_PRESETS =
	catalog.opencode as readonly OpencodeProviderPreset[];

export function findOpencodePreset(key: string) {
	return OPENCODE_PROVIDER_PRESETS.find((preset) => preset.key === key);
}
