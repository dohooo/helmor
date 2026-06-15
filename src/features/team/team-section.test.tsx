import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHelmorQueryClient, helmorQueryKeys } from "@/lib/query-client";
import type { TeamWorkspace } from "@/lib/team-api";
import { renderWithProviders } from "@/test/render-with-providers";
import { TeamSection } from "./team-section";

const TEAM_URL = "https://team.example.com";

function enableTeamMode(): void {
	localStorage.setItem("helmor.team.url", TEAM_URL);
	localStorage.setItem("helmor.team.token", "hlm_secret");
	localStorage.setItem("helmor.team.mode", "1");
}

function seedWorkspaces(
	queryClient: ReturnType<typeof createHelmorQueryClient>,
	workspaces: TeamWorkspace[],
): void {
	queryClient.setQueryData(
		helmorQueryKeys.teamWorkspaces(TEAM_URL),
		workspaces,
	);
	queryClient.setQueryData(helmorQueryKeys.teamMembers(TEAM_URL), []);
}

const WORKSPACE: TeamWorkspace = {
	id: "ws-sandbox-1",
	name: "shared-sandbox",
	status: "ready",
	created_at: 0,
};

describe("TeamSection — openable shared workspaces", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	afterEach(() => {
		cleanup();
	});

	it("renders null outside team mode (single-user unchanged)", () => {
		const queryClient = createHelmorQueryClient();
		const { container } = renderWithProviders(
			<TeamSection onOpenWorkspace={vi.fn()} />,
			{ queryClient },
		);
		expect(container).toBeEmptyDOMElement();
	});

	it("opens the workspace by id on click", () => {
		enableTeamMode();
		const queryClient = createHelmorQueryClient();
		seedWorkspaces(queryClient, [WORKSPACE]);
		const onOpenWorkspace = vi.fn();

		renderWithProviders(<TeamSection onOpenWorkspace={onOpenWorkspace} />, {
			queryClient,
		});

		fireEvent.click(screen.getByRole("button", { name: /shared-sandbox/i }));
		expect(onOpenWorkspace).toHaveBeenCalledExactlyOnceWith("ws-sandbox-1");
	});

	it("opens the workspace on Enter and Space", () => {
		enableTeamMode();
		const queryClient = createHelmorQueryClient();
		seedWorkspaces(queryClient, [WORKSPACE]);
		const onOpenWorkspace = vi.fn();

		renderWithProviders(<TeamSection onOpenWorkspace={onOpenWorkspace} />, {
			queryClient,
		});

		const row = screen.getByRole("button", { name: /shared-sandbox/i });
		fireEvent.keyDown(row, { key: "Enter" });
		fireEvent.keyDown(row, { key: " " });
		expect(onOpenWorkspace).toHaveBeenCalledTimes(2);
		expect(onOpenWorkspace).toHaveBeenNthCalledWith(1, "ws-sandbox-1");
		expect(onOpenWorkspace).toHaveBeenNthCalledWith(2, "ws-sandbox-1");
	});
});
