import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CompanionAsleepError } from "@/lib/companion-asleep";
import { helmorQueryKeys } from "@/lib/query-client";
import { TeamConnectingOverlay } from "./team-connecting-overlay";

// Controllable readiness for the F-2 ready-transition effect.
const readinessMocks = vi.hoisted(() => ({
	state: {
		state: "degraded" as string,
		unauthorized: false,
		label: "",
		detail: "",
	},
}));

vi.mock("@/lib/team-readiness", () => ({
	ensureTeamReadinessProbe: vi.fn(),
	retryTeamReadiness: vi.fn(),
	useTeamReadiness: () => readinessMocks.state,
}));
vi.mock("@/lib/team-mode", () => ({ isTeamModeActive: () => true }));
vi.mock("@/lib/transport-generation", () => ({
	useTransportGeneration: () => 0,
}));
vi.mock("@/lib/team-switch", () => ({ switchTeamMode: vi.fn() }));
vi.mock("@/components/helmor-logo-animated", () => ({
	HelmorLogoAnimated: () => null,
}));

// Build a settled error-state query directly in the cache (the shape an
// asleep-rejected fetch leaves behind: typed error, retry off, data kept).
function buildErroredQuery(
	queryClient: QueryClient,
	queryKey: readonly unknown[],
	error: unknown,
) {
	const query = queryClient
		.getQueryCache()
		.build(queryClient, { queryKey: queryKey as unknown[] });
	query.setState({
		status: "error",
		error: error as Error,
		fetchStatus: "idle",
	});
	return query;
}

describe("TeamConnectingOverlay ready-transition revalidation (DF-3)", () => {
	beforeEach(() => {
		readinessMocks.state = {
			state: "degraded",
			unauthorized: false,
			label: "",
			detail: "",
		};
	});

	it("invalidates asleep-errored workspace list queries when readiness transitions into ready — but not non-asleep errors", () => {
		const queryClient = new QueryClient();
		const asleepSessions = buildErroredQuery(
			queryClient,
			helmorQueryKeys.workspaceSessions("ws-1"),
			new CompanionAsleepError(),
		);
		const asleepDetail = buildErroredQuery(
			queryClient,
			helmorQueryKeys.workspaceDetail("ws-1"),
			new CompanionAsleepError(),
		);
		// Provider-level failure: backend healthy, this specific fetch failed —
		// the ready transition must NOT sweep it back to fresh (negative case).
		const providerError = buildErroredQuery(
			queryClient,
			helmorQueryKeys.workspaceSessions("ws-2"),
			new Error("workspace row corrupt"),
		);
		// Success-state queries are untouched too.
		queryClient.setQueryData(helmorQueryKeys.workspaceSessions("ws-3"), []);

		const view = render(
			<QueryClientProvider client={queryClient}>
				<TeamConnectingOverlay />
			</QueryClientProvider>,
		);
		expect(asleepSessions.state.isInvalidated).toBe(false);

		readinessMocks.state = {
			state: "ready",
			unauthorized: false,
			label: "",
			detail: "",
		};
		view.rerender(
			<QueryClientProvider client={queryClient}>
				<TeamConnectingOverlay />
			</QueryClientProvider>,
		);

		expect(asleepSessions.state.isInvalidated).toBe(true);
		expect(asleepDetail.state.isInvalidated).toBe(true);
		expect(providerError.state.isInvalidated).toBe(false);
		expect(
			queryClient.getQueryState(helmorQueryKeys.workspaceSessions("ws-3"))
				?.isInvalidated,
		).toBe(false);
	});

	it("does not re-invalidate while staying ready (transition-edge only)", () => {
		const queryClient = new QueryClient();
		readinessMocks.state = {
			state: "ready",
			unauthorized: false,
			label: "",
			detail: "",
		};
		const view = render(
			<QueryClientProvider client={queryClient}>
				<TeamConnectingOverlay />
			</QueryClientProvider>,
		);
		// Query errors asleep AFTER we were already ready (e.g. mid-session
		// sleep); a mere re-render must not sweep it — only a fresh
		// degraded→ready edge does.
		const asleep = buildErroredQuery(
			queryClient,
			helmorQueryKeys.workspaceSessions("ws-1"),
			new CompanionAsleepError(),
		);
		view.rerender(
			<QueryClientProvider client={queryClient}>
				<TeamConnectingOverlay />
			</QueryClientProvider>,
		);
		expect(asleep.state.isInvalidated).toBe(false);
	});
});
