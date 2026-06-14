import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render-with-providers";
import { CloudIdentityPanel } from "./index";

// `getCloudCodexIdentityStatus` lives in team-api; `authorizeCloudCodexIdentity`
// in api. Both are added by the orchestrator during integration — we mock them
// here so the panel under test has a stable control-plane surface regardless of
// whether the wiring has landed yet.
const teamApiMocks = vi.hoisted(() => ({
	getCloudCodexIdentityStatus: vi.fn(),
}));

vi.mock("@/lib/team-api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/team-api")>();
	return {
		...actual,
		getCloudCodexIdentityStatus: teamApiMocks.getCloudCodexIdentityStatus,
	};
});

const apiMocks = vi.hoisted(() => ({
	authorizeCloudCodexIdentity: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();
	return {
		...actual,
		authorizeCloudCodexIdentity: apiMocks.authorizeCloudCodexIdentity,
	};
});

// Team-mode gate + resolved config. Default = team mode ON; the "off" test
// overrides `isTeamModeActive` to false.
const teamModeMocks = vi.hoisted(() => ({
	isTeamModeActive: vi.fn(),
	getTeamConfig: vi.fn(),
}));

vi.mock("@/lib/team-mode", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/team-mode")>();
	return {
		...actual,
		isTeamModeActive: teamModeMocks.isTeamModeActive,
		getTeamConfig: teamModeMocks.getTeamConfig,
	};
});

const CFG = { url: "https://team.example.com", token: "hlm_secret" };

describe("CloudIdentityPanel", () => {
	beforeEach(() => {
		teamModeMocks.isTeamModeActive.mockReturnValue(true);
		teamModeMocks.getTeamConfig.mockReturnValue(CFG);
		teamApiMocks.getCloudCodexIdentityStatus.mockResolvedValue({
			hasToken: true,
			accountId: "acct_123",
			// Far-future expiry (seconds) → healthy, not needs-reauthorize.
			accessExp: Math.floor(Date.now() / 1000) + 240 * 3600,
			bricked: false,
		});
		apiMocks.authorizeCloudCodexIdentity.mockResolvedValue({
			accountId: "acct_123",
			changed: false,
		});
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("renders the status and an Authorize control in team mode", async () => {
		renderWithProviders(<CloudIdentityPanel />);

		// Panel chrome is present immediately (synchronous, pre-fetch).
		expect(screen.getByText(/cloud run identity · codex/i)).toBeInTheDocument();

		// The status query resolves → account id + a re-authorize affordance.
		await waitFor(() =>
			expect(screen.getByText("acct_123")).toBeInTheDocument(),
		);
		expect(
			screen.getByRole("button", { name: /authorize/i }),
		).toBeInTheDocument();
		expect(teamApiMocks.getCloudCodexIdentityStatus).toHaveBeenCalledWith(CFG);
	});

	it("flags a bricked identity as needing re-authorization (not an error)", async () => {
		teamApiMocks.getCloudCodexIdentityStatus.mockResolvedValue({
			hasToken: true,
			accountId: "acct_123",
			accessExp: Math.floor(Date.now() / 1000) + 3600,
			bricked: true,
		});
		renderWithProviders(<CloudIdentityPanel />);

		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: /re-authorize/i }),
			).toBeInTheDocument(),
		);
		expect(screen.getByText(/needs to be re-authorized/i)).toBeInTheDocument();
	});

	it("renders nothing when team mode is off", () => {
		teamModeMocks.isTeamModeActive.mockReturnValue(false);
		const { container } = renderWithProviders(<CloudIdentityPanel />);

		expect(container).toBeEmptyDOMElement();
		// The gate must short-circuit before any control-plane read.
		expect(teamApiMocks.getCloudCodexIdentityStatus).not.toHaveBeenCalled();
		expect(screen.queryByText(/cloud run identity/i)).not.toBeInTheDocument();
	});
});
