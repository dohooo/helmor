import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	isConductorAvailable,
	listConductorRepos,
	listConductorWorkspaces,
} from "@/lib/api";
import { AppOnboarding } from ".";

vi.mock("@tauri-apps/plugin-dialog", () => ({
	open: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
	addRepositoryFromLocalPath: vi.fn(),
	cloneRepositoryFromUrl: vi.fn(),
	deleteRepository: vi.fn(),
	enterOnboardingWindowMode: vi.fn(async () => undefined),
	exitOnboardingWindowMode: vi.fn(async () => undefined),
	getAgentLoginStatus: vi.fn(async () => undefined),
	isConductorAvailable: vi.fn(async () => false),
	listConductorRepos: vi.fn(async () => []),
	listConductorWorkspaces: vi.fn(async () => []),
	loadAddRepositoryDefaults: vi.fn(async () => ({
		lastCloneDirectory: null,
	})),
}));

vi.mock("@/components/chrome/traffic-light-spacer", () => ({
	TrafficLightSpacer: () => null,
}));

vi.mock("@/components/conductor-onboarding", () => ({
	ConductorOnboarding: ({ workspaces }: { workspaces: { id: string }[] }) => (
		<div aria-label="Conductor onboarding">
			Conductor workspaces: {workspaces.length}
		</div>
	),
}));

vi.mock("@/features/navigation/clone-from-url-dialog", () => ({
	CloneFromUrlDialog: () => null,
}));

vi.mock("./components/intro-preview", () => ({
	IntroPreview: ({ step, onNext }: { step: string; onNext: () => void }) =>
		step === "intro" ? (
			<button type="button" onClick={onNext}>
				Continue intro
			</button>
		) : null,
}));

vi.mock("./steps/agent-login-step", () => ({
	AgentLoginStep: ({ step, onNext }: { step: string; onNext: () => void }) =>
		step === "agents" ? (
			<button type="button" onClick={onNext}>
				Continue agents
			</button>
		) : null,
}));

vi.mock("./steps/repository-cli-step", () => ({
	RepositoryCliStep: ({
		step,
		onNext,
	}: {
		step: string;
		onNext: () => void;
	}) =>
		step === "corner" ? (
			<button type="button" onClick={onNext}>
				Continue repository cli
			</button>
		) : null,
}));

vi.mock("./steps/skills-step", () => ({
	SkillsStep: ({
		step,
		onNext,
		isRoutingImport,
	}: {
		step: string;
		onNext: () => void;
		isRoutingImport: boolean;
	}) =>
		step === "skills" ? (
			<button type="button" disabled={isRoutingImport} onClick={onNext}>
				Continue skills
			</button>
		) : null,
}));

vi.mock("./steps/repo-import-step", () => ({
	RepoImportStep: ({ step }: { step: string }) =>
		step === "repoImport" ? (
			<div aria-label="Repository import">Repository import</div>
		) : null,
}));

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

function renderAtSkillsStep() {
	render(<AppOnboarding onComplete={vi.fn()} />);

	fireEvent.click(screen.getByRole("button", { name: "Continue intro" }));
	fireEvent.click(screen.getByRole("button", { name: "Continue agents" }));
	fireEvent.click(
		screen.getByRole("button", { name: "Continue repository cli" }),
	);
}

const importableWorkspace = {
	id: "workspace-1",
	directoryName: "workspace-one",
	state: "ready",
	branch: "main",
	status: null,
	prTitle: null,
	sessionCount: 2,
	messageCount: 12,
	alreadyImported: false,
	iconSrc: null,
};

describe("AppOnboarding conductor routing", () => {
	it("routes to repository import when Conductor is unavailable", async () => {
		vi.mocked(isConductorAvailable).mockResolvedValue(false);

		renderAtSkillsStep();
		fireEvent.click(screen.getByRole("button", { name: "Continue skills" }));

		await screen.findByLabelText("Repository import");
		expect(listConductorRepos).not.toHaveBeenCalled();
	});

	it("routes to Conductor onboarding when importable workspaces exist", async () => {
		vi.mocked(isConductorAvailable).mockResolvedValue(true);
		vi.mocked(listConductorRepos).mockResolvedValue([
			{
				id: "repo-1",
				name: "Repo 1",
				remoteUrl: null,
				workspaceCount: 1,
				alreadyImportedCount: 0,
			},
		]);
		vi.mocked(listConductorWorkspaces).mockResolvedValue([importableWorkspace]);

		renderAtSkillsStep();
		fireEvent.click(screen.getByRole("button", { name: "Continue skills" }));

		await screen.findByLabelText("Conductor onboarding");
		expect(screen.getByText("Conductor workspaces: 1")).toBeInTheDocument();
		expect(listConductorWorkspaces).toHaveBeenCalledWith("repo-1");
	});

	it("falls back to repository import when Conductor has no new workspaces", async () => {
		vi.mocked(isConductorAvailable).mockResolvedValue(true);
		vi.mocked(listConductorRepos).mockResolvedValue([
			{
				id: "repo-1",
				name: "Repo 1",
				remoteUrl: null,
				workspaceCount: 1,
				alreadyImportedCount: 1,
			},
		]);

		renderAtSkillsStep();
		fireEvent.click(screen.getByRole("button", { name: "Continue skills" }));

		await waitFor(() => {
			expect(screen.getByLabelText("Repository import")).toBeInTheDocument();
		});
		expect(listConductorWorkspaces).not.toHaveBeenCalled();
	});
});
