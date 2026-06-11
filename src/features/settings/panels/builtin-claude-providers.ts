import type { ProviderBrandIconKey } from "@/components/icons";
import catalog from "@/shared/provider-catalog.json";

export type BuiltinClaudeProviderKey = string;

export type BuiltinClaudeProviderModel = {
	id: string;
	label: string;
};

export type BuiltinClaudeProvider = {
	key: BuiltinClaudeProviderKey;
	label: string;
	baseUrl: string;
	apiKeyUrl: string;
	models: readonly BuiltinClaudeProviderModel[];
	icon: ProviderBrandIconKey;
};

export const BUILTIN_CLAUDE_PROVIDERS =
	catalog.claude as readonly BuiltinClaudeProvider[];

export function findBuiltinClaudeProvider(key: BuiltinClaudeProviderKey) {
	return BUILTIN_CLAUDE_PROVIDERS.find((provider) => provider.key === key);
}
