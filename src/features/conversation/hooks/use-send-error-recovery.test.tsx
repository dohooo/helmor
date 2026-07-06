import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	__resetStreamingStoreForTests,
	useStreamingStore,
} from "../state/streaming-store";
import { useSendErrorRecovery } from "./use-send-error-recovery";

const readinessMocks = vi.hoisted(() => ({
	state: { state: "degraded" as string },
}));

vi.mock("@/lib/team-readiness", () => ({
	useTeamReadiness: () => readinessMocks.state,
}));

const CONTEXT = "session:s-1";

function setSendError(error: string) {
	useStreamingStore.getState().setSendError(CONTEXT, error);
}

function currentError() {
	return useStreamingStore.getState().sendErrorsByContext[CONTEXT] ?? null;
}

describe("useSendErrorRecovery (DF-5)", () => {
	beforeEach(() => {
		__resetStreamingStoreForTests();
		readinessMocks.state = { state: "degraded" };
	});

	it("clears a retryable (transport) send error when readiness transitions into ready", () => {
		setSendError("Load failed");
		const view = renderHook(() => useSendErrorRecovery(CONTEXT));
		expect(currentError()).toBe("Load failed");

		readinessMocks.state = { state: "ready" };
		view.rerender();
		expect(currentError()).toBeNull();
	});

	// Architect-mandated negative case: a provider-level error (backend
	// healthy, the TURN failed) must survive the ready transition — a
	// reconnect says nothing about it.
	it("does NOT clear a provider-level send error on the ready transition", () => {
		setSendError("Steer rejected: turn already completed");
		const view = renderHook(() => useSendErrorRecovery(CONTEXT));

		readinessMocks.state = { state: "ready" };
		view.rerender();
		expect(currentError()).toBe("Steer rejected: turn already completed");
	});

	it("auth/billing errors survive too (they need user action, not retry)", () => {
		setSendError("Request failed: Unauthorized");
		const view = renderHook(() => useSendErrorRecovery(CONTEXT));

		readinessMocks.state = { state: "ready" };
		view.rerender();
		expect(currentError()).toBe("Request failed: Unauthorized");
	});

	it("edge-triggered only: an error set while already ready is not swept by re-renders", () => {
		readinessMocks.state = { state: "ready" };
		const view = renderHook(() => useSendErrorRecovery(CONTEXT));
		setSendError("Load failed");
		view.rerender();
		expect(currentError()).toBe("Load failed");
	});
});
