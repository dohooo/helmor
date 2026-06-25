import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	accept: vi.fn(),
	toastError: vi.fn(),
	identity: {
		identity: null as null | { githubId: string; login: string },
		isLoading: false,
	},
}));

vi.mock("@/features/team/use-invite-accept", () => ({
	useInviteAccept: () => ({ status: "idle", accept: mocks.accept }),
}));
vi.mock("@/features/team/use-team-identity", () => ({
	useTeamIdentity: () => mocks.identity,
}));
vi.mock("sonner", () => ({
	toast: Object.assign(vi.fn(), { error: mocks.toastError, success: vi.fn() }),
}));
vi.mock("@/lib/team-mode", () => ({
	parseInviteLink: (value: string) =>
		value.includes("invite=") ? { url: "https://x", token: "tok" } : null,
}));
// Isolate the card from the deploy flow — that logic is unit-tested separately
// in team-create-flow.test.tsx.
vi.mock("./team-create-flow", () => ({
	TeamCreateFlow: () => <div data-testid="create-flow" />,
}));

import { useTeamSetupStore } from "./state/team-setup-store";
import { TeamSetupCard } from "./team-setup-card";

afterEach(() => {
	cleanup();
	useTeamSetupStore.getState().close();
	mocks.identity.identity = null;
	vi.clearAllMocks();
});

describe("TeamSetupCard", () => {
	it("renders nothing until setup is requested", () => {
		const { container } = render(<TeamSetupCard />);
		expect(container.firstChild).toBeNull();
	});

	it("shows the Join / Create card when open", () => {
		useTeamSetupStore.getState().requestSetup();
		render(<TeamSetupCard />);
		expect(screen.getByText("Set up team cloud")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Join" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Create" })).toBeInTheDocument();
	});

	it("rejects an invalid invite link without calling accept", () => {
		useTeamSetupStore.getState().requestSetup();
		render(<TeamSetupCard />);
		fireEvent.change(screen.getByPlaceholderText("https://…/?invite=…"), {
			target: { value: "not-a-link" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Join" }));
		expect(mocks.toastError).toHaveBeenCalled();
		expect(mocks.accept).not.toHaveBeenCalled();
	});

	it("Create switches to the auto-deploy flow", () => {
		useTeamSetupStore.getState().requestSetup();
		render(<TeamSetupCard />);
		fireEvent.click(screen.getByRole("button", { name: "Create" }));
		expect(screen.getByTestId("create-flow")).toBeInTheDocument();
	});
});
