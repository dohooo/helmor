import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent, {
	PointerEventsCheckLevel,
} from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import * as api from "@/lib/api";

import { FeedbackDialog } from "./feedback-dialog";

vi.mock("@tauri-apps/plugin-dialog", () => ({
	open: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
	openUrl: vi.fn(),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
	toast: {
		success: (...args: unknown[]) => toastSuccess(...args),
		error: (...args: unknown[]) => toastError(...args),
	},
}));

vi.mock("@/lib/api", async () => {
	const actual = await vi.importActual<typeof api>("@/lib/api");
	return {
		...actual,
		listForgeAccounts: vi.fn(),
		findExistingHelmorRepo: vi.fn(),
		createHelmorIssue: vi.fn(),
		forkHelmorUpstream: vi.fn(),
		cloneRepositoryFromUrl: vi.fn(),
		prepareWorkspaceFromRepo: vi.fn(),
		finalizeWorkspaceFromRepo: vi.fn(),
		createSession: vi.fn(),
	};
});

const mockedApi = vi.mocked(api);

function renderDialog() {
	const onOpenChange = vi.fn();
	const onOpenSettings = vi.fn();
	const onSubmitPrompt = vi.fn(async () => {});
	// Radix Dialog applies pointer-events styles that confuse jsdom; disable
	// the check so userEvent can interact with the textarea + buttons.
	const user = userEvent.setup({
		pointerEventsCheck: PointerEventsCheckLevel.Never,
	});
	render(
		<TooltipProvider delayDuration={0}>
			<FeedbackDialog
				open
				onOpenChange={onOpenChange}
				onOpenSettings={onOpenSettings}
				onSubmitPrompt={onSubmitPrompt}
			/>
		</TooltipProvider>,
	);
	return { user, onOpenChange, onOpenSettings, onSubmitPrompt };
}

afterEach(() => {
	cleanup();
});

beforeEach(() => {
	vi.resetAllMocks();
	mockedApi.listForgeAccounts.mockResolvedValue([
		{
			provider: "github",
			host: "github.com",
			login: "tester",
			name: null,
			avatarUrl: null,
			email: null,
			active: true,
		},
	]);
	mockedApi.findExistingHelmorRepo.mockResolvedValue(null);
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
			screen.getByPlaceholderText(/describe a bug/i),
			"Panel flickers on scroll",
		);

		await waitFor(() => {
			expect(createIssue).not.toBeDisabled();
			expect(quickFix).not.toBeDisabled();
		});
	});

	it("gates both actions when GitHub isn't connected", async () => {
		mockedApi.listForgeAccounts.mockResolvedValue([]);

		const { user } = renderDialog();

		await screen.findByText(/connect github/i);
		const createIssue = screen.getByRole("button", { name: /create issue/i });
		const quickFix = screen.getByRole("button", { name: /quick fix/i });

		await user.type(
			screen.getByPlaceholderText(/describe a bug/i),
			"Has a bug",
		);
		expect(createIssue).toBeDisabled();
		expect(quickFix).toBeDisabled();
	});
});

