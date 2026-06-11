import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryCreateOption } from "@/lib/api";
import { DEFAULT_SETTINGS, SettingsContext } from "@/lib/settings";
import { renderWithProviders } from "@/test/render-with-providers";
import { SettingsDialog } from ".";

const apiMocks = vi.hoisted(() => ({
	isConductorAvailable: vi.fn(),
	listRepositories: vi.fn(),
	loadAgentModelSections: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();
	return {
		...actual,
		isConductorAvailable: apiMocks.isConductorAvailable,
		listRepositories: apiMocks.listRepositories,
		loadAgentModelSections: apiMocks.loadAgentModelSections,
	};
});

vi.mock("./panels/app-updates", () => ({
	AppUpdatesPanel: () => <div>App updates panel</div>,
}));

vi.mock("./panels/components", () => ({
	ComponentsPanel: () => <div>Components panel</div>,
}));

vi.mock("./panels/mobile-companion", () => ({
	MobileCompanionPanel: () => <div>Mobile companion panel</div>,
}));

vi.mock("./panels/repository-settings", () => ({
	RepositorySettingsPanel: ({ repo }: { repo: RepositoryCreateOption }) => (
		<div>Repository panel: {repo.name}</div>
	),
}));

const REPOSITORY: RepositoryCreateOption = {
	id: "repo-a",
	name: "Repo A",
	remote: "origin",
	remoteUrl: "git@github.com:acme/repo-a.git",
	defaultBranch: "main",
	forgeProvider: "github",
	forgeLogin: "octocat",
	branchPrefixType: "custom",
	repoInitials: "RA",
};

function renderSettingsDialog() {
	return renderWithProviders(
		<SettingsContext.Provider
			value={{
				settings: { ...DEFAULT_SETTINGS },
				isLoaded: true,
				updateSettings: vi.fn(),
			}}
		>
			<SettingsDialog
				open
				workspaceId={null}
				workspaceRepoId={null}
				onClose={vi.fn()}
			/>
		</SettingsContext.Provider>,
	);
}

describe("SettingsDialog responsive navigation", () => {
	beforeEach(() => {
		apiMocks.isConductorAvailable.mockResolvedValue(false);
		apiMocks.listRepositories.mockResolvedValue([REPOSITORY]);
		apiMocks.loadAgentModelSections.mockResolvedValue([]);
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("renders a mobile section picker while keeping the desktop sidebar hidden until sm", async () => {
		renderSettingsDialog();

		const sectionPicker = await screen.findByLabelText("Settings section");
		expect(sectionPicker).toHaveClass("sm:hidden");
		expect(
			screen.getByRole("navigation", { name: "Settings navigation" }),
		).toHaveClass("hidden", "sm:flex");
		expect(sectionPicker).toHaveTextContent("General");
	});

	it("uses a header close button only on mobile and keeps the desktop floating close", async () => {
		renderSettingsDialog();

		await screen.findByLabelText("Settings section");
		const closeButtons = screen.getAllByRole("button", {
			name: "Close settings",
		});

		expect(closeButtons).toHaveLength(2);
		expect(closeButtons[0]).toHaveClass("sm:hidden");
		expect(closeButtons[1]).toHaveClass("hidden", "sm:flex", "absolute");
	});

	it("switches fixed sections from the mobile section picker", async () => {
		const user = userEvent.setup();
		renderSettingsDialog();

		await user.click(await screen.findByLabelText("Settings section"));
		const menu = await screen.findByRole("menu");
		await user.click(within(menu).getByRole("menuitem", { name: /Mobile/ }));

		expect(
			await screen.findByText("Mobile companion panel"),
		).toBeInTheDocument();
		expect(screen.getByLabelText("Settings section")).toHaveTextContent(
			"Mobile",
		);
	});

	it("includes repository sections in the mobile section picker", async () => {
		const user = userEvent.setup();
		renderSettingsDialog();

		await user.click(await screen.findByLabelText("Settings section"));
		const menu = await screen.findByRole("menu");
		await user.click(within(menu).getByRole("menuitem", { name: /Repo A/ }));

		expect(
			await screen.findByText("Repository panel: Repo A"),
		).toBeInTheDocument();
		expect(screen.getByLabelText("Settings section")).toHaveTextContent(
			"Repo A",
		);
	});
});
