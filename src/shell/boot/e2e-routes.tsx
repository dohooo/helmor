// E2E test scenarios — gated behind `?e2eScenario=...`. Each scenario
// renders standalone (no MainApp providers), so we wrap it in a
// throwaway QueryClient: thread-viewport's `useQueryClient` call would
// otherwise throw "No QueryClient set" and the scenario tree never
// mounts, breaking the Playwright tests that look for its heading.
//
// Eager-imported because webkit + Playwright + CI is slow enough that
// lazy-loading the scenario chunk overshoots the default 5s
// `toBeVisible` timeout.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { StreamingFooterOverlapScenario } from "@/test/e2e-scenarios/streaming-footer-overlap";
import { StreamingReasoningGapScenario } from "@/test/e2e-scenarios/streaming-reasoning-gap";

// Module-level: scenarios run once per page load, so a single client is
// fine. Disable retries to make any IPC failure surface immediately.
const e2eQueryClient = new QueryClient({
	defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});

export function resolveE2eScenarioElement(): ReactElement | null {
	if (typeof window === "undefined") return null;
	const scenario = new URLSearchParams(window.location.search).get(
		"e2eScenario",
	);
	const child = renderScenario(scenario);
	if (!child) return null;
	return (
		<QueryClientProvider client={e2eQueryClient}>{child}</QueryClientProvider>
	);
}

function renderScenario(scenario: string | null): ReactElement | null {
	switch (scenario) {
		case "streaming-footer-overlap":
			return <StreamingFooterOverlapScenario />;
		case "streaming-reasoning-gap":
			return <StreamingReasoningGapScenario />;
		default:
			return null;
	}
}
