import { QueryClient } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
	ComposerSubmitPayload,
	PendingCreatedWorkspaceSubmit,
} from "@/features/conversation";
import type { AgentModelOption, FinalizeWorkspaceResponse } from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import { DEFAULT_SETTINGS } from "@/lib/settings";

vi.mock("@/features/workspace-start/create-workspace", () => ({
	createWorkspaceFromStartComposer: vi.fn(),
}));

import { createWorkspaceFromStartComposer } from "@/features/workspace-start/create-workspace";

import { useFeedbackSubmit } from "./use-feedback-submit";

const MODEL: AgentModelOption = {
	id: "claude-opus-4",
	provider: "claude",
	label: "Opus 4",
	cliModel: "opus-4",
};

const mockedCreate = vi.mocked(createWorkspaceFromStartComposer);

type SetupOptions = {
	models?: AgentModelOption[];
	defaultModelId?: string | null;
};

function setup({
	models = [MODEL],
	defaultModelId = MODEL.id,
}: SetupOptions = {}) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	queryClient.setQueryData(helmorQueryKeys.agentModelSections, [
		{ id: "s", label: "Section", options: models },
	]);
	const selectWorkspace = vi.fn();
	const selectSession = vi.fn();
	const setViewMode = vi.fn();
	const setPendingCreatedWorkspaceSubmit = vi.fn();
	const pushToast = vi.fn();
	const { result } = renderHook(() =>
		useFeedbackSubmit({
			queryClient,
			appSettings: { ...DEFAULT_SETTINGS, defaultModelId },
			selectWorkspace,
			selectSession,
			setViewMode,
			setPendingCreatedWorkspaceSubmit,
			pushToast,
		}),
	);
	return {
		submit: result.current,
		selectWorkspace,
		selectSession,
		setViewMode,
		setPendingCreatedWorkspaceSubmit,
		pushToast,
	};
}

// `requestAnimationFrame` runs the view-switch burst on the next paint.
// In tests we want it synchronous so selectWorkspace/selectSession/setViewMode
// land before assertions run.
beforeEach(() => {
	vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
		cb(performance.now());
		return 0;
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	mockedCreate.mockReset();
});

function makePending(overrides: Partial<PendingCreatedWorkspaceSubmit> = {}) {
	const base: PendingCreatedWorkspaceSubmit = {
		id: "pending-stub",
		workspaceId: "w1",
		sessionId: "s1",
		payload: {
			prompt: "fix",
			imagePaths: [],
			filePaths: [],
			customTags: [],
			model: MODEL,
			workingDirectory: null,
			effortLevel: "high",
			permissionMode: "default",
			fastMode: false,
		} as ComposerSubmitPayload,
		finalized: false,
	};
	return { ...base, ...overrides };
}

