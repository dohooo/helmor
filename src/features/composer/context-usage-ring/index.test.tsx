import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHelmorQueryClient } from "@/lib/query-client";
import { useUiSyncBridge } from "@/shell/hooks/use-ui-sync-bridge";

// Stubs for the two API surfaces the ring + bridge use. We swap
// `getSessionContextUsage` between renders to simulate the DB row
// changing after a turn end — the ring should reflect the new value
// only if the bridge's invalidate actually triggered a refetch.
const apiMockState = vi.hoisted(() => ({
	getSessionContextUsage: vi.fn(),
	getLiveContextUsage: vi.fn(),
	subscribeUiMutations: vi.fn(),
	capturedCallback: null as null | ((event: unknown) => void),
}));

vi.mock("@/lib/api", async () => {
	const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
	return {
		...actual,
		getSessionContextUsage: apiMockState.getSessionContextUsage,
		getLiveContextUsage: apiMockState.getLiveContextUsage,
		subscribeUiMutations: apiMockState.subscribeUiMutations,
	};
});

import { ContextUsageRing } from "./index";

function Harness({
	sessionId,
	composerModelId = "gpt-5.4",
}: {
	sessionId: string;
	composerModelId?: string | null;
}) {
	const queryClient = createHelmorQueryClient();
	queryClient.setDefaultOptions({ queries: { retry: false } });
	return (
		<QueryClientProvider client={queryClient}>
			<BridgeHost queryClient={queryClient} />
			<ContextUsageRing
				sessionId={sessionId}
				providerSessionId={null}
				cwd={null}
				agentType="codex"
				composerModelId={composerModelId}
				alwaysShow={true}
			/>
		</QueryClientProvider>
	);
}

function BridgeHost({
	queryClient,
}: {
	queryClient: ReturnType<typeof createHelmorQueryClient>;
}) {
	useUiSyncBridge({
		queryClient,
		processPendingCliSends: vi.fn(),
		reloadSettings: vi.fn(),
	});
	return null;
}

describe("ContextUsageRing end-to-end with UI sync bridge", () => {
	beforeEach(() => {
		apiMockState.getSessionContextUsage.mockReset();
		apiMockState.getLiveContextUsage.mockReset();
		apiMockState.subscribeUiMutations.mockReset();
		apiMockState.capturedCallback = null;

		apiMockState.subscribeUiMutations.mockImplementation(
			async (callback: (event: unknown) => void) => {
				apiMockState.capturedCallback = callback;
			},
		);
	});

	afterEach(() => cleanup());

	it("refetches baseline from DB when contextUsageChanged fires, then re-renders with new %", async () => {
		// First read: no usage persisted yet (new session pre-turn).
		apiMockState.getSessionContextUsage.mockResolvedValueOnce(null);
		// Second read (after event): new meta from turn end. modelId stamp
		// matches the composer's current model so display resolves to `full`.
		apiMockState.getSessionContextUsage.mockResolvedValueOnce(
			JSON.stringify({
				modelId: "gpt-5.4",
				usedTokens: 23_363,
				maxTokens: 950_000,
				percentage: 2.46,
			}),
		);

		const { findByRole, getByLabelText } = render(
			<Harness sessionId="session-abc" />,
		);

		// Initial render: queryFn has resolved to null → display is empty →
		// aria-label is "Context usage" without a percentage.
		await findByRole("button", { name: /context usage/i });
		await waitFor(() => {
			expect(apiMockState.getSessionContextUsage).toHaveBeenCalledWith(
				"session-abc",
			);
		});
		expect(
			getByLabelText("Context usage", { exact: true }),
		).toBeInTheDocument();
		expect(apiMockState.getSessionContextUsage).toHaveBeenCalledTimes(1);

		// Fire the same event the Rust side publishes at turn end.
		// The bridge must translate it into an invalidate that causes the
		// ring's observer to refetch from the DB.
		act(() => {
			apiMockState.capturedCallback?.({
				type: "contextUsageChanged",
				sessionId: "session-abc",
			});
		});

		await waitFor(() => {
			expect(apiMockState.getSessionContextUsage).toHaveBeenCalledTimes(2);
		});
		// After refetch, aria-label reflects the new percentage.
		await findByRole("button", { name: /context usage 2%/i });
	});

	it("does not refetch when contextUsageChanged is for a different session", async () => {
		apiMockState.getSessionContextUsage.mockResolvedValue(
			JSON.stringify({
				modelId: "gpt-5.4",
				usedTokens: 10,
				maxTokens: 100,
				percentage: 10,
			}),
		);

		render(<Harness sessionId="session-abc" />);

		await waitFor(() => {
			expect(apiMockState.getSessionContextUsage).toHaveBeenCalledTimes(1);
		});

		act(() => {
			apiMockState.capturedCallback?.({
				type: "contextUsageChanged",
				sessionId: "session-other",
			});
		});

		// Give any potential refetch a tick to fire, then assert it didn't.
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(apiMockState.getSessionContextUsage).toHaveBeenCalledTimes(1);
	});

	it("degrades to tokensOnly aria-label when composer's model differs from the recorded one", async () => {
		apiMockState.getSessionContextUsage.mockResolvedValue(
			JSON.stringify({
				modelId: "gpt-5.4",
				usedTokens: 23_363,
				maxTokens: 950_000,
				percentage: 2.46,
			}),
		);

		const { findByRole, queryByRole } = render(
			<Harness
				sessionId="session-mismatch"
				composerModelId="gpt-5.5-preview"
			/>,
		);

		await findByRole("button", { name: "Context usage" });
		expect(queryByRole("button", { name: /2%/i })).toBeNull();
	});
});
