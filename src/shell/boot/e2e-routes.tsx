// E2E test scenarios — gated behind `?e2eScenario=...` and lazy-loaded
// so they don't weigh down the production bundle.
import { lazy, type ReactElement, Suspense } from "react";

const StreamingFooterOverlapScenario = lazy(() =>
	import("@/test/e2e-scenarios/streaming-footer-overlap").then((m) => ({
		default: m.StreamingFooterOverlapScenario,
	})),
);

const StreamingReasoningGapScenario = lazy(() =>
	import("@/test/e2e-scenarios/streaming-reasoning-gap").then((m) => ({
		default: m.StreamingReasoningGapScenario,
	})),
);

export function resolveE2eScenarioElement(): ReactElement | null {
	if (typeof window === "undefined") return null;
	const scenario = new URLSearchParams(window.location.search).get(
		"e2eScenario",
	);
	switch (scenario) {
		case "streaming-footer-overlap":
			return (
				<Suspense fallback={null}>
					<StreamingFooterOverlapScenario />
				</Suspense>
			);
		case "streaming-reasoning-gap":
			return (
				<Suspense fallback={null}>
					<StreamingReasoningGapScenario />
				</Suspense>
			);
		default:
			return null;
	}
}
