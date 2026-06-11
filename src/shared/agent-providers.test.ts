import { describe, expect, it } from "vitest";
import { DEFAULT_PROVIDER_CAPABILITIES } from "@/lib/api";
import {
	AGENT_PROVIDERS,
	DISABLED_AGENT_PROVIDERS,
	enabledAgentProviders,
	enabledProviderCapabilities,
	isAgentProviderEnabled,
} from "@/shared/agent-providers";

describe("agent-providers registry", () => {
	it("derives AGENT_PROVIDERS from DEFAULT_PROVIDER_CAPABILITIES", () => {
		expect(AGENT_PROVIDERS).toEqual(
			DEFAULT_PROVIDER_CAPABILITIES.map((caps) => caps.provider),
		);
	});

	it("keeps every provider enabled when DISABLED_AGENT_PROVIDERS is empty", () => {
		expect(DISABLED_AGENT_PROVIDERS).toEqual([]);
		expect(enabledAgentProviders()).toEqual([
			"claude",
			"codex",
			"cursor",
			"opencode",
		]);
		for (const provider of AGENT_PROVIDERS) {
			expect(isAgentProviderEnabled(provider)).toBe(true);
		}
	});

	it("enabledProviderCapabilities mirrors enabledAgentProviders", () => {
		expect(enabledProviderCapabilities().map((caps) => caps.provider)).toEqual(
			enabledAgentProviders(),
		);
	});
});
