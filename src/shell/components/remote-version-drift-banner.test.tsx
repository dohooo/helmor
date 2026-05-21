import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UiMutationEvent } from "@/lib/api";
import { renderWithProviders } from "@/test/render-with-providers";

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

import { RemoteVersionDriftBanner } from "./remote-version-drift-banner";

type Listener = (event: UiMutationEvent) => void;

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

function driftEvent(
	overrides: Partial<{
		name: string;
		daemonVersion: string;
		desktopVersion: string;
	}> = {},
): UiMutationEvent {
	return {
		type: "remoteServerVersionDrift",
		name: overrides.name ?? "dev.box",
		daemonVersion: overrides.daemonVersion ?? "0.21.0",
		desktopVersion: overrides.desktopVersion ?? "0.22.1",
	};
}

describe("RemoteVersionDriftBanner", () => {
	beforeEach(() => {
		apiMocks.subscribeUiMutations.mockReset();
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it("renders nothing until a drift event fires", async () => {
		const sub = buildSubscribeMock();
		apiMocks.subscribeUiMutations.mockImplementation(sub.subscribe);
		renderWithProviders(<RemoteVersionDriftBanner />);
		await waitFor(() => expect(sub.subscribe).toHaveBeenCalled());
		expect(screen.queryByTestId("remote-version-drift-banner")).toBeNull();
	});

	it("renders a row with both versions when a drift event fires", async () => {
		const sub = buildSubscribeMock();
		apiMocks.subscribeUiMutations.mockImplementation(sub.subscribe);
		renderWithProviders(<RemoteVersionDriftBanner />);
		await waitFor(() => expect(sub.subscribe).toHaveBeenCalled());
		act(() =>
			sub.fire(
				driftEvent({
					name: "dev.box",
					daemonVersion: "0.21.0",
					desktopVersion: "0.22.1",
				}),
			),
		);
		const row = await screen.findByTestId("remote-version-drift-row-dev.box");
		expect(row).toHaveTextContent("0.21.0");
		expect(row).toHaveTextContent("0.22.1");
	});

	it("ignores unrelated UiMutationEvent variants", async () => {
		const sub = buildSubscribeMock();
		apiMocks.subscribeUiMutations.mockImplementation(sub.subscribe);
		renderWithProviders(<RemoteVersionDriftBanner />);
		await waitFor(() => expect(sub.subscribe).toHaveBeenCalled());
		act(() => sub.fire({ type: "activeStreamsChanged" }));
		act(() =>
			sub.fire({
				type: "remoteCrashLoopDetected",
				name: "dev.box",
				restartCount: 3,
				windowMs: 1000,
				recentStartsMs: [],
			}),
		);
		expect(screen.queryByTestId("remote-version-drift-banner")).toBeNull();
	});

	it("replaces a stale row when the same runtime re-fires", async () => {
		const sub = buildSubscribeMock();
		apiMocks.subscribeUiMutations.mockImplementation(sub.subscribe);
		renderWithProviders(<RemoteVersionDriftBanner />);
		await waitFor(() => expect(sub.subscribe).toHaveBeenCalled());
		act(() =>
			sub.fire(driftEvent({ name: "dev.box", daemonVersion: "0.20.0" })),
		);
		act(() =>
			sub.fire(driftEvent({ name: "dev.box", daemonVersion: "0.21.0" })),
		);
		const row = await screen.findByTestId("remote-version-drift-row-dev.box");
		// Second event's daemonVersion wins.
		expect(row).toHaveTextContent("0.21.0");
		expect(row).not.toHaveTextContent("0.20.0");
		// Still one row.
		const allRows = screen.getAllByTestId(/^remote-version-drift-row-/);
		expect(allRows).toHaveLength(1);
	});

	it("stacks one row per affected runtime", async () => {
		const sub = buildSubscribeMock();
		apiMocks.subscribeUiMutations.mockImplementation(sub.subscribe);
		renderWithProviders(<RemoteVersionDriftBanner />);
		await waitFor(() => expect(sub.subscribe).toHaveBeenCalled());
		act(() => sub.fire(driftEvent({ name: "dev.box" })));
		act(() => sub.fire(driftEvent({ name: "staging" })));
		await screen.findByTestId("remote-version-drift-row-dev.box");
		await screen.findByTestId("remote-version-drift-row-staging");
	});

	it("dismisses the alert locally", async () => {
		const sub = buildSubscribeMock();
		apiMocks.subscribeUiMutations.mockImplementation(sub.subscribe);
		const user = userEvent.setup();
		renderWithProviders(<RemoteVersionDriftBanner />);
		await waitFor(() => expect(sub.subscribe).toHaveBeenCalled());
		act(() => sub.fire(driftEvent({ name: "dev.box" })));
		await screen.findByTestId("remote-version-drift-row-dev.box");
		await user.click(
			screen.getByTestId("remote-version-drift-dismiss-dev.box"),
		);
		await waitFor(() =>
			expect(
				screen.queryByTestId("remote-version-drift-row-dev.box"),
			).toBeNull(),
		);
	});

	it("unsubscribes on unmount", async () => {
		const sub = buildSubscribeMock();
		apiMocks.subscribeUiMutations.mockImplementation(sub.subscribe);
		const { unmount } = renderWithProviders(<RemoteVersionDriftBanner />);
		await waitFor(() => expect(sub.subscribe).toHaveBeenCalled());
		unmount();
		await waitFor(() => expect(sub.unlisten).toHaveBeenCalled());
	});
});