describe("useFeedbackSubmit", () => {
	it("toasts and bails when no model is configured", async () => {
		const ctx = setup({ models: [], defaultModelId: null });
		await ctx.submit({ repoId: "r1", prompt: "hi" });
		expect(mockedCreate).not.toHaveBeenCalled();
		expect(ctx.setPendingCreatedWorkspaceSubmit).not.toHaveBeenCalled();
		expect(ctx.pushToast).toHaveBeenCalledWith(
			expect.stringMatching(/default model/i),
			"Can't send feedback",
		);
	});

	it("queues pending submit then flips finalized=true after finalize resolves", async () => {
		let resolveFinalize!: (v: FinalizeWorkspaceResponse) => void;
		const finalizePromise = new Promise<FinalizeWorkspaceResponse>(
			(resolve) => {
				resolveFinalize = resolve;
			},
		);
		mockedCreate.mockResolvedValue({
			outcome: {
				shouldStream: true,
				workspaceId: "w1",
				sessionId: "s1",
				contextKey: "k",
			},
			workspaceId: "w1",
			sessionId: "s1",
			finalizePromise,
			preparedWorkingDirectory: "/prepared",
		});

		const ctx = setup();
		const submitPromise = ctx.submit({ repoId: "r1", prompt: "fix this" });

		// First `setPending` lands immediately after Phase 1.
		await waitFor(() => {
			expect(ctx.setPendingCreatedWorkspaceSubmit).toHaveBeenCalledTimes(1);
		});
		const first = ctx.setPendingCreatedWorkspaceSubmit.mock
			.calls[0][0] as PendingCreatedWorkspaceSubmit;
		expect(first.workspaceId).toBe("w1");
		expect(first.sessionId).toBe("s1");
		expect(first.finalized).toBe(false);
		expect(first.payload.workingDirectory).toBe("/prepared");
		expect(first.payload.prompt).toBe("fix this");

		// View switch (selectWorkspace + selectSession + setViewMode) was
		// scheduled in the RAF callback, which our stub runs synchronously.
		expect(ctx.selectWorkspace).toHaveBeenCalledWith("w1");
		expect(ctx.selectSession).toHaveBeenCalledWith("s1");
		expect(ctx.setViewMode).toHaveBeenCalledWith("conversation");

		// finalize hasn't resolved yet — flip not invoked.
		expect(ctx.setPendingCreatedWorkspaceSubmit).toHaveBeenCalledTimes(1);

		resolveFinalize({
			workspaceId: "w1",
			finalState: "ready",
			workingDirectory: "/final",
		});
		await submitPromise;

		expect(ctx.setPendingCreatedWorkspaceSubmit).toHaveBeenCalledTimes(2);
		const updaterArg = ctx.setPendingCreatedWorkspaceSubmit.mock
			.calls[1][0] as (
			prev: PendingCreatedWorkspaceSubmit | null,
		) => PendingCreatedWorkspaceSubmit | null;
		const flipped = updaterArg(makePending({ id: first.id }));
		expect(flipped).not.toBeNull();
		expect(flipped?.finalized).toBe(true);
		expect(flipped?.payload.workingDirectory).toBe("/final");

		// Updater must be a no-op for a different pendingId — protects the
		// next pending submit if the user kicks off two in quick succession.
		const unrelated = makePending({ id: "other" });
		expect(updaterArg(unrelated)).toBe(unrelated);

		expect(ctx.pushToast).not.toHaveBeenCalled();
	});

	it("clears pending and toasts when finalize rejects", async () => {
		let rejectFinalize!: (error: unknown) => void;
		const finalizePromise = new Promise<FinalizeWorkspaceResponse>(
			(_, reject) => {
				rejectFinalize = reject;
			},
		);
		mockedCreate.mockResolvedValue({
			outcome: {
				shouldStream: true,
				workspaceId: "w1",
				sessionId: "s1",
				contextKey: "k",
			},
			workspaceId: "w1",
			sessionId: "s1",
			finalizePromise,
			preparedWorkingDirectory: null,
		});

		const ctx = setup();
		const submitPromise = ctx.submit({ repoId: "r1", prompt: "fix" });

		await waitFor(() => {
			expect(ctx.setPendingCreatedWorkspaceSubmit).toHaveBeenCalledTimes(1);
		});
		const first = ctx.setPendingCreatedWorkspaceSubmit.mock
			.calls[0][0] as PendingCreatedWorkspaceSubmit;
		const pendingId = first.id;

		rejectFinalize(new Error("worktree blew up"));
		await submitPromise;

		expect(ctx.setPendingCreatedWorkspaceSubmit).toHaveBeenCalledTimes(2);
		const updaterArg = ctx.setPendingCreatedWorkspaceSubmit.mock
			.calls[1][0] as (
			prev: PendingCreatedWorkspaceSubmit | null,
		) => PendingCreatedWorkspaceSubmit | null;

		// Clears only when the pendingId still matches — a follow-up submit
		// with a different id must survive.
		expect(updaterArg(makePending({ id: pendingId }))).toBeNull();
		const unrelated = makePending({ id: "other" });
		expect(updaterArg(unrelated)).toBe(unrelated);

		expect(ctx.pushToast).toHaveBeenCalledWith(
			expect.stringMatching(/worktree/i),
			"Workspace setup failed",
		);
	});

	it("toasts when createWorkspaceFromStartComposer throws", async () => {
		mockedCreate.mockRejectedValue(new Error("repo missing"));
		const ctx = setup();
		await ctx.submit({ repoId: "r1", prompt: "fix" });
		expect(ctx.setPendingCreatedWorkspaceSubmit).not.toHaveBeenCalled();
		expect(ctx.pushToast).toHaveBeenCalledWith(
			expect.stringMatching(/repo missing/i),
			"Couldn't open workspace",
		);
	});
});
