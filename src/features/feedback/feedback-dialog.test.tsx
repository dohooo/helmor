import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent, {
	PointerEventsCheckLevel,
} from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import * as api from "@/lib/api";

import { FeedbackDialog } from "./feedback-dialog";

vi.mock("@tauri-apps/api/app", () => ({
	getVersion: vi.fn(async () => "1.0.0"),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
	open: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
	openUrl: vi.fn(),
}));

vi.mock("@/lib/api", async () => {
	const actual = await vi.importActual<typeof api>("@/lib/api");
	return {
		...actual,
		loadGithubIdentitySession: vi.fn(),
		findExistingHelmorWorkspace: vi.fn(),
		createHelmorIssue: vi.fn(),
		forkHelmorUpstream: vi.fn(),
		cloneRepositoryFromUrl: vi.fn(),
		prepareWorkspaceFromRepo: vi.fn(),
		finalizeWorkspaceFromRepo: vi.fn(),
		createSession: vi.fn(),
	};
});

const mockedApi = vi.mocked(api);

function renderDialog(
	overrides: Partial<React.ComponentProps<typeof FeedbackDialog>> = {},
) {
	const onOpenChange = vi.fn();
	const onOpenSettings = vi.fn();
	const onSelectWorkspace = vi.fn();
	// Radix Dialog applies pointer-events styles that confuse jsdom; disable
	// the check so userEvent can interact with the textarea + buttons. A
	// fresh user is returned per render so state doesn't leak across tests.
	const user = userEvent.setup({
		pointerEventsCheck: PointerEventsCheckLevel.Never,
	});
	render(
		<TooltipProvider delayDuration={0}>
			<FeedbackDialog
				open
				onOpenChange={onOpenChange}
				onOpenSettings={onOpenSettings}
				onSelectWorkspace={onSelectWorkspace}
				{...overrides}
			/>
		</TooltipProvider>,
	);
	return { user, onOpenChange, onOpenSettings, onSelectWorkspace };
}

afterEach(() => {
	cleanup();
});

beforeEach(() => {
	// resetAllMocks clears both call state AND stale implementations — some of
	// these mocks are configured inside individual tests and must not leak.
	vi.resetAllMocks();
	mockedApi.loadGithubIdentitySession.mockResolvedValue({
		status: "connected",
		session: {
			provider: "github",
			githubUserId: 1,
			login: "tester",
			name: null,
			avatarUrl: null,
			primaryEmail: null,
			tokenExpiresAt: null,
			refreshTokenExpiresAt: null,
		},
	});
	mockedApi.findExistingHelmorWorkspace.mockResolvedValue(null);
});

describe("FeedbackDialog — input step", () => {
	it("disables actions until the user types feedback", async () => {
		const { user } = renderDialog();

		const createIssue = await screen.findByRole("button", {
			name: /create issue/i,
		});
		const quickFix = await screen.findByRole("button", { name: /quick fix/i });

		expect(createIssue).toBeDisabled();
		expect(quickFix).toBeDisabled();

		await user.type(
			screen.getByLabelText(/what would you like to tell us/i),
			"Panel flickers on scroll",
		);

		await waitFor(() => {
			expect(createIssue).not.toBeDisabled();
			expect(quickFix).not.toBeDisabled();
		});
	});

	it("gates both actions when the user is not connected to GitHub", async () => {
		mockedApi.loadGithubIdentitySession.mockResolvedValue({
			status: "disconnected",
		});

		const { user } = renderDialog();

		await screen.findByText(/connect your github account/i);
		const createIssue = screen.getByRole("button", { name: /create issue/i });
		const quickFix = screen.getByRole("button", { name: /quick fix/i });

		await user.type(
			screen.getByLabelText(/what would you like to tell us/i),
			"Has a bug",
		);
		expect(createIssue).toBeDisabled();
		expect(quickFix).toBeDisabled();
	});
});

describe("FeedbackDialog — create issue flow", () => {
	it("creates an issue and shows the confirmation step", async () => {
		mockedApi.createHelmorIssue.mockResolvedValue({
			url: "https://github.com/Dohoo/helmor/issues/42",
			number: 42,
		});

		const { user } = renderDialog();

		const textarea = await screen.findByLabelText(
			/what would you like to tell us/i,
		);
		await user.type(textarea, "Panel flickers on scroll");
		const createIssue = screen.getByRole("button", { name: /create issue/i });
		await waitFor(() => {
			expect(createIssue).not.toBeDisabled();
		});
		await user.click(createIssue);

		await waitFor(() => {
			expect(mockedApi.createHelmorIssue).toHaveBeenCalled();
		});
		expect(mockedApi.createHelmorIssue).toHaveBeenCalledWith(
			"Panel flickers on scroll",
			expect.stringContaining("Panel flickers on scroll"),
		);

		expect(await screen.findByText(/issue #42 created/i)).toBeInTheDocument();
	});

	it("surfaces failure copy and keeps the input so the user can retry", async () => {
		mockedApi.createHelmorIssue.mockRejectedValue(new Error("rate limited"));

		const { user } = renderDialog();

		await user.type(
			await screen.findByLabelText(/what would you like to tell us/i),
			"Needs dark mode",
		);
		const createIssue = screen.getByRole("button", { name: /create issue/i });
		await waitFor(() => {
			expect(createIssue).not.toBeDisabled();
		});
		await user.click(createIssue);

		expect(
			await screen.findByText(/if this keeps failing/i),
		).toBeInTheDocument();
	});
});

describe("FeedbackDialog — quick fix flow", () => {
	it("skips fork + clone when a local helmor workspace already exists", async () => {
		mockedApi.findExistingHelmorWorkspace.mockResolvedValue({
			workspaceId: "ws-1",
			repoId: "repo-1",
			repoName: "helmor",
			branch: "feature-x",
		});

		const { user } = renderDialog();

		await waitFor(() =>
			expect(mockedApi.findExistingHelmorWorkspace).toHaveBeenCalled(),
		);

		await user.type(
			await screen.findByLabelText(/what would you like to tell us/i),
			"Improve the inspector",
		);
		await user.click(screen.getByRole("button", { name: /quick fix/i }));

		// Jumps straight to the prompt step — no "Step 1 · Prepare your fork"
		// header.
		expect(
			await screen.findByRole("heading", { name: /refine your prompt/i }),
		).toBeInTheDocument();
		expect(mockedApi.forkHelmorUpstream).not.toHaveBeenCalled();
	});
});
