import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	deployTeamCloud: vi.fn(),
	switchTeamMode: vi.fn(),
	createTeam: vi.fn(() => Promise.resolve({ teamId: "t" })),
	openUrl: vi.fn(),
	publishShellEvent: vi.fn(),
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

import { TeamCreateFlow } from "./team-create-flow";

const CONNECT = /Connect Cloudflare & deploy/i;

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("TeamCreateFlow", () => {
	it("deploys, bootstraps, and switches into team mode", async () => {
		mocks.deployTeamCloud.mockResolvedValue({
			kind: "deployed",
			workerUrl: "https://team.example.workers.dev",
			adminToken: "admin-tok",
		});
		const onDone = vi.fn();
		render(<TeamCreateFlow onBack={vi.fn()} onDone={onDone} />);

		fireEvent.click(screen.getByRole("button", { name: CONNECT }));

		await waitFor(() =>
			expect(mocks.switchTeamMode).toHaveBeenCalledWith({
				url: "https://team.example.workers.dev",
				token: "admin-tok",
			}),
		);
		expect(mocks.createTeam).toHaveBeenCalled();
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
