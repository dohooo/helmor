import type { AgentProvider, ProviderCapabilities } from "@/lib/api";
import { DEFAULT_PROVIDER_CAPABILITIES } from "@/lib/api";

/** Canonical list — derived from [`DEFAULT_PROVIDER_CAPABILITIES`], not hand-maintained. */
export const AGENT_PROVIDERS = DEFAULT_PROVIDER_CAPABILITIES.map(
	(caps) => caps.provider,
) as readonly AgentProvider[];

/** Agent providers disabled as Helmor agents. Bundled CLIs stay shipped. */
export const DISABLED_AGENT_PROVIDERS: readonly AgentProvider[] = [];

export function isAgentProviderEnabled(provider: AgentProvider): boolean {
	return !DISABLED_AGENT_PROVIDERS.includes(provider);
}

export function enabledAgentProviders(): AgentProvider[] {
	return AGENT_PROVIDERS.filter(isAgentProviderEnabled);
}

export function enabledProviderCapabilities(): ProviderCapabilities[] {
	return DEFAULT_PROVIDER_CAPABILITIES.filter((caps) =>
		isAgentProviderEnabled(caps.provider),
	);
}
