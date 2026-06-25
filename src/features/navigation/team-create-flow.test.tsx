import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	deployTeamCloud: vi.fn(),
	switchTeamMode: vi.fn(),
	createTeam: vi.fn(() => Promise.resolve({ teamId: "t" })),
	openUrl: vi.fn(),
	publishShellEvent: vi.fn(),
	codexAuthorize: vi.fn(),
	claudeAuthorize: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ deployTeamCloud: mocks.deployTeamCloud }));
vi.mock("@/lib/team-switch", () => ({ switchTeamMode: mocks.switchTeamMode }));
vi.mock("@/lib/team-api", () => ({ createTeam: mocks.createTeam }));
vi.mock("@/lib/platform-bridge", () => ({ openUrl: mocks.openUrl }));
vi.mock("@/shell/event-bus", () => ({
	publishShellEvent: mocks.publishShellEvent,
}));
vi.mock("@/lib/workspace-helpers", () => ({
	describeUnknownError: (_error: unknown, fallback: string) => fallback,
}));
// The cloud-identity hooks use React Query + control-plane fetches; stub them so
// the create-flow logic is tested in isolation (no QueryClientProvider needed).
vi.mock("@/features/settings/panels/cloud-identity/use-cloud-identity", () => ({
	useCloudIdentity: () => ({
		status: { hasToken: false },
		isLoading: false,
		isError: false,
		isAuthorizing: false,
		needsReauthorize: false,
		authorize: mocks.codexAuthorize,
		refetch: vi.fn(),
	}),
}));
vi.mock(
	"@/features/settings/panels/cloud-identity/use-cloud-claude-identity",
	() => ({
		useCloudClaudeIdentity: () => ({
			status: { hasToken: false },
			isLoading: false,
			isError: false,
			isAuthorizing: false,
			error: null,
			authorize: mocks.claudeAuthorize,
			refetch: vi.fn(),
		}),
	}),
);

import { TeamCreateFlow } from "./team-create-flow";

const CONNECT = /Connect Cloudflare & deploy/i;

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("TeamCreateFlow", () => {
	it("deploys + bootstraps, then authorizes agents before switching in", async () => {
		mocks.deployTeamCloud.mockResolvedValue({
			kind: "deployed",
			workerUrl: "https://team.example.workers.dev",
			adminToken: "admin-tok",
		});
		const onDone = vi.fn();
		render(<TeamCreateFlow onBack={vi.fn()} onDone={onDone} />);

		fireEvent.click(screen.getByRole("button", { name: CONNECT }));

		// Lands on the authorize step (NOT switched in yet) with both agents.
		await screen.findByRole("button", { name: /^Finish$/i });
		expect(mocks.createTeam).toHaveBeenCalled();
		expect(mocks.switchTeamMode).not.toHaveBeenCalled();
		const authorizeButtons = screen.getAllByRole("button", {
			name: /Authorize/i,
		});
		expect(authorizeButtons).toHaveLength(2); // Codex + Claude

		// Codex Authorize wires to the cloud-identity hook.
		fireEvent.click(authorizeButtons[0]);
		expect(mocks.codexAuthorize).toHaveBeenCalled();

		// Finish switches into team mode + closes the card.
		fireEvent.click(screen.getByRole("button", { name: /^Finish$/i }));
		expect(mocks.switchTeamMode).toHaveBeenCalledWith({
			url: "https://team.example.workers.dev",
			token: "admin-tok",
		});
		expect(onDone).toHaveBeenCalled();
	});

	it("shows the upgrade gate when the account lacks Workers Paid", async () => {
		mocks.deployTeamCloud.mockResolvedValue({
			kind: "needs-upgrade",
			upgradeUrl: "https://dash.cloudflare.com/upgrade",
		});
		render(<TeamCreateFlow onBack={vi.fn()} onDone={vi.fn()} />);

		fireEvent.click(screen.getByRole("button", { name: CONNECT }));

		await screen.findByText(/Workers Paid required/i);
		fireEvent.click(
			screen.getByRole("button", { name: /Upgrade on Cloudflare/i }),
		);
		expect(mocks.openUrl).toHaveBeenCalledWith(
			"https://dash.cloudflare.com/upgrade",
		);
		expect(mocks.switchTeamMode).not.toHaveBeenCalled();
	});

	it("surfaces a failure with an Advanced-setup fallback", async () => {
		mocks.deployTeamCloud.mockRejectedValue(new Error("boom"));
		const onDone = vi.fn();
		render(<TeamCreateFlow onBack={vi.fn()} onDone={onDone} />);

		fireEvent.click(screen.getByRole("button", { name: CONNECT }));

		await screen.findByText(/didn't finish/i);
		fireEvent.click(screen.getByRole("button", { name: /Advanced setup/i }));
		expect(onDone).toHaveBeenCalled();
		expect(mocks.publishShellEvent).toHaveBeenCalledWith({
			type: "open-settings",
			section: "team",
		});
	});
});
