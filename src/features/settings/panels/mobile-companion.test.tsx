import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanionPairingPayload, CompanionStatus } from "@/lib/api";
import { renderWithProviders } from "@/test/render-with-providers";
import { MobileCompanionPanel } from "./mobile-companion";

const apiMocks = vi.hoisted(() => ({
	getCompanionStatus: vi.fn(),
	listPairedDevices: vi.fn(),
	enableCompanion: vi.fn(),
	pairCompanionDevice: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();
	return {
		...actual,
		getCompanionStatus: apiMocks.getCompanionStatus,
		listPairedDevices: apiMocks.listPairedDevices,
		enableCompanion: apiMocks.enableCompanion,
		pairCompanionDevice: apiMocks.pairCompanionDevice,
	};
});

function status(overrides: Partial<CompanionStatus>): CompanionStatus {
	return {
		running: false,
		addr: null,
		publicUrl: null,
		mode: "none",
		stableHost: null,
		signedIn: false,
		...overrides,
	};
}

const PAIRING: CompanionPairingPayload = {
	deviceId: "device-1",
	label: "Device",
	pat: "hlm_test",
	url: "https://example.trycloudflare.com/#pair=hlm_test",
};

describe("MobileCompanionPanel tunnel bootstrap", () => {
	beforeEach(() => {
		apiMocks.listPairedDevices.mockResolvedValue([]);
		apiMocks.pairCompanionDevice.mockResolvedValue(PAIRING);
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("starts the tunnel when the server is up but has no public URL", async () => {
		// Regression: with HELMOR_COMPANION the server auto-starts loopback-only,
		// so status reports running=true / publicUrl=null. The panel must still
		// enable to bring the tunnel up — otherwise the QR stays on "Preparing…".
		const withTunnel = status({
			running: true,
			addr: "127.0.0.1:5000",
			publicUrl: "https://example.trycloudflare.com",
			mode: "quick",
		});
		apiMocks.getCompanionStatus
			.mockResolvedValueOnce(status({ running: true, addr: "127.0.0.1:5000" }))
			.mockResolvedValue(withTunnel);
		apiMocks.enableCompanion.mockResolvedValue(withTunnel);

		renderWithProviders(<MobileCompanionPanel />);

		await waitFor(() => expect(apiMocks.enableCompanion).toHaveBeenCalled());
	});

	it("does not re-enable when a public URL is already present", async () => {
		apiMocks.getCompanionStatus.mockResolvedValue(
			status({
				running: true,
				addr: "127.0.0.1:5000",
				publicUrl: "https://example.trycloudflare.com",
				mode: "quick",
			}),
		);

		renderWithProviders(<MobileCompanionPanel />);

		// Pairing only fires once a public URL exists, so awaiting it proves the
		// effects settled — and enable must have been skipped.
		await waitFor(() =>
			expect(apiMocks.pairCompanionDevice).toHaveBeenCalled(),
		);
		expect(apiMocks.enableCompanion).not.toHaveBeenCalled();
	});

	it("uses device copy and centers the empty paired-device state", async () => {
		apiMocks.getCompanionStatus.mockResolvedValue(
			status({
				running: true,
				addr: "127.0.0.1:5000",
				publicUrl: "https://example.trycloudflare.com",
				mode: "quick",
			}),
		);

		renderWithProviders(<MobileCompanionPanel />);

		await waitFor(() =>
			expect(apiMocks.pairCompanionDevice).toHaveBeenCalled(),
		);
		expect(screen.getByText("Connect a device")).toBeInTheDocument();
		expect(
			screen.getByText(
				"Scan with your device's camera. The current temporary link changes after Helmor or the tunnel restarts.",
			),
		).toBeInTheDocument();
		const emptyState = screen.getByText("No devices paired yet.");
		expect(emptyState.parentElement).toHaveClass(
			"items-center",
			"justify-center",
			"text-center",
		);
		expect(screen.queryByText(/phone/i)).not.toBeInTheDocument();
	});
});
