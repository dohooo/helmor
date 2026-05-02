import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
	listForgeAccounts: vi.fn(),
	listForgeLogins: vi.fn(),
	resizeForgeCliAuthTerminal: vi.fn(),
	spawnForgeCliAuthTerminal: vi.fn(),
	stopForgeCliAuthTerminal: vi.fn(),
	writeForgeCliAuthTerminalStdin: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();
	return {
		...actual,
		listForgeAccounts: apiMocks.listForgeAccounts,
		listForgeLogins: apiMocks.listForgeLogins,
		resizeForgeCliAuthTerminal: apiMocks.resizeForgeCliAuthTerminal,
		spawnForgeCliAuthTerminal: apiMocks.spawnForgeCliAuthTerminal,
		stopForgeCliAuthTerminal: apiMocks.stopForgeCliAuthTerminal,
		writeForgeCliAuthTerminalStdin: apiMocks.writeForgeCliAuthTerminalStdin,
	};
});

vi.mock("sonner", () => ({
	toast: Object.assign(vi.fn(), {
		error: vi.fn(),
		success: vi.fn(),
	}),
}));

import { renderWithProviders } from "@/test/render-with-providers";
import { RepositoryCliStep } from "./repository-cli-step";

describe("RepositoryCliStep", () => {
	beforeEach(() => {
		for (const mock of Object.values(apiMocks)) {
			mock.mockReset();
		}
		apiMocks.listForgeAccounts.mockResolvedValue([]);
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("lists existing forge logins by handle when checks complete", async () => {
		// Per-provider so the GitLab probe (which also fires on mount)
		// doesn't echo the same login back and double-render the row.
		apiMocks.listForgeLogins.mockImplementation((provider: string) =>
			Promise.resolve(provider === "github" ? ["octocat"] : []),
		);
		apiMocks.listForgeAccounts.mockResolvedValue([
			{
				provider: "github",
				host: "github.com",
				login: "octocat",
				name: "Octocat",
				avatarUrl: null,
				email: null,
				active: true,
			},
		]);

		renderWithProviders(
			<RepositoryCliStep step="corner" onBack={vi.fn()} onNext={vi.fn()} />,
		);

		// Login handle is rendered next to the resolved profile name.
		await waitFor(() => {
			expect(screen.getByText("@octocat")).toBeInTheDocument();
		});
		expect(screen.getByText("Octocat")).toBeInTheDocument();
	});

	it("opens the embedded auth terminal when picking GitHub from the Add slot", async () => {
		// Floating buttons are `pointer-events:none` until the picker
		// slot is hovered — jsdom doesn't run real layout/hit testing,
		// so the visibility flip from `user.hover` doesn't reach the
		// buttons before user-event's strict pointer-events check
		// fires. Disable the check here; the click behaviour is what
		// this test is asserting on.
		const user = userEvent.setup({ pointerEventsCheck: 0 });
		apiMocks.listForgeLogins.mockResolvedValue([]);
		apiMocks.spawnForgeCliAuthTerminal.mockResolvedValue(undefined);

		renderWithProviders(
			<RepositoryCliStep step="corner" onBack={vi.fn()} onNext={vi.fn()} />,
		);

		await user.click(screen.getByRole("button", { name: /^github$/i }));

		await waitFor(() => {
			expect(apiMocks.spawnForgeCliAuthTerminal).toHaveBeenCalledWith(
				"github",
				"github.com",
				expect.any(String),
				expect.any(Function),
			);
		});
		expect(screen.getByText("gh auth login")).toBeInTheDocument();
	});

	it("asks for a GitLab domain before launching the GitLab auth terminal", async () => {
		const user = userEvent.setup({ pointerEventsCheck: 0 });
		apiMocks.listForgeLogins.mockResolvedValue([]);
		apiMocks.spawnForgeCliAuthTerminal.mockResolvedValue(undefined);

		renderWithProviders(
			<RepositoryCliStep step="corner" onBack={vi.fn()} onNext={vi.fn()} />,
		);

		await user.click(screen.getByRole("button", { name: /^gitlab$/i }));

		const input = await screen.findByRole("textbox", { name: "GitLab domain" });
		expect(input).toHaveValue("gitlab.com");

		await user.clear(input);
		await user.type(input, "gitlab.example.com");
		await user.click(screen.getByRole("button", { name: /log in/i }));

		await waitFor(() => {
			expect(apiMocks.spawnForgeCliAuthTerminal).toHaveBeenCalledWith(
				"gitlab",
				"gitlab.example.com",
				expect.any(String),
				expect.any(Function),
			);
		});
		expect(
			screen.getByText("glab auth login · gitlab.example.com"),
		).toBeInTheDocument();
	});
});
