import type { ProviderFamily } from "@/lib/provider-config";
import type { ProviderConfigAdapter } from "../provider-config";
import { CLAUDE_ADAPTER } from "./claude-adapter";
import { CODEX_ADAPTER } from "./codex-adapter";
import { KIMI_CONFIG_ADAPTER } from "./kimi-adapter";
import {
	MIMO_CONFIG_ADAPTER,
	OPENCODE_CONFIG_ADAPTER,
} from "./opencode-adapter";

const ADAPTERS: Record<ProviderFamily, ProviderConfigAdapter> = {
	claude: CLAUDE_ADAPTER,
	codex: CODEX_ADAPTER,
	opencode: OPENCODE_CONFIG_ADAPTER,
	mimo: MIMO_CONFIG_ADAPTER,
	kimi: KIMI_CONFIG_ADAPTER,
};

export function getProviderAdapter(
	family: ProviderFamily,
): ProviderConfigAdapter {
	return ADAPTERS[family];
}

export {
	CLAUDE_ADAPTER,
	CODEX_ADAPTER,
	KIMI_CONFIG_ADAPTER,
	MIMO_CONFIG_ADAPTER,
	OPENCODE_CONFIG_ADAPTER,
};
