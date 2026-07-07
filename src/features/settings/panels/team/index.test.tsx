import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	teamModeActive: true,
	clearTeamConfig: vi.fn(),
	switchTeamMode: vi.fn(),
	openUrl: vi.fn(),
	readinessState: "ready" as string,
}));

vi.mock("@/lib/team-mode", () => ({
	isTeamModeActive: () => mocks.teamModeActive,
	getTeamConfig: () =>
		mocks.teamModeActive
			? { url: "https://helmor-team.acme.workers.dev", token: "member" }
			: null,
	getCodexIdentityEmail: () => null,
	clearTeamConfig: mocks.clearTeamConfig,
}));
vi.mock("@/lib/team-switch", () => ({ switchTeamMode: mocks.switchTeamMode }));
vi.mock("@/lib/platform-bridge", () => ({ openUrl: mocks.openUrl }));
vi.mock("@/lib/team-readiness", () => ({
	useTeamReadiness: () => ({
		state: mocks.readinessState,
		label: "",
		detail: "",
		unauthorized: false,
	}),
}));
// The Agent status card pulls the identity hooks (React Query) — stub them so
// the panel test stays provider-free. The card's own behavior is covered in
// agent-status-card.test.tsx.
vi.mock("@/features/team/use-cloud-identity", () => ({
	useCloudIdentity: () => ({
		status: {
			hasToken: true,
			accountId: "acct_1",
			accessExp: null,
			bricked: false,
		},
		isLoading: false,
		isError: false,
		isAuthorizing: false,
		error: null,
		needsReauthorize: false,
		authorize: vi.fn(),
		refetch: vi.fn(),
	}),
	isCloudIdentityExpired: () => false,
}));
vi.mock("@/features/team/use-cloud-claude-identity", () => ({
	useCloudClaudeIdentity: () => ({
		status: { hasToken: true },
		isLoading: false,
		isError: false,
		isAuthorizing: false,
		error: null,
		authorize: vi.fn(),
		refetch: vi.fn(),
	}),
}));

import { TeamPanel } from "./index";

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	mocks.teamModeActive = true;
	mocks.readinessState = "ready";
});

describe("TeamPanel (R5-A slim)", () => {
	it("shows a quiet local-mode note outside team mode", () => {
		mocks.teamModeActive = false;
		render(<TeamPanel />);
		expect(screen.getByText(/Helmor is running locally/i)).toBeTruthy();
		// None of the team-mode blocks render.
		expect(screen.queryByText(/Your team cloud/i)).toBeNull();
		expect(screen.queryByText(/Agent status/i)).toBeNull();
		expect(screen.queryByText(/Leave this team/i)).toBeNull();
	});

	it("renders exactly the three slim blocks in team mode", () => {
		render(<TeamPanel />);
		expect(screen.getByText("Your team cloud")).toBeTruthy();
		expect(screen.getByText("Agent status")).toBeTruthy();
		expect(screen.getByText(/Leave this team/i)).toBeTruthy();
		// The cut cockpit controls are gone.
		expect(screen.queryByText(/Join with invite link/i)).toBeNull();
		expect(screen.queryByText(/Worker URL/i)).toBeNull();
		expect(screen.queryByText(/Access token/i)).toBeNull();
		expect(screen.queryByRole("button", { name: /^Test$/i })).toBeNull();
		expect(screen.queryByRole("button", { name: /^Connect$/i })).toBeNull();
		expect(screen.queryByRole("button", { name: /Create team/i })).toBeNull();
		expect(screen.queryByRole("button", { name: /Mint invite/i })).toBeNull();
	});

	it("provision card shows the three v1 rows with Cloudflare links", () => {
		render(<TeamPanel />);
		expect(screen.getByText("Worker")).toBeTruthy();
		expect(screen.getByText("helmor-team.acme.workers.dev")).toBeTruthy();
		expect(screen.getByText("Database")).toBeTruthy();
		expect(screen.getByText("D1 · helmor-team")).toBeTruthy();
		expect(screen.getByText("Storage")).toBeTruthy();
		expect(screen.getByText("R2 · helmor-team-backups")).toBeTruthy();
		// v1 (方案丙): no image/backup rows until the Worker can report them.
		expect(screen.queryByText(/Sandbox image/i)).toBeNull();
		expect(screen.queryByText(/Last backup/i)).toBeNull();

		fireEvent.click(
			screen.getByRole("button", { name: /Open Worker on Cloudflare/i }),
		);
		expect(mocks.openUrl).toHaveBeenCalledWith(
			"https://dash.cloudflare.com/?to=/:account/workers-and-pages",
		);
	});

	it("provision dots mirror the readiness state (degraded → danger)", () => {
		mocks.readinessState = "degraded";
		const { container } = render(<TeamPanel />);
		const dots = container.querySelectorAll('[data-state="degraded"]');
		expect(dots.length).toBe(3);
	});

	it("Leave this team confirms, wipes config, and switches to local", () => {
		render(<TeamPanel />);
		fireEvent.click(screen.getByText(/Leave this team/i));
		// Confirm dialog appears; nothing has happened yet.
		expect(mocks.clearTeamConfig).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: /^Leave team$/i }));
		expect(mocks.clearTeamConfig).toHaveBeenCalled();
		expect(mocks.switchTeamMode).toHaveBeenCalledWith(null);
	});
});
