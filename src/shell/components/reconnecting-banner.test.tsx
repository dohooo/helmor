import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render-with-providers";

// The banner reads transport + connection state from `@/lib/ipc`. Mock that
// module so a test can drive both independently (real `getCompanionConnectionState`
// is fed by the SSE loop, which doesn't run under jsdom).
const ipcState = {
	remote: true,
	connection: "online" as "online" | "connecting" | "reconnecting",
};

vi.mock("@/lib/ipc", () => ({
	isRemoteTransport: () => ipcState.remote,
	getCompanionConnectionState: () => ipcState.connection,
	// useSyncExternalStore never re-subscribes within a single static render, so
	// a no-op subscribe is enough for these snapshot-at-mount assertions.
	subscribeCompanionConnection: () => () => {},
}));

async function importBanner() {
	const mod = await import("./reconnecting-banner");
	return mod.ReconnectingBanner;
}

describe("ReconnectingBanner", () => {
	beforeEach(() => {
		vi.resetModules();
		ipcState.remote = true;
		ipcState.connection = "online";
	});

	afterEach(() => {
		cleanup();
	});

	it("renders the reconnecting copy when remote + reconnecting", async () => {
		ipcState.remote = true;
		ipcState.connection = "reconnecting";
		const ReconnectingBanner = await importBanner();
		renderWithProviders(<ReconnectingBanner />);

		expect(screen.getByRole("status")).toBeInTheDocument();
		expect(
			screen.getByText("Reconnecting to the team sandbox…"),
		).toBeInTheDocument();
		// The reassuring "it's just waking up" sub-line — this is a loading state.
		expect(
			screen.getByText(/take a moment while the sandbox wakes up/i),
		).toBeInTheDocument();
	});

	it("renders the switch-specific connecting copy when remote + connecting", async () => {
		ipcState.remote = true;
		ipcState.connection = "connecting";
		const ReconnectingBanner = await importBanner();
		renderWithProviders(<ReconnectingBanner />);

		// Fresh entry into team mode (the user just switched) gets the friendlier
		// "Connecting to your team workspace…" copy, per the in-app loading state.
		expect(screen.getByRole("status")).toBeInTheDocument();
		expect(
			screen.getByText("Connecting to your team workspace…"),
		).toBeInTheDocument();
		expect(
			screen.getByText(/take a moment while the sandbox wakes up/i),
		).toBeInTheDocument();
		// NOT the reconnecting copy.
		expect(
			screen.queryByText("Reconnecting to the team sandbox…"),
		).not.toBeInTheDocument();
	});

	it("renders nothing in single-user / native mode, even if state were reconnecting", async () => {
		ipcState.remote = false;
		ipcState.connection = "reconnecting";
		const ReconnectingBanner = await importBanner();
		const { container } = renderWithProviders(<ReconnectingBanner />);

		expect(screen.queryByRole("status")).not.toBeInTheDocument();
		expect(container).toBeEmptyDOMElement();
	});

	it("renders nothing while remote + online (no flash when healthy)", async () => {
		ipcState.remote = true;
		ipcState.connection = "online";
		const ReconnectingBanner = await importBanner();
		const { container } = renderWithProviders(<ReconnectingBanner />);

		expect(container).toBeEmptyDOMElement();
	});

	it("exposes no un-affordanced clickables (purely informational, self-resolving)", async () => {
		ipcState.remote = true;
		ipcState.connection = "reconnecting";
		const ReconnectingBanner = await importBanner();
		renderWithProviders(<ReconnectingBanner />);

		// The banner is a transient loading state with no actions. Guard the
		// codebase rule that every clickable carries `cursor-pointer`: any button
		// or link added here later must include it.
		const clickables = [
			...screen.queryAllByRole("button"),
			...screen.queryAllByRole("link"),
		];
		for (const el of clickables) {
			expect(el.className).toContain("cursor-pointer");
		}
		expect(clickables).toHaveLength(0);
	});

	it("re-fetches active streams on the reconnecting → online transition", async () => {
		ipcState.remote = true;
		ipcState.connection = "reconnecting";
		const ReconnectingBanner = await importBanner();
		const { queryClient, rerender } = renderWithProviders(
			<ReconnectingBanner />,
		);
		const invalidate = vi.spyOn(queryClient, "invalidateQueries");

		// Recovery: the SSE stream re-opened. The fallback invalidate must fire so
		// `use-watch-session-stream` re-attaches to the R2-restored sandbox DB even
		// if the backend's `ActiveStreamsChanged` re-emit is missed.
		ipcState.connection = "online";
		rerender(<ReconnectingBanner />);

		expect(invalidate).toHaveBeenCalledWith({ queryKey: ["activeStreams"] });
	});

	it("re-fetches active streams on the connecting → online transition (first connect after a switch)", async () => {
		ipcState.remote = true;
		ipcState.connection = "connecting";
		const ReconnectingBanner = await importBanner();
		const { queryClient, rerender } = renderWithProviders(
			<ReconnectingBanner />,
		);
		const invalidate = vi.spyOn(queryClient, "invalidateQueries");

		// First successful connect after switching into team mode must also
		// re-attach active streams (same fallback path as a reconnect).
		ipcState.connection = "online";
		rerender(<ReconnectingBanner />);

		expect(invalidate).toHaveBeenCalledWith({ queryKey: ["activeStreams"] });
	});
});
