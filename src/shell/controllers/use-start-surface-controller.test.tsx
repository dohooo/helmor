// R2-F2: fatal start-page create failures must surface as a persistent
// inline error (`startCreateError`), not a transient toast.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ComposerSubmitPayload } from "@/features/conversation";
import type { RepositoryCreateOption } from "@/lib/api";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import { useStartSurfaceController } from "./use-start-surface-controller";

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();
	return {
		...actual,
		getRepoCurrentBranch: vi.fn().mockResolvedValue("main"),
		listBranchesForWorkspacePicker: vi.fn().mockResolvedValue([]),
		prewarmSlashCommandsForRepo: vi.fn().mockResolvedValue(undefined),
		createAndCheckoutBranch: vi.fn().mockResolvedValue(undefined),
	};
});

const createWorkspaceFromStartComposer = vi.hoisted(() => vi.fn());
vi.mock("@/features/workspace-start/create-workspace", () => ({
	createWorkspaceFromStartComposer,
}));
vi.mock("@/features/workspace-start/seed-created-workspace", () => ({
	seedCreatedWorkspaceCaches: vi.fn(),
}));

const repoA = {
	id: "repo-a",
	name: "Repo A",
	defaultBranch: "main",
} as RepositoryCreateOption;
const repoB = {
	id: "repo-b",
	name: "Repo B",
	defaultBranch: "main",
} as RepositoryCreateOption;

const payload = {
	prompt: "hello",
	imagePaths: [],
	filePaths: [],
	customTags: [],
	editorStateSnapshot: null,
	model: { id: "model-1", provider: "claude", cliModel: "" },
	effortLevel: null,
	permissionMode: null,
	fastMode: false,
	terminalMode: false,
	provisionalSessionId: "prov-1",
	workingDirectory: null,
} as unknown as ComposerSubmitPayload;

function setup() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const pushToast = vi.fn();
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);
	const hook = renderHook(
		() =>
			useStartSurfaceController({
				queryClient,
				appSettings: DEFAULT_SETTINGS,
				areSettingsLoaded: true,
				updateSettings: vi.fn(),
				repositories: [repoA, repoB],
				pushToast,
				getViewMode: () => "start",
				viewMode: "start",
				openWorkspaceStart: vi.fn(),
				setViewMode: vi.fn(),
				selectWorkspace: vi.fn(),
				selectSession: vi.fn(),
				setPendingCreatedWorkspaceSubmit: vi.fn(),
			}),
		{ wrapper },
	);
	return { hook, pushToast };
}

describe("useStartSurfaceController startCreateError (R2-F2)", () => {
	it("sets the inline error on create failure without pushing a toast", async () => {
		createWorkspaceFromStartComposer.mockRejectedValueOnce(
			new Error("disk exploded"),
		);
		const { hook, pushToast } = setup();

		await act(async () => {
			await hook.result.current.actions.prepareComposer(payload);
		});

		expect(hook.result.current.state.startCreateError).toEqual({
			title: expect.any(String),
			message: "disk exploded",
		});
		expect(pushToast).not.toHaveBeenCalled();
	});

	it("clears the error when the user switches repository", async () => {
		createWorkspaceFromStartComposer.mockRejectedValueOnce(
			new Error("disk exploded"),
		);
		const { hook } = setup();

		await act(async () => {
			await hook.result.current.actions.prepareComposer(payload);
		});
		expect(hook.result.current.state.startCreateError).not.toBeNull();

		act(() => {
			hook.result.current.actions.selectRepository(repoB);
		});
		await waitFor(() => {
			expect(hook.result.current.state.startCreateError).toBeNull();
		});
	});

	it("clears the error on the next submit", async () => {
		createWorkspaceFromStartComposer.mockRejectedValueOnce(
			new Error("disk exploded"),
		);
		createWorkspaceFromStartComposer.mockResolvedValueOnce({
			finalizePromise: null,
			outcome: { shouldStream: false },
			workspaceId: "ws-1",
			sessionId: "sess-1",
			preparedWorkingDirectory: null,
			prepared: {},
		});
		const { hook } = setup();

		await act(async () => {
			await hook.result.current.actions.prepareComposer(payload);
		});
		expect(hook.result.current.state.startCreateError).not.toBeNull();

		await act(async () => {
			await hook.result.current.actions.prepareComposer(payload);
		});
		expect(hook.result.current.state.startCreateError).toBeNull();
	});
});
