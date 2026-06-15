import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render-with-providers";
import { TeamAdminPanel } from "./index";

// `createTeam` / `mintInvite` live in team-api — mock them so the panel under
// test has a stable, write-only control-plane surface.
const teamApiMocks = vi.hoisted(() => ({
	createTeam: vi.fn(),
	mintInvite: vi.fn(),
}));

vi.mock("@/lib/team-api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/team-api")>();
	return {
		...actual,
		createTeam: teamApiMocks.createTeam,
		mintInvite: teamApiMocks.mintInvite,
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

const CFG = { url: "https://team.example.com", token: "hlm_admin" };

describe("TeamAdminPanel", () => {
	beforeEach(() => {
		teamModeMocks.isTeamModeActive.mockReturnValue(true);
		teamModeMocks.getTeamConfig.mockReturnValue(CFG);
		teamApiMocks.createTeam.mockResolvedValue({ teamId: "team" });
		teamApiMocks.mintInvite.mockResolvedValue({
			token: "inv-1",
			url: "https://team.example.com/?invite=inv-1",
		});
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("renders nothing when team mode is off", () => {
		teamModeMocks.isTeamModeActive.mockReturnValue(false);
		const { container } = renderWithProviders(<TeamAdminPanel />);

		expect(container).toBeEmptyDOMElement();
		expect(teamApiMocks.createTeam).not.toHaveBeenCalled();
		expect(teamApiMocks.mintInvite).not.toHaveBeenCalled();
	});

	it("calls createTeam with the resolved config when Create is clicked", async () => {
		renderWithProviders(<TeamAdminPanel />);

		fireEvent.click(screen.getByRole("button", { name: /create team/i }));

		await waitFor(() =>
			expect(teamApiMocks.createTeam).toHaveBeenCalledWith(CFG),
		);
		await waitFor(() =>
			expect(screen.getByText(/team is ready/i)).toBeInTheDocument(),
		);
	});

	it("mints an invite and renders the url read-only (only after Mint)", async () => {
		renderWithProviders(<TeamAdminPanel />);

		// The capability secret must NOT be present before an explicit Mint.
		expect(
			screen.queryByRole("textbox", { name: "Invite link" }),
		).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: /mint invite/i }));

		await waitFor(() =>
			expect(teamApiMocks.mintInvite).toHaveBeenCalledWith(CFG),
		);
		const field = await screen.findByRole("textbox", { name: "Invite link" });
		expect(field).toHaveValue("https://team.example.com/?invite=inv-1");
		expect(field).toHaveAttribute("readonly");
	});

	it("copies the minted invite url to the clipboard", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal("navigator", { clipboard: { writeText } });

		renderWithProviders(<TeamAdminPanel />);
		fireEvent.click(screen.getByRole("button", { name: /mint invite/i }));
		await screen.findByRole("textbox", { name: "Invite link" });

		fireEvent.click(screen.getByRole("button", { name: /copy invite link/i }));

		await waitFor(() =>
			expect(writeText).toHaveBeenCalledWith(
				"https://team.example.com/?invite=inv-1",
			),
		);
		vi.unstubAllGlobals();
	});

	it("surfaces the non-admin-token hint when createTeam rejects with 401", async () => {
		teamApiMocks.createTeam.mockRejectedValue(
			new Error(
				"Not an admin token — use the companion/admin token (HTTP 401).",
			),
		);
		renderWithProviders(<TeamAdminPanel />);

		fireEvent.click(screen.getByRole("button", { name: /create team/i }));

		await waitFor(() =>
			expect(screen.getByText(/not an admin token/i)).toBeInTheDocument(),
		);
	});
});
