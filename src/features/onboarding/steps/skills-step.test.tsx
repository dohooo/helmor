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
		apiMocks.getHelmorSkillsStatus.mockResolvedValue({
			installed: false,
			claude: false,
			codex: false,
			command:
				"npx --yes skills add dohooo/helmor/.agents/skills/helmor-cli -g -s helmor-cli -y --copy -a claude-code -a codex",
		});
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("shows Ready when the Helmor CLI is already installed", async () => {
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

		const cliItem = screen.getByRole("group", { name: "Helmor CLI" });

		await waitFor(() => {
			expect(within(cliItem).getByText("Ready")).toBeInTheDocument();
		});
		expect(
			within(cliItem).queryByRole("button", { name: "Set up" }),
		).not.toBeInTheDocument();
		expect(apiMocks.installCli).not.toHaveBeenCalled();
	});

	it("installs the Helmor CLI from the setup item", async () => {
		const user = userEvent.setup();
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

		await user.click(within(cliItem).getByRole("button", { name: "Set up" }));

		await waitFor(() => {
			expect(apiMocks.installCli).toHaveBeenCalledTimes(1);
		});
		expect(within(cliItem).getByText("Ready")).toBeInTheDocument();
		expect(
			within(cliItem).queryByRole("button", { name: "Set up" }),
		).not.toBeInTheDocument();
	});

	it("installs Helmor skills from the setup item", async () => {
		const user = userEvent.setup();
		apiMocks.getCliStatus.mockResolvedValue({
			installed: true,
			installPath: "/usr/local/bin/helmor-dev",
			buildMode: "development",
			installState: "managed",
		});
		apiMocks.installHelmorSkills.mockResolvedValue({
			installed: true,
			claude: true,
			codex: false,
			command:
				"npx --yes skills add dohooo/helmor/.agents/skills/helmor-cli -g -s helmor-cli -y --copy -a claude-code",
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

		await user.click(
			within(skillsItem).getByRole("button", { name: "Set up" }),
		);

		await waitFor(() => {
			expect(apiMocks.installHelmorSkills).toHaveBeenCalledTimes(1);
		});
		expect(within(skillsItem).getByText("Ready")).toBeInTheDocument();
	});

	it("shows the unified failure hint when skills setup throws", async () => {
		const user = userEvent.setup();
		apiMocks.getCliStatus.mockResolvedValue({
			installed: true,
			installPath: "/usr/local/bin/helmor-dev",
			buildMode: "development",
			installState: "managed",
		});
		apiMocks.installHelmorSkills.mockRejectedValue(
			new Error("Helmor skills setup failed with a long stack trace."),
		);

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

		await user.click(
			within(skillsItem).getByRole("button", { name: "Set up" }),
		);

		await waitFor(() => {
			expect(
				within(skillsItem).getByText(/something went wrong/i),
			).toBeInTheDocument();
		});
		expect(within(skillsItem).getByText(/don't worry/i)).toBeInTheDocument();
		expect(
			within(skillsItem).queryByText(/long stack trace/i),
		).not.toBeInTheDocument();
	});
});
