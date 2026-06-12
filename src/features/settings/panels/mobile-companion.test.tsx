import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanionPairingPayload, CompanionStatus } from "@/lib/api";
import { renderWithProviders } from "@/test/render-with-providers";
import { MobileCompanionPanel } from "./mobile-companion";

const apiMocks = vi.hoisted(() => ({
	getCompanionStatus: vi.fn(),
	listPairedDevices: vi.fn(),
	disableCompanion: vi.fn(),
	disableCompanionTunnel: vi.fn(),
	enableCompanion: vi.fn(),
	enableLanCompanion: vi.fn(),
	pairCompanionDevice: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();
	return {
		...actual,
		getCompanionStatus: apiMocks.getCompanionStatus,
		listPairedDevices: apiMocks.listPairedDevices,
		disableCompanion: apiMocks.disableCompanion,
		disableCompanionTunnel: apiMocks.disableCompanionTunnel,
		enableCompanion: apiMocks.enableCompanion,
		enableLanCompanion: apiMocks.enableLanCompanion,
		pairCompanionDevice: apiMocks.pairCompanionDevice,
	};
});

function status(overrides: Partial<CompanionStatus>): CompanionStatus {
	return {
		running: false,
		addr: null,
		lanUrl: null,
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
	baseUrl: "http://192.168.1.20:5000",
	url: "helmor://pair?baseUrl=http%3A%2F%2F192.168.1.20%3A5000&token=hlm_test",
	connectionKind: "temporary",
};

describe("MobileCompanionPanel tunnel bootstrap", () => {
	beforeEach(() => {
		apiMocks.listPairedDevices.mockResolvedValue([]);
		apiMocks.disableCompanion.mockResolvedValue(undefined);
		apiMocks.disableCompanionTunnel.mockResolvedValue(
			status({
				running: true,
				addr: "127.0.0.1:5000",
				lanUrl: "http://192.168.1.20:5000",
			}),
		);
		apiMocks.pairCompanionDevice.mockResolvedValue(PAIRING);
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("does not start Cloudflare just by opening the panel", async () => {
		apiMocks.getCompanionStatus.mockResolvedValue(status({}));

		renderWithProviders(<MobileCompanionPanel />);

		await screen.findByText(
			"Starts LAN pairing for devices on the same Wi-Fi or local network.",
		);
		expect(apiMocks.enableCompanion).not.toHaveBeenCalled();
		expect(screen.getByText("Not running")).toBeInTheDocument();
	});

	it("starts LAN access when the mobile access switch is enabled", async () => {
		const user = userEvent.setup();
		const withLan = status({
			running: true,
			addr: "127.0.0.1:5000",
			lanUrl: "http://192.168.1.20:5000",
		});
		apiMocks.getCompanionStatus
			.mockResolvedValueOnce(status({}))
			.mockResolvedValue(withLan);
		apiMocks.enableLanCompanion.mockResolvedValue(withLan);

		renderWithProviders(<MobileCompanionPanel />);

		const [mobileAccess] = await screen.findAllByRole("switch");
		await user.click(mobileAccess);

		await waitFor(() => expect(apiMocks.enableLanCompanion).toHaveBeenCalled());
		expect(apiMocks.enableCompanion).not.toHaveBeenCalled();
	});

	it("starts Cloudflare when the tunnel switch is enabled", async () => {
		const user = userEvent.setup();
		const withTunnel = status({
			running: true,
			addr: "127.0.0.1:5000",
			lanUrl: "http://192.168.1.20:5000",
			publicUrl: "https://example.trycloudflare.com",
			mode: "quick",
		});
		apiMocks.getCompanionStatus.mockResolvedValue(
			status({
				running: true,
				addr: "127.0.0.1:5000",
				lanUrl: "http://192.168.1.20:5000",
			}),
		);
		apiMocks.enableCompanion.mockResolvedValue(withTunnel);

		renderWithProviders(<MobileCompanionPanel />);

		const [, cloudflareTunnel] = await screen.findAllByRole("switch");
		await user.click(cloudflareTunnel);

		await waitFor(() => expect(apiMocks.enableCompanion).toHaveBeenCalled());
	});

	it("does not start Cloudflare when a LAN URL is already present", async () => {
		apiMocks.getCompanionStatus.mockResolvedValue(
			status({
				running: true,
				addr: "127.0.0.1:5000",
				lanUrl: "http://192.168.1.20:5000",
			}),
		);

		renderWithProviders(<MobileCompanionPanel />);

		// Pairing fires once a LAN or public URL exists, so awaiting it proves the
		// effects settled — and Cloudflare enable must have been skipped.
		await waitFor(() =>
			expect(apiMocks.pairCompanionDevice).toHaveBeenCalled(),
		);
		expect(apiMocks.enableCompanion).not.toHaveBeenCalled();
	});

	it("stops Cloudflare when the tunnel switch is disabled", async () => {
		const user = userEvent.setup();
		apiMocks.getCompanionStatus.mockResolvedValue(
			status({
				running: true,
				addr: "127.0.0.1:5000",
				lanUrl: "http://192.168.1.20:5000",
				publicUrl: "https://example.trycloudflare.com",
				mode: "quick",
			}),
		);

		renderWithProviders(<MobileCompanionPanel />);

		const [, cloudflareTunnel] = await screen.findAllByRole("switch");
		await user.click(cloudflareTunnel);

		await waitFor(() =>
			expect(apiMocks.disableCompanionTunnel).toHaveBeenCalled(),
		);
	});

	it("uses device copy and centers the empty paired-device state", async () => {
		apiMocks.getCompanionStatus.mockResolvedValue(
			status({
				running: true,
				addr: "127.0.0.1:5000",
				lanUrl: "http://192.168.1.20:5000",
			}),
		);

		renderWithProviders(<MobileCompanionPanel />);

		await waitFor(() =>
			expect(apiMocks.pairCompanionDevice).toHaveBeenCalled(),
		);
		expect(screen.getByText("Connect a device")).toBeInTheDocument();
		expect(
			screen.getByText(
				"Scan with your device's camera while the device is on the same Wi-Fi or LAN.",
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
