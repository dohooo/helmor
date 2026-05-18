import providers from "@/shared/builtin-claude-providers.json";

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
	icon: "minimax" | "moonshot" | "deepseek" | "zhipu" | "qwen" | "xiaomi";
};

export const BUILTIN_CLAUDE_PROVIDERS =
	providers as readonly BuiltinClaudeProvider[];

export function findBuiltinClaudeProvider(key: BuiltinClaudeProviderKey) {
	return BUILTIN_CLAUDE_PROVIDERS.find((provider) => provider.key === key);
}
