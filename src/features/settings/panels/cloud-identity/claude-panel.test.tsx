import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render-with-providers";
import { CloudClaudeIdentityPanel } from "./claude-panel";

// `getCloudClaudeIdentityStatus` lives in team-api; `authorizeCloudClaudeIdentity`
// in api. We mock both so the panel under test has a stable control-plane
// surface (mirrors the Codex panel test).
const teamApiMocks = vi.hoisted(() => ({
	getCloudClaudeIdentityStatus: vi.fn(),
}));

vi.mock("@/lib/team-api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/team-api")>();
	return {
		...actual,
		getCloudClaudeIdentityStatus: teamApiMocks.getCloudClaudeIdentityStatus,
	};
});

const apiMocks = vi.hoisted(() => ({
	authorizeCloudClaudeIdentity: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();
	return {
		...actual,
		authorizeCloudClaudeIdentity: apiMocks.authorizeCloudClaudeIdentity,
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

describe("CloudClaudeIdentityPanel", () => {
	beforeEach(() => {
		teamModeMocks.isTeamModeActive.mockReturnValue(true);
		teamModeMocks.getTeamConfig.mockReturnValue(CFG);
		teamApiMocks.getCloudClaudeIdentityStatus.mockResolvedValue({
			hasToken: true,
		});
		apiMocks.authorizeCloudClaudeIdentity.mockResolvedValue(undefined);
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("renders the status and a Re-authorize control when a token exists", async () => {
		renderWithProviders(<CloudClaudeIdentityPanel />);

		// Panel chrome is present immediately (synchronous, pre-fetch).
		expect(
			screen.getByText(/cloud run identity · claude/i),
		).toBeInTheDocument();

		// The status query resolves → "authorized and active" + a re-authorize
		// affordance.
		await waitFor(() =>
			expect(screen.getByText(/authorized and active/i)).toBeInTheDocument(),
		);
		expect(
			screen.getByRole("button", { name: /re-authorize/i }),
		).toBeInTheDocument();
		expect(teamApiMocks.getCloudClaudeIdentityStatus).toHaveBeenCalledWith(CFG);
	});

	it("offers an Authorize button when no token is bound yet", async () => {
		teamApiMocks.getCloudClaudeIdentityStatus.mockResolvedValue({
			hasToken: false,
		});
		renderWithProviders(<CloudClaudeIdentityPanel />);

		// Wait for the RESOLVED state (the no-identity notice replaces the
		// "Checking…" loading notice). The Authorize label is the same during
		// loading and no-token, so gating on the notice — not the button — is what
		// proves the query resolved.
		await waitFor(() =>
			expect(
				screen.getByText(/no cloud claude identity yet/i),
			).toBeInTheDocument(),
		);
		expect(
			screen.getByRole("button", { name: /authorize claude \(cloud\)/i }),
		).toBeInTheDocument();
	});

	it("authorizes in one click: forwards the resolved Worker URL + bearer", async () => {
		const user = userEvent.setup();
		teamApiMocks.getCloudClaudeIdentityStatus.mockResolvedValue({
			hasToken: false,
		});
		renderWithProviders(<CloudClaudeIdentityPanel />);

		await waitFor(() =>
			expect(
				screen.getByText(/no cloud claude identity yet/i),
			).toBeInTheDocument(),
		);

		// One click → the local command runs the browser flow + upload. No paste
		// step: the URL + bearer are forwarded straight to Rust.
		await user.click(
			screen.getByRole("button", { name: /authorize claude \(cloud\)/i }),
		);
		await waitFor(() =>
			expect(apiMocks.authorizeCloudClaudeIdentity).toHaveBeenCalledWith(
				CFG.url,
				CFG.token,
			),
		);
	});

	it("surfaces an authorize error", async () => {
		const user = userEvent.setup();
		teamApiMocks.getCloudClaudeIdentityStatus.mockResolvedValue({
			hasToken: false,
		});
		apiMocks.authorizeCloudClaudeIdentity.mockRejectedValueOnce(
			new Error("Claude authorization failed."),
		);
		renderWithProviders(<CloudClaudeIdentityPanel />);

		await waitFor(() =>
			expect(
				screen.getByText(/no cloud claude identity yet/i),
			).toBeInTheDocument(),
		);
		await user.click(
			screen.getByRole("button", { name: /authorize claude \(cloud\)/i }),
		);

		// The failure surfaces as a non-sensitive error notice in the panel.
		await waitFor(() =>
			expect(
				screen.getByText(/claude authorization failed/i),
			).toBeInTheDocument(),
		);
	});

	it("renders nothing when team mode is off", () => {
		teamModeMocks.isTeamModeActive.mockReturnValue(false);
		const { container } = renderWithProviders(<CloudClaudeIdentityPanel />);

		expect(container).toBeEmptyDOMElement();
		// The gate must short-circuit before any control-plane read.
		expect(teamApiMocks.getCloudClaudeIdentityStatus).not.toHaveBeenCalled();
		expect(screen.queryByText(/cloud run identity/i)).not.toBeInTheDocument();
	});
});
