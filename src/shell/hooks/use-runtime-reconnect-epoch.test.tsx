import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
	subscribeUiMutations: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();
	return {
		...actual,
		subscribeUiMutations: apiMocks.subscribeUiMutations,
	};
});

import type { UiMutationEvent } from "@/lib/api";
import { useRuntimeReconnectEpoch } from "./use-runtime-reconnect-epoch";

type Unlisten = () => void;
type Listener = (event: UiMutationEvent) => void;

/// Build a mock that captures the registered listener so the test
/// can fire synthetic events through it.
function buildSubscribeMock() {
	let listener: Listener | null = null;
	const unlisten = vi.fn();
	const subscribe = vi.fn(async (cb: Listener): Promise<Unlisten> => {
		listener = cb;
		return unlisten;
	});
	return {
		subscribe,
		unlisten,
		fire: (event: UiMutationEvent) => {
			if (listener) listener(event);
		},
	};
}

describe("useRuntimeReconnectEpoch", () => {
	beforeEach(() => {
		apiMocks.subscribeUiMutations.mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("starts at 0 and never subscribes for the local runtime", () => {
		const sub = buildSubscribeMock();
		apiMocks.subscribeUiMutations.mockImplementation(sub.subscribe);
		const { result } = renderHook(() => useRuntimeReconnectEpoch("local"));
		expect(result.current).toBe(0);
		expect(sub.subscribe).not.toHaveBeenCalled();
	});

	it("starts at 0 and never subscribes when runtimeName is null", () => {
		const sub = buildSubscribeMock();
		apiMocks.subscribeUiMutations.mockImplementation(sub.subscribe);
		const { result } = renderHook(() => useRuntimeReconnectEpoch(null));
		expect(result.current).toBe(0);
		expect(sub.subscribe).not.toHaveBeenCalled();
	});

	it("increments on a matching succeeded:true reconnect event", async () => {
		const sub = buildSubscribeMock();
		apiMocks.subscribeUiMutations.mockImplementation(sub.subscribe);
		const { result } = renderHook(() => useRuntimeReconnectEpoch("dev.box"));
		await waitFor(() => expect(sub.subscribe).toHaveBeenCalled());

		expect(result.current).toBe(0);
		act(() => {
			sub.fire({
				type: "remoteReconnectAttempt",
				name: "dev.box",
				attempt: 1,
				succeeded: true,
			});
		});
		expect(result.current).toBe(1);
		act(() => {
			sub.fire({
				type: "remoteReconnectAttempt",
				name: "dev.box",
				attempt: 2,
				succeeded: true,
			});
		});
		expect(result.current).toBe(2);
	});

	it("ignores reconnects for other runtime names", async () => {
		const sub = buildSubscribeMock();
		apiMocks.subscribeUiMutations.mockImplementation(sub.subscribe);
		const { result } = renderHook(() => useRuntimeReconnectEpoch("dev.box"));
		await waitFor(() => expect(sub.subscribe).toHaveBeenCalled());

		act(() => {
			sub.fire({
				type: "remoteReconnectAttempt",
				name: "other.host",
				attempt: 1,
				succeeded: true,
			});
		});
		expect(result.current).toBe(0);
	});

	it("ignores in-flight + failed attempts", async () => {
		const sub = buildSubscribeMock();
		apiMocks.subscribeUiMutations.mockImplementation(sub.subscribe);
		const { result } = renderHook(() => useRuntimeReconnectEpoch("dev.box"));
		await waitFor(() => expect(sub.subscribe).toHaveBeenCalled());

		act(() => {
			sub.fire({
				type: "remoteReconnectAttempt",
				name: "dev.box",
				attempt: 1,
				succeeded: null,
			});
			sub.fire({
				type: "remoteReconnectAttempt",
				name: "dev.box",
				attempt: 1,
				succeeded: false,
			});
		});
		expect(result.current).toBe(0);
	});

	it("ignores unrelated UiMutationEvent types", async () => {
		const sub = buildSubscribeMock();
		apiMocks.subscribeUiMutations.mockImplementation(sub.subscribe);
		const { result } = renderHook(() => useRuntimeReconnectEpoch("dev.box"));
		await waitFor(() => expect(sub.subscribe).toHaveBeenCalled());

		act(() => {
			sub.fire({ type: "activeStreamsChanged" });
			sub.fire({ type: "workspaceListChanged" });
		});
		expect(result.current).toBe(0);
	});

	it("unsubscribes on unmount", async () => {
		const sub = buildSubscribeMock();
		apiMocks.subscribeUiMutations.mockImplementation(sub.subscribe);
		const { unmount } = renderHook(() => useRuntimeReconnectEpoch("dev.box"));
		await waitFor(() => expect(sub.subscribe).toHaveBeenCalled());
		unmount();
		// Subscribe's then-callback may resolve after unmount; the
		// hook stashes a `disposed` flag + calls the returned
		// unlisten on cleanup, so both ordering paths reach unlisten.
		await waitFor(() => expect(sub.unlisten).toHaveBeenCalled());
	});

	it("re-subscribes when runtimeName changes", async () => {
		const sub = buildSubscribeMock();
		apiMocks.subscribeUiMutations.mockImplementation(sub.subscribe);
		const { rerender } = renderHook(
			({ name }: { name: string }) => useRuntimeReconnectEpoch(name),
			{ initialProps: { name: "dev.box" } },
		);
		await waitFor(() => expect(sub.subscribe).toHaveBeenCalledTimes(1));
		rerender({ name: "other.host" });
		await waitFor(() => expect(sub.subscribe).toHaveBeenCalledTimes(2));
		// First subscription's unlisten fired on the name change.
		expect(sub.unlisten).toHaveBeenCalled();
	});
});
