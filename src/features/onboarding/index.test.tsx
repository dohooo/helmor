import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, it, vi } from "vitest";
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
	loadAddRepositoryDefaults: vi.fn(async () => ({
		lastCloneDirectory: null,
	})),
}));

vi.mock("@/components/chrome/traffic-light-spacer", () => ({
	TrafficLightSpacer: () => null,
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
	SkillsStep: ({ step, onNext }: { step: string; onNext: () => void }) =>
		step === "skills" ? (
			<button type="button" onClick={onNext}>
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

describe("AppOnboarding repository import routing", () => {
	it("routes to repository import after the skills step", async () => {
		renderAtSkillsStep();
		fireEvent.click(screen.getByRole("button", { name: "Continue skills" }));

		await screen.findByLabelText("Repository import");
	});
});
