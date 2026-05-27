import {
	cleanup,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
	getCliStatus: vi.fn(),
	getHelmorSkillsStatus: vi.fn(),
	installCli: vi.fn(),
	installHelmorSkills: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();
	return {
		...actual,
		getCliStatus: apiMocks.getCliStatus,
		getHelmorSkillsStatus: apiMocks.getHelmorSkillsStatus,
		installCli: apiMocks.installCli,
		installHelmorSkills: apiMocks.installHelmorSkills,
	};
});

vi.mock("sonner", () => ({
	toast: vi.fn(),
}));

import { SkillsStep } from "./skills-step";

describe("SkillsStep", () => {
	beforeEach(() => {
		apiMocks.getCliStatus.mockReset();
		apiMocks.getHelmorSkillsStatus.mockReset();
		apiMocks.installCli.mockReset();
		apiMocks.installHelmorSkills.mockReset();
		// Default: skills not installed yet, default install call succeeds.
		// Individual tests override these per scenario.
		apiMocks.getHelmorSkillsStatus.mockResolvedValue({
			installed: false,
			claude: false,
			codex: false,
			command:
				"npx --yes skills add dohooo/helmor/.agents/skills/helmor-cli -g -s helmor-cli -y --copy -a claude-code -a codex",
		});
		apiMocks.installHelmorSkills.mockResolvedValue({
			installed: true,
			claude: true,
			codex: true,
			command:
				"npx --yes skills add dohooo/helmor/.agents/skills/helmor-cli -g -s helmor-cli -y --copy -a claude-code -a codex",
		});
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	// --- already-installed paths --------------------------------------

	it("shows Ready and skips install when the Helmor CLI is already installed", async () => {
		apiMocks.getCliStatus.mockResolvedValue({
			installed: true,
			installPath: "/usr/local/bin/helmor-dev",
			buildMode: "development",
			installState: "managed",
		});
		apiMocks.getHelmorSkillsStatus.mockResolvedValue({
			installed: true,
			claude: true,
			codex: true,
			command: "",
		});

		render(
			<SkillsStep
				step="skills"
				onBack={vi.fn()}
				onNext={vi.fn()}
				isRoutingImport={false}
			/>,
		);

		const cliItem = screen.getByRole("group", { name: "Helmor CLI" });

		await waitFor(() => {
			expect(within(cliItem).getByText("Ready")).toBeInTheDocument();
		});
		// No retry button surfaces — the install hook never fires for an
		// already-managed CLI.
		expect(
			within(cliItem).queryByRole("button", { name: "Retry" }),
		).not.toBeInTheDocument();
		expect(apiMocks.installCli).not.toHaveBeenCalled();
	});

	// --- silent-auto-install happy paths ------------------------------

	it("auto-installs the Helmor CLI on mount when missing", async () => {
		apiMocks.getCliStatus.mockResolvedValue({
			installed: false,
			installPath: null,
			buildMode: "development",
			installState: "missing",
		});
		apiMocks.installCli.mockResolvedValue({
			installed: true,
			installPath: "/usr/local/bin/helmor-dev",
			buildMode: "development",
			installState: "managed",
		});

		render(
			<SkillsStep
				step="skills"
				onBack={vi.fn()}
				onNext={vi.fn()}
				isRoutingImport={false}
			/>,
		);

		const cliItem = screen.getByRole("group", { name: "Helmor CLI" });

		// Install fires WITHOUT any click — the auto-install effect
		// kicks in once the status probe resolves.
		await waitFor(() => {
			expect(apiMocks.installCli).toHaveBeenCalledTimes(1);
		});
		await waitFor(() => {
			expect(within(cliItem).getByText("Ready")).toBeInTheDocument();
		});
		expect(
			within(cliItem).queryByRole("button", { name: "Retry" }),
		).not.toBeInTheDocument();
	});

	it("auto-installs Helmor Skills on mount when missing", async () => {
		apiMocks.getCliStatus.mockResolvedValue({
			installed: true,
			installPath: "/usr/local/bin/helmor-dev",
			buildMode: "development",
			installState: "managed",
		});

		render(
			<SkillsStep
				step="skills"
				onBack={vi.fn()}
				onNext={vi.fn()}
				isRoutingImport={false}
			/>,
		);

		const skillsItem = screen.getByRole("group", {
			name: "Helmor Skills (Beta)",
		});

		await waitFor(() => {
			expect(apiMocks.installHelmorSkills).toHaveBeenCalledTimes(1);
		});
		await waitFor(() => {
			expect(within(skillsItem).getByText("Ready")).toBeInTheDocument();
		});
	});

	// --- failure + retry path ----------------------------------------

	it("surfaces the failure hint and exposes a Retry button when skills install throws", async () => {
		const user = userEvent.setup();
		apiMocks.getCliStatus.mockResolvedValue({
			installed: true,
			installPath: "/usr/local/bin/helmor-dev",
			buildMode: "development",
			installState: "managed",
		});
		// First call fails; the retry call succeeds.
		apiMocks.installHelmorSkills
			.mockRejectedValueOnce(
				new Error("Helmor skills setup failed with a long stack trace."),
			)
			.mockResolvedValueOnce({
				installed: true,
				claude: true,
				codex: true,
				command: "",
			});

		render(
			<SkillsStep
				step="skills"
				onBack={vi.fn()}
				onNext={vi.fn()}
				isRoutingImport={false}
			/>,
		);

		const skillsItem = screen.getByRole("group", {
			name: "Helmor Skills (Beta)",
		});

		// The auto-install fires once on mount and fails — the user-
		// facing error is the unified, sanitised hint (no raw stack).
		await waitFor(() => {
			expect(
				within(skillsItem).getByText(/something went wrong/i),
			).toBeInTheDocument();
		});
		expect(within(skillsItem).getByText(/don't worry/i)).toBeInTheDocument();
		expect(
			within(skillsItem).queryByText(/long stack trace/i),
		).not.toBeInTheDocument();

		// Retry button is the recovery path the user can click.
		const retryBtn = await within(skillsItem).findByRole("button", {
			name: "Retry",
		});
		await user.click(retryBtn);

		await waitFor(() => {
			expect(apiMocks.installHelmorSkills).toHaveBeenCalledTimes(2);
		});
		await waitFor(() => {
			expect(within(skillsItem).getByText("Ready")).toBeInTheDocument();
		});
	});
});
