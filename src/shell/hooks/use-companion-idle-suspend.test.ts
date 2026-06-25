import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	suspendEventStream: vi.fn(),
	resumeEventStream: vi.fn(),
	isTeamModeActive: vi.fn(() => true),
	getState: vi.fn(() => ({
		sendingContextKeys: new Set<string>(),
		activeSessionByContext: {} as Record<string, unknown>,
	})),
}));

vi.mock("@/lib/ipc", () => ({
	suspendEventStream: mocks.suspendEventStream,
	resumeEventStream: mocks.resumeEventStream,
}));
vi.mock("@/lib/team-mode", () => ({
	isTeamModeActive: mocks.isTeamModeActive,
}));
vi.mock("@/features/conversation/state/streaming-store", () => ({
	useStreamingStore: { getState: mocks.getState },
}));

import { useCompanionIdleSuspend } from "./use-companion-idle-suspend";

const VISIBLE_IDLE_MS = 10 * 60_000;
const HIDDEN_MS = 60_000;

function setVisibility(state: "visible" | "hidden") {
	Object.defineProperty(document, "visibilityState", {
		value: state,
		configurable: true,
	});
	act(() => {
		document.dispatchEvent(new Event("visibilitychange"));
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	Object.defineProperty(document, "visibilityState", {
		value: "visible",
		configurable: true,
	});
});
afterEach(() => {
	cleanup(); // unmount prior renderHook so its window listeners don't leak
	vi.clearAllMocks();
	vi.useRealTimers();
	mocks.getState.mockReturnValue({
		sendingContextKeys: new Set<string>(),
		activeSessionByContext: {},
	});
});

describe("useCompanionIdleSuspend", () => {
	it("suspends the SSE after the window is visible but idle", () => {
		renderHook(() => useCompanionIdleSuspend());
		expect(mocks.suspendEventStream).not.toHaveBeenCalled();
		act(() => vi.advanceTimersByTime(VISIBLE_IDLE_MS));
		expect(mocks.suspendEventStream).toHaveBeenCalledTimes(1);
	});

	it("activity resumes a suspended stream and re-arms the idle timer", () => {
		renderHook(() => useCompanionIdleSuspend());
		act(() => vi.advanceTimersByTime(VISIBLE_IDLE_MS));
		expect(mocks.suspendEventStream).toHaveBeenCalledTimes(1);

		act(() => window.dispatchEvent(new Event("pointerdown")));
		expect(mocks.resumeEventStream).toHaveBeenCalled();

		// Re-armed: idling again suspends again.
		act(() => vi.advanceTimersByTime(VISIBLE_IDLE_MS));
		expect(mocks.suspendEventStream).toHaveBeenCalledTimes(2);
	});

	it("never suspends mid-turn; retries once the turn settles", () => {
		mocks.getState.mockReturnValue({
			sendingContextKeys: new Set(["ctx"]),
			activeSessionByContext: {},
		});
		renderHook(() => useCompanionIdleSuspend());
		act(() => vi.advanceTimersByTime(VISIBLE_IDLE_MS));
		expect(mocks.suspendEventStream).not.toHaveBeenCalled(); // deferred

		mocks.getState.mockReturnValue({
			sendingContextKeys: new Set<string>(),
			activeSessionByContext: {},
		});
		act(() => vi.advanceTimersByTime(HIDDEN_MS)); // retry interval
		expect(mocks.suspendEventStream).toHaveBeenCalledTimes(1);
	});

	it("suspends after the window is hidden for the grace period", () => {
		renderHook(() => useCompanionIdleSuspend());
		setVisibility("hidden");
		act(() => vi.advanceTimersByTime(HIDDEN_MS));
		expect(mocks.suspendEventStream).toHaveBeenCalledTimes(1);
	});

	it("is inert outside team mode", () => {
		mocks.isTeamModeActive.mockReturnValue(false);
		renderHook(() => useCompanionIdleSuspend());
		act(() => vi.advanceTimersByTime(VISIBLE_IDLE_MS));
		expect(mocks.suspendEventStream).not.toHaveBeenCalled();
	});
});
