import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEntry, UiMutationEvent } from "@/lib/api";
import { renderWithProviders } from "@/test/render-with-providers";

const apiMocks = vi.hoisted(() => ({
	listRemoteRuntimes: vi.fn(),
	reconnectRemoteRuntime: vi.fn(),
	subscribeUiMutations: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();
	return {
		...actual,
		listRemoteRuntimes: apiMocks.listRemoteRuntimes,
		reconnectRemoteRuntime: apiMocks.reconnectRemoteRuntime,
		subscribeUiMutations: apiMocks.subscribeUiMutations,
	};
});

import { RemoteConnectionBanner } from "./remote-connection-banner";

const CONNECTED_LOCAL: RuntimeEntry = {
	name: "local",
	isLocal: true,
	state: { type: "connected" },
};
const CONNECTED_REMOTE: RuntimeEntry = {
	name: "dev.box",
	isLocal: false,
	state: { type: "connected" },
};
const DEGRADED_REMOTE: RuntimeEntry = {
	name: "dev.box",
	isLocal: false,
	state: { type: "degraded", reason: "ping timeout" },
};
const DISCONNECTED_REMOTE: RuntimeEntry = {
	name: "dev.box",
	isLocal: false,
	state: { type: "disconnected", reason: "ssh exited 255" },
};

describe("RemoteConnectionBanner", () => {
	beforeEach(() => {
		apiMocks.listRemoteRuntimes.mockReset();
		apiMocks.reconnectRemoteRuntime.mockReset();
		apiMocks.subscribeUiMutations.mockReset();
		apiMocks.subscribeUiMutations.mockResolvedValue(() => {});
		apiMocks.reconnectRemoteRuntime.mockResolvedValue({
			kind: { type: "remote", host: "dev.box" },
			hostname: "dev.box",
			version: "0.0.0",
		});
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it("renders nothing when every remote is connected", async () => {
		apiMocks.listRemoteRuntimes.mockResolvedValue([
			CONNECTED_LOCAL,
			CONNECTED_REMOTE,
		]);
		renderWithProviders(<RemoteConnectionBanner />);
		// The banner is only mounted when there's offline state, so
		// asserting absence under a polite wait window is sufficient
		// — a non-zero render would have flashed.
		await waitFor(() => {
			expect(screen.queryByTestId("remote-connection-banner")).toBeNull();
		});
	});

	it("renders a row for each disconnected or degraded remote", async () => {
		apiMocks.listRemoteRuntimes.mockResolvedValue([
			CONNECTED_LOCAL,
			DEGRADED_REMOTE,
			{ ...DISCONNECTED_REMOTE, name: "vps-2" },
		]);
		renderWithProviders(<RemoteConnectionBanner />);
		const banner = await screen.findByTestId("remote-connection-banner");
		expect(banner).toBeInTheDocument();
		expect(banner.textContent).toContain("Degraded");
		expect(banner.textContent).toContain("dev.box");
		expect(banner.textContent).toContain("Disconnected");
		expect(banner.textContent).toContain("vps-2");
		expect(banner.textContent).toContain("ping timeout");
		expect(banner.textContent).toContain("ssh exited 255");
	});

	it("clicking Reconnect now invokes reconnect_remote_runtime", async () => {
		const user = userEvent.setup();
		apiMocks.listRemoteRuntimes.mockResolvedValue([
			CONNECTED_LOCAL,
			DISCONNECTED_REMOTE,
		]);
		renderWithProviders(<RemoteConnectionBanner />);
		await screen.findByTestId("remote-connection-banner");
		await user.click(
			screen.getByRole("button", { name: /Reconnect dev\.box now/ }),
		);
		await waitFor(() => {
			expect(apiMocks.reconnectRemoteRuntime).toHaveBeenCalledWith("dev.box");
		});
	});

	it("auto-dismisses once every remote returns to connected", async () => {
		// Initial render: one disconnected. After the list refetches
		// with the entry back to Connected the banner unmounts.
		apiMocks.listRemoteRuntimes.mockResolvedValueOnce([
			CONNECTED_LOCAL,
			DISCONNECTED_REMOTE,
		]);
		const { queryClient } = renderWithProviders(<RemoteConnectionBanner />);
		await screen.findByTestId("remote-connection-banner");

		apiMocks.listRemoteRuntimes.mockResolvedValue([
			CONNECTED_LOCAL,
			CONNECTED_REMOTE,
		]);
		await act(async () => {
			await queryClient.invalidateQueries({ queryKey: ["remote-runtimes"] });
		});
		await waitFor(() => {
			expect(screen.queryByTestId("remote-connection-banner")).toBeNull();
		});
	});

	it("surfaces auto-retry status from remoteReconnectAttempt events", async () => {
		// Subscribe call returns a captured callback the test fires
		// to simulate the backend's per-attempt notifications.
		let listener: ((event: UiMutationEvent) => void) | null = null;
		apiMocks.subscribeUiMutations.mockImplementation(
			async (cb: (event: UiMutationEvent) => void) => {
				listener = cb;
				return () => {};
			},
		);
		apiMocks.listRemoteRuntimes.mockResolvedValue([
			CONNECTED_LOCAL,
			DISCONNECTED_REMOTE,
		]);
		renderWithProviders(<RemoteConnectionBanner />);
		await screen.findByTestId("remote-connection-banner");

		// Fire an "in flight" event — the row should pick up the
		// retry message.
		expect(listener).not.toBeNull();
		await act(async () => {
			listener?.({
				type: "remoteReconnectAttempt",
				name: "dev.box",
				attempt: 1,
				succeeded: null,
			});
		});
		expect(
			(await screen.findByTestId("remote-connection-banner-row-dev.box"))
				.textContent,
		).toContain("auto-retry #1 in progress");

		// Resolve as failure — message flips to "failed".
		await act(async () => {
			listener?.({
				type: "remoteReconnectAttempt",
				name: "dev.box",
				attempt: 1,
				succeeded: false,
			});
		});
		expect(
			(await screen.findByTestId("remote-connection-banner-row-dev.box"))
				.textContent,
		).toContain("auto-retry #1 failed");
	});
});
