import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	teamModeActive: true,
	adminToken: "hlm_admin_1" as string | null,
	mintInvite: vi.fn(),
}));

vi.mock("@/lib/team-mode", () => ({
	isTeamModeActive: () => mocks.teamModeActive,
	getTeamConfig: () =>
		mocks.teamModeActive
			? { url: "https://team.example.workers.dev", token: "member" }
			: null,
	getTeamAdminToken: () => mocks.adminToken,
}));
vi.mock("@/lib/team-api", () => ({ mintInvite: mocks.mintInvite }));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { InviteButton } from "./index";
import { InviteModal } from "./invite-modal";

function renderWithProviders(ui: React.ReactElement) {
	const queryClient = new QueryClient({
		defaultOptions: { mutations: { retry: false } },
	});
	return render(
		<QueryClientProvider client={queryClient}>
			<TooltipProvider>{ui}</TooltipProvider>
		</QueryClientProvider>,
	);
}

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	mocks.teamModeActive = true;
	mocks.adminToken = "hlm_admin_1";
});

describe("InviteButton (R5-A 裁决⑥ admin-only)", () => {
	it("renders for the team creator (admin token stored)", () => {
		renderWithProviders(<InviteButton />);
		expect(
			screen.getByRole("button", { name: /Invite a teammate/i }),
		).toBeTruthy();
	});

	it("renders NOTHING for a member (no admin token)", () => {
		mocks.adminToken = null;
		const { container } = renderWithProviders(<InviteButton />);
		expect(container.innerHTML).toBe("");
	});

	it("renders nothing outside team mode", () => {
		mocks.teamModeActive = false;
		const { container } = renderWithProviders(<InviteButton />);
		expect(container.innerHTML).toBe("");
	});
});

describe("InviteModal (auto-mint, done-for-you)", () => {
	it("mints on open with the ADMIN token and a 7-day expiry", async () => {
		mocks.mintInvite.mockResolvedValue({
			token: "inv-1",
			url: "https://team.example.workers.dev/?invite=inv-1",
		});
		renderWithProviders(<InviteModal open onOpenChange={vi.fn()} />);

		await waitFor(() => {
			expect(mocks.mintInvite).toHaveBeenCalledTimes(1);
		});
		const [cfg, opts] = mocks.mintInvite.mock.calls[0];
		expect(cfg).toEqual({
			url: "https://team.example.workers.dev",
			token: "hlm_admin_1",
		});
		// ~7 days out (loose window to keep the test clock-agnostic).
		const expiresMs = Date.parse(opts.expiresAt) - Date.now();
		expect(expiresMs).toBeGreaterThan(6.9 * 24 * 60 * 60 * 1000);
		expect(expiresMs).toBeLessThan(7.1 * 24 * 60 * 60 * 1000);

		// The link renders with Copy and the expiry note — no "Mint" button.
		await screen.findByDisplayValue(
			"https://team.example.workers.dev/?invite=inv-1",
		);
		expect(screen.getByRole("button", { name: /^Copy$/i })).toBeTruthy();
		expect(screen.getByText(/expires in 7 days/i)).toBeTruthy();
		expect(screen.queryByRole("button", { name: /Mint/i })).toBeNull();
	});

	it("copies the link and flips the button to Copied", async () => {
		mocks.mintInvite.mockResolvedValue({
			token: "inv-1",
			url: "https://team.example.workers.dev/?invite=inv-1",
		});
		const writeText = vi.fn(() => Promise.resolve());
		Object.assign(navigator, { clipboard: { writeText } });
		renderWithProviders(<InviteModal open onOpenChange={vi.fn()} />);

		fireEvent.click(await screen.findByRole("button", { name: /^Copy$/i }));
		await waitFor(() => {
			expect(writeText).toHaveBeenCalledWith(
				"https://team.example.workers.dev/?invite=inv-1",
			);
		});
		await screen.findByRole("button", { name: /Copied/i });
	});

	it("mints a fresh link via New link", async () => {
		mocks.mintInvite
			.mockResolvedValueOnce({ token: "inv-1", url: "https://x/?invite=inv-1" })
			.mockResolvedValueOnce({
				token: "inv-2",
				url: "https://x/?invite=inv-2",
			});
		renderWithProviders(<InviteModal open onOpenChange={vi.fn()} />);

		await screen.findByDisplayValue("https://x/?invite=inv-1");
		fireEvent.click(screen.getByRole("button", { name: /New link/i }));
		await screen.findByDisplayValue("https://x/?invite=inv-2");
		expect(mocks.mintInvite).toHaveBeenCalledTimes(2);
	});

	it("shows an inline error with Retry when minting fails (no toast)", async () => {
		mocks.mintInvite
			.mockRejectedValueOnce(new Error("Not an admin token (HTTP 401)."))
			.mockResolvedValueOnce({
				token: "inv-2",
				url: "https://x/?invite=inv-2",
			});
		renderWithProviders(<InviteModal open onOpenChange={vi.fn()} />);

		await screen.findByText(/Not an admin token/i);
		fireEvent.click(screen.getByRole("button", { name: /^Retry$/i }));
		await screen.findByDisplayValue("https://x/?invite=inv-2");
	});
});
