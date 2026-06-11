/** Keep in sync with `KNOWN_PROVIDERS` in `provider_capabilities.rs`. */
export const AGENT_PROVIDERS = [
	"claude",
	"codex",
	"cursor",
	"opencode",
] as const;

export type AgentProvider = (typeof AGENT_PROVIDERS)[number];

/** Agent providers disabled as Helmor agents. Bundled CLIs stay shipped. */
export const DISABLED_AGENT_PROVIDERS: readonly AgentProvider[] = [];

export function isAgentProviderEnabled(provider: AgentProvider): boolean {
	return !DISABLED_AGENT_PROVIDERS.includes(provider);
}

export function enabledAgentProviders(): AgentProvider[] {
	return AGENT_PROVIDERS.filter(isAgentProviderEnabled);
}
