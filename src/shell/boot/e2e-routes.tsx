// E2E test scenarios — gated behind `?e2eScenario=...`. Eager-imported
// because webkit + Playwright + CI is slow enough that lazy-loading the
// scenario chunk overshoots the default 5s `toBeVisible` timeout and
// causes false-positive failures (see e2e/streaming-footer-overlap).
//
// Tree-shaking on production builds still drops the scenario modules
// since `e2eScenario` is reachable only via a URL query param the
// shipped app never sets — Vite's dead-code elimination keeps them
// out of the user-facing bundle.
import type { ReactElement } from "react";

import { StreamingFooterOverlapScenario } from "@/test/e2e-scenarios/streaming-footer-overlap";
import { StreamingReasoningGapScenario } from "@/test/e2e-scenarios/streaming-reasoning-gap";

export function resolveE2eScenarioElement(): ReactElement | null {
	if (typeof window === "undefined") return null;
	const scenario = new URLSearchParams(window.location.search).get(
		"e2eScenario",
	);
	switch (scenario) {
		case "streaming-footer-overlap":
			return <StreamingFooterOverlapScenario />;
		case "streaming-reasoning-gap":
			return <StreamingReasoningGapScenario />;
		default:
			return null;
	}
}