describe("FeedbackDialog — create issue flow", () => {
	it("requires a second click to confirm, then sends via API and shows a toast", async () => {
		mockedApi.createHelmorIssue.mockResolvedValue({
			url: "https://github.com/dohooo/helmor/issues/7",
			number: 7,
		});

		const { user, onOpenChange } = renderDialog();

		const textarea = await screen.findByPlaceholderText(/describe a bug/i);
		await user.type(textarea, "Dark mode plz");
		const createIssue = screen.getByRole("button", { name: /create issue/i });
		await waitFor(() => expect(createIssue).not.toBeDisabled());

		// First click arms the confirmation UI but doesn't send.
		await user.click(createIssue);
		expect(mockedApi.createHelmorIssue).not.toHaveBeenCalled();
		expect(await screen.findByText(/confirm\?/i)).toBeInTheDocument();

		// Second click actually sends.
		await user.click(screen.getByRole("button", { name: /confirm send/i }));

		await waitFor(() =>
			expect(mockedApi.createHelmorIssue).toHaveBeenCalledWith(
				"Dark mode plz",
				"",
			),
		);

		// Dialog stays open, input clears, success toast fires with issue URL.
		expect(onOpenChange).not.toHaveBeenCalled();
		await waitFor(() => expect(textarea).toHaveValue(""));
		expect(toastSuccess).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				description: "https://github.com/dohooo/helmor/issues/7",
			}),
		);
	});

	it("cancel reverts the confirmation UI", async () => {
		const { user } = renderDialog();

		const textarea = await screen.findByPlaceholderText(/describe a bug/i);
		await user.type(textarea, "Something");
		const createIssue = screen.getByRole("button", { name: /create issue/i });
		await waitFor(() => expect(createIssue).not.toBeDisabled());
		await user.click(createIssue);

		await user.click(screen.getByRole("button", { name: /cancel/i }));
		expect(
			screen.queryByRole("button", { name: /confirm send/i }),
		).not.toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /create issue/i }),
		).toBeInTheDocument();
	});

	it("surfaces API failure via an error toast and leaves the input intact", async () => {
		mockedApi.createHelmorIssue.mockRejectedValue(new Error("rate limited"));

		const { user } = renderDialog();

		const textarea = await screen.findByPlaceholderText(/describe a bug/i);
		await user.type(textarea, "Broken thing");
		const createIssue = screen.getByRole("button", { name: /create issue/i });
		await waitFor(() => expect(createIssue).not.toBeDisabled());
		await user.click(createIssue);
		await user.click(screen.getByRole("button", { name: /confirm send/i }));

		await waitFor(() =>
			expect(toastError).toHaveBeenCalledWith(
				"Failed to create issue",
				expect.objectContaining({
					description: expect.stringMatching(/rate/i),
				}),
			),
		);
		expect(textarea).toHaveValue("Broken thing");
	});
});

describe("FeedbackDialog — quick fix flow", () => {
	it("skips fork + clone when a local helmor repo already exists", async () => {
		mockedApi.findExistingHelmorRepo.mockResolvedValue({
			repoId: "repo-1",
			repoName: "helmor",
		});

		const { user } = renderDialog();

		await waitFor(() =>
			expect(mockedApi.findExistingHelmorRepo).toHaveBeenCalled(),
		);

		await user.type(
			await screen.findByPlaceholderText(/describe a bug/i),
			"Improve the inspector",
		);
		await user.click(screen.getByRole("button", { name: /quick fix/i }));

		// Jumps straight to the prompt step — the prompt textarea is mounted
		// and Quick fix never triggered a fork.
		expect(
			await screen.findByRole("button", { name: /send to agent/i }),
		).toBeInTheDocument();
		expect(mockedApi.forkHelmorUpstream).not.toHaveBeenCalled();
	});

	it("Send to agent invokes onSubmitPrompt with the draft and closes the dialog", async () => {
		mockedApi.findExistingHelmorRepo.mockResolvedValue({
			repoId: "repo-9",
			repoName: "helmor",
		});

		const { user, onSubmitPrompt, onOpenChange } = renderDialog();

		await user.type(
			await screen.findByPlaceholderText(/describe a bug/i),
			"Fix the inspector",
		);
		await user.click(screen.getByRole("button", { name: /quick fix/i }));

		const sendBtn = await screen.findByRole("button", {
			name: /send to agent/i,
		});
		// The prompt template autofills on entry — wait for it.
		await waitFor(() => expect(sendBtn).not.toBeDisabled());
		await user.click(sendBtn);

		expect(onSubmitPrompt).toHaveBeenCalledWith(
			expect.objectContaining({
				repoId: "repo-9",
				prompt: expect.stringContaining("Fix the inspector"),
			}),
		);
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});
});
