import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	deployTeamCloud: vi.fn(),
	switchTeamMode: vi.fn(),
	createTeam: vi.fn(() => Promise.resolve({ teamId: "t" })),
	mintInvite: vi.fn(() =>
		Promise.resolve({
			token: "member-tok",
			url: "https://x/?invite=member-tok",
		}),
	),
	acceptInvite: vi.fn(() => Promise.resolve({ ok: true, memberId: "123" })),
	openUrl: vi.fn(),
	publishShellEvent: vi.fn(),
	codexAuthorize: vi.fn(),
	claudeAuthorize: vi.fn(),
	// Mutable so a test can simulate an unresolved GitHub identity. `refetch`
	// returns null by default (no roster) — overridden per test as needed.
	teamIdentity: {
		identity: { githubId: "123", login: "admin" } as {
			githubId: string;
			login: string;
		} | null,
		isLoading: false,
		refetch: vi.fn(
			async () => null as { githubId: string; login: string } | null,
		),
	},
}));

vi.mock("@/lib/api", () => ({ deployTeamCloud: mocks.deployTeamCloud }));
vi.mock("@/lib/team-switch", () => ({ switchTeamMode: mocks.switchTeamMode }));
vi.mock("@/lib/team-api", () => ({
	createTeam: mocks.createTeam,
	mintInvite: mocks.mintInvite,
	acceptInvite: mocks.acceptInvite,
}));
vi.mock("@/features/team/use-team-identity", () => ({
	useTeamIdentity: () => mocks.teamIdentity,
}));
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
		error: null,
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
	// Restore the default resolvable identity for the next test.
	mocks.teamIdentity.identity = { githubId: "123", login: "admin" };
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
		// The creator is registered as a member (mint + accept), so the saved
		// bearer is the MEMBER token — not the shared companion token.
		expect(mocks.acceptInvite).toHaveBeenCalled();
		expect(mocks.switchTeamMode).toHaveBeenCalledWith({
			url: "https://team.example.workers.dev",
			token: "member-tok",
		});
		expect(onDone).toHaveBeenCalled();
	});

	it("surfaces a membership error + Retry (no silent companion-token fallback) when the GitHub identity can't be resolved", async () => {
		mocks.deployTeamCloud.mockResolvedValue({
			kind: "deployed",
			workerUrl: "https://team.example.workers.dev",
			adminToken: "admin-tok",
		});
		// gh roster is empty (e.g. `gh` was flaky) → no identity, even on refetch.
		mocks.teamIdentity.identity = null;
		render(<TeamCreateFlow onBack={vi.fn()} onDone={vi.fn()} />);

		fireEvent.click(screen.getByRole("button", { name: CONNECT }));

		// Lands on authorize, but with a membership error instead of a member token.
		await screen.findByText(/Couldn't read your GitHub identity/i);
		// We must NOT have minted/accepted (nothing to bind) — and must NOT have
		// silently saved the companion token as if registration succeeded.
		expect(mocks.mintInvite).not.toHaveBeenCalled();
		expect(mocks.acceptInvite).not.toHaveBeenCalled();
		// Authorize buttons stay disabled until registration succeeds — clicking
		// them with a companion token would 401.
		for (const btn of screen.getAllByRole("button", { name: /Authorize/i })) {
			expect((btn as HTMLButtonElement).disabled).toBe(true);
		}
		// And a Retry is offered (membership can be re-attempted once gh recovers).
		expect(screen.getByRole("button", { name: /^Retry$/i })).toBeTruthy();
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
