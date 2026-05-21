import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UiMutationEvent } from "@/lib/api";
import { renderWithProviders } from "@/test/render-with-providers";

const apiMocks = vi.hoisted(() => ({
	subscribeUiMutations: vi.fn(),
	tailRemoteDaemonLog: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();
	return {
		...actual,
		subscribeUiMutations: apiMocks.subscribeUiMutations,
		tailRemoteDaemonLog: apiMocks.tailRemoteDaemonLog,
	};
});

import { RemoteCrashLoopBanner } from "./remote-crash-loop-banner";

type Listener = (event: UiMutationEvent) => void;

/// Build a mock subscriber so the test can fire synthetic events
/// into the banner's event listener.
function buildSubscribeMock() {
	let listener: Listener | null = null;
	const unlisten = vi.fn();
	const subscribe = vi.fn(async (cb: Listener) => {
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

function crashLoopEvent(
	overrides: Partial<{
		name: string;
		restartCount: number;
		windowMs: number;
		recentStartsMs: number[];
	}> = {},
): UiMutationEvent {
	return {
		type: "remoteCrashLoopDetected",
		name: overrides.name ?? "dev.box",
		restartCount: overrides.restartCount ?? 3,
		windowMs: overrides.windowMs ?? 5 * 60 * 1000,
		recentStartsMs: overrides.recentStartsMs ?? [1, 2, 3],
	};
}

describe("RemoteCrashLoopBanner", () => {
	beforeEach(() => {
		apiMocks.subscribeUiMutations.mockReset();
		apiMocks.tailRemoteDaemonLog.mockReset();
		apiMocks.tailRemoteDaemonLog.mockResolvedValue({
			lines: ["line-1", "line-2"],
			truncated: false,
		});
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it("renders nothing when no crash-loop events have fired", async () => {
		const sub = buildSubscribeMock();
		apiMocks.subscribeUiMutations.mockImplementation(sub.subscribe);
		renderWithProviders(<RemoteCrashLoopBanner />);
		await waitFor(() => expect(sub.subscribe).toHaveBeenCalled());
		expect(screen.queryByTestId("remote-crash-loop-banner")).toBeNull();
	});

	it("renders a row when a remoteCrashLoopDetected event fires", async () => {
		const sub = buildSubscribeMock();
		apiMocks.subscribeUiMutations.mockImplementation(sub.subscribe);
		renderWithProviders(<RemoteCrashLoopBanner />);
		await waitFor(() => expect(sub.subscribe).toHaveBeenCalled());

		act(() => sub.fire(crashLoopEvent({ name: "dev.box", restartCount: 4 })));
		const row = await screen.findByTestId("remote-crash-loop-row-dev.box");
		expect(row).toHaveTextContent("dev.box");
		expect(row).toHaveTextContent("4 times");
		expect(row).toHaveTextContent("5m");
	});

	it("ignores non-crash-loop UiMutationEvents", async () => {
		const sub = buildSubscribeMock();
		apiMocks.subscribeUiMutations.mockImplementation(sub.subscribe);
		renderWithProviders(<RemoteCrashLoopBanner />);
		await waitFor(() => expect(sub.subscribe).toHaveBeenCalled());

		act(() => sub.fire({ type: "activeStreamsChanged" }));
		act(() => sub.fire({ type: "workspaceListChanged" }));
		expect(screen.queryByTestId("remote-crash-loop-banner")).toBeNull();
	});

	it("replaces a stale alert when the same runtime re-fires", async () => {
		const sub = buildSubscribeMock();
		apiMocks.subscribeUiMutations.mockImplementation(sub.subscribe);
		renderWithProviders(<RemoteCrashLoopBanner />);
		await waitFor(() => expect(sub.subscribe).toHaveBeenCalled());

		act(() => sub.fire(crashLoopEvent({ name: "dev.box", restartCount: 3 })));
		act(() => sub.fire(crashLoopEvent({ name: "dev.box", restartCount: 5 })));
		const row = await screen.findByTestId("remote-crash-loop-row-dev.box");
		// Second event's restartCount wins.
		expect(row).toHaveTextContent("5 times");
		// Still one row, not two — same runtime.
		const allRows = screen.getAllByTestId(/^remote-crash-loop-row-/);
		expect(allRows).toHaveLength(1);
	});

	it("stacks one row per affected runtime", async () => {
		const sub = buildSubscribeMock();
		apiMocks.subscribeUiMutations.mockImplementation(sub.subscribe);
		renderWithProviders(<RemoteCrashLoopBanner />);
		await waitFor(() => expect(sub.subscribe).toHaveBeenCalled());

		act(() => sub.fire(crashLoopEvent({ name: "dev.box" })));
		act(() => sub.fire(crashLoopEvent({ name: "staging" })));
		await screen.findByTestId("remote-crash-loop-row-dev.box");
		await screen.findByTestId("remote-crash-loop-row-staging");
	});

	it("dismisses an alert locally without firing the API again", async () => {
		const sub = buildSubscribeMock();
		apiMocks.subscribeUiMutations.mockImplementation(sub.subscribe);
		const user = userEvent.setup();
		renderWithProviders(<RemoteCrashLoopBanner />);
		await waitFor(() => expect(sub.subscribe).toHaveBeenCalled());

		act(() => sub.fire(crashLoopEvent({ name: "dev.box" })));
		await screen.findByTestId("remote-crash-loop-row-dev.box");

		await user.click(screen.getByTestId("remote-crash-loop-dismiss-dev.box"));
		await waitFor(() =>
			expect(screen.queryByTestId("remote-crash-loop-row-dev.box")).toBeNull(),
		);
	});

	it("opens the daemon log dialog when View log is clicked", async () => {
		const sub = buildSubscribeMock();
		apiMocks.subscribeUiMutations.mockImplementation(sub.subscribe);
		const user = userEvent.setup();
		renderWithProviders(<RemoteCrashLoopBanner />);
		await waitFor(() => expect(sub.subscribe).toHaveBeenCalled());

		act(() => sub.fire(crashLoopEvent({ name: "dev.box" })));
		await user.click(screen.getByTestId("remote-crash-loop-view-log-dev.box"));
		await waitFor(() =>
			expect(apiMocks.tailRemoteDaemonLog).toHaveBeenCalledWith("dev.box", 200),
		);
		const output = await screen.findByTestId("remote-crash-loop-log-output");
		expect(output).toHaveTextContent("line-1");
		expect(output).toHaveTextContent("line-2");
	});

	it("surfaces a fetch error in the log dialog without crashing the banner", async () => {
		apiMocks.tailRemoteDaemonLog.mockRejectedValueOnce(
			new Error("daemon log file not found"),
		);
		const sub = buildSubscribeMock();
		apiMocks.subscribeUiMutations.mockImplementation(sub.subscribe);
		const user = userEvent.setup();
		renderWithProviders(<RemoteCrashLoopBanner />);
		await waitFor(() => expect(sub.subscribe).toHaveBeenCalled());

		act(() => sub.fire(crashLoopEvent({ name: "dev.box" })));
		await user.click(screen.getByTestId("remote-crash-loop-view-log-dev.box"));
		const errorBlock = await screen.findByTestId("remote-crash-loop-log-error");
		expect(errorBlock).toHaveTextContent("daemon log file not found");
		// Banner row still present — the dialog error is local.
		expect(
			screen.getByTestId("remote-crash-loop-row-dev.box"),
		).toBeInTheDocument();
	});

	it("unsubscribes the UI listener on unmount", async () => {
		const sub = buildSubscribeMock();
		apiMocks.subscribeUiMutations.mockImplementation(sub.subscribe);
		const { unmount } = renderWithProviders(<RemoteCrashLoopBanner />);
		await waitFor(() => expect(sub.subscribe).toHaveBeenCalled());
		unmount();
		await waitFor(() => expect(sub.unlisten).toHaveBeenCalled());
	});
});
