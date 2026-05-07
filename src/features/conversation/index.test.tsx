import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComposerSubmitPayload } from "./hooks/use-streaming";

const streamingMocks = vi.hoisted(() => ({
	handleComposerSubmit: vi.fn(),
}));
const composerMocks = vi.hoisted(() => ({
	props: [] as Array<{ sending?: boolean }>,
}));

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();
	return {
		...actual,
		loadSessionThreadMessages: vi.fn().mockResolvedValue([]),
	};
});

vi.mock("@/features/composer/container", () => ({
	WorkspaceComposerContainer: (props: { sending?: boolean }) => {
		composerMocks.props.push(props);
		return <div data-testid="composer" />;
	},
}));

vi.mock("./hooks/use-streaming", () => ({
	useConversationStreaming: () => ({
		activeSendError: null,
		handleComposerSubmit: streamingMocks.handleComposerSubmit,
		handleDeferredToolResponse: vi.fn(),
		handleElicitationResponse: vi.fn(),
		handlePermissionResponse: vi.fn(),
		handleStopStream: vi.fn(),
		handleSteerQueued: vi.fn(),
		handleRemoveQueued: vi.fn(),
		elicitationResponsePending: false,
		isSending: false,
		pendingElicitation: null,
		pendingDeferredTool: null,
		pendingPermissions: [],
		restoreCustomTags: [],
		restoreDraft: null,
		restoreFiles: [],
		restoreImages: [],
		restoreNonce: 0,
		activeFastPreludes: {},
		busySessionIds: new Set(),
	}),
}));

import { WorkspaceConversationContainer } from "./index";

const MODEL = {
	id: "gpt-5.4",
	provider: "codex" as const,
	label: "GPT-5.4",
	cliModel: "gpt-5.4",
};

function renderContainer(
	pendingPayload: ComposerSubmitPayload,
	onConsumed = vi.fn(),
	options: {
		finalized?: boolean;
		busySessionIds?: Set<string>;
		stoppableSessionIds?: Set<string>;
		workspaceRootPath?: string | null;
	} = {},
) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});

	render(
		<QueryClientProvider client={queryClient}>
			<WorkspaceConversationContainer
				selectedWorkspaceId="workspace-1"
				displayedWorkspaceId="workspace-1"
				selectedSessionId="session-1"
				displayedSessionId="session-1"
				repoId="repo-1"
				onSelectSession={vi.fn()}
				onResolveDisplayedSession={vi.fn()}
				pendingCreatedWorkspaceSubmit={{
					id: "pending-1",
					workspaceId: "workspace-1",
					sessionId: "session-1",
					payload: pendingPayload,
					finalized: options.finalized ?? true,
				}}
				onPendingCreatedWorkspaceSubmitConsumed={onConsumed}
				busySessionIds={options.busySessionIds}
				stoppableSessionIds={options.stoppableSessionIds}
				workspaceRootPath={
					options.workspaceRootPath === undefined
						? "/tmp/new-workspace"
						: options.workspaceRootPath
				}
				composerOnly
			/>
		</QueryClientProvider>,
	);
}

describe("WorkspaceConversationContainer", () => {
	beforeEach(() => {
		composerMocks.props = [];
		streamingMocks.handleComposerSubmit.mockClear();
	});

	it("dispatches a created workspace submit through the normal send path", async () => {
		const onConsumed = vi.fn();
		// App.tsx is now responsible for patching `workingDirectory` onto the
		// payload (from prepare/finalize response) before flipping
		// `finalized=true`. This test mirrors that contract: payload arrives
		// already populated; conversation/index.tsx must dispatch it as-is.
		const pendingPayload: ComposerSubmitPayload = {
			prompt: "Build this now",
			imagePaths: [],
			filePaths: [],
			customTags: [],
			model: MODEL,
			workingDirectory: "/tmp/new-workspace",
			effortLevel: "high",
			permissionMode: "default",
			fastMode: false,
		};

		renderContainer(pendingPayload, onConsumed);

		await waitFor(() => {
			expect(streamingMocks.handleComposerSubmit).toHaveBeenCalledWith(
				pendingPayload,
				{
					sessionId: "session-1",
					workspaceId: "workspace-1",
					contextKey: "session:session-1",
				},
			);
		});
		expect(onConsumed).toHaveBeenCalledWith("pending-1");
	});

	it("uses payload.workingDirectory verbatim even when workspaceRootPath is null", async () => {
		// Regression: previously, when the workspaceDetail React Query was
		// still in-flight on first send (very common for local-mode submits
		// where finalize is a no-op), `workspaceRootPath` was null and the
		// container fell back to `payload.workingDirectory` — but the start
		// composer always seeded that as null too. The result was
		// `workingDirectory: null` reaching the agent, the CLI defaulting to
		// process cwd `/`, and the second turn failing with
		// `bad_resume_failure` because the transcript was written to the
		// wrong project bucket. With the fix, App.tsx always patches the
		// payload from prepare/finalize before flipping `finalized=true`.
		const onConsumed = vi.fn();
		const pendingPayload: ComposerSubmitPayload = {
			prompt: "Build this now",
			imagePaths: [],
			filePaths: [],
			customTags: [],
			model: MODEL,
			workingDirectory: "/Users/me/repos/foo",
			effortLevel: "high",
			permissionMode: "default",
			fastMode: false,
		};

		renderContainer(pendingPayload, onConsumed, { workspaceRootPath: null });

		await waitFor(() => {
			expect(streamingMocks.handleComposerSubmit).toHaveBeenCalledWith(
				pendingPayload,
				{
					sessionId: "session-1",
					workspaceId: "workspace-1",
					contextKey: "session:session-1",
				},
			);
		});
	});

	it("does not show composer stop while the session is only pending finalize", () => {
		const pendingPayload: ComposerSubmitPayload = {
			prompt: "Build this now",
			imagePaths: [],
			filePaths: [],
			customTags: [],
			model: MODEL,
			workingDirectory: null,
			effortLevel: "high",
			permissionMode: "default",
			fastMode: false,
		};

		renderContainer(pendingPayload, vi.fn(), {
			finalized: false,
			busySessionIds: new Set(["session-1"]),
			stoppableSessionIds: new Set(),
		});

		expect(composerMocks.props.at(-1)?.sending).toBe(false);
	});

	it("shows composer stop when the displayed session is stoppable", () => {
		const pendingPayload: ComposerSubmitPayload = {
			prompt: "Build this now",
			imagePaths: [],
			filePaths: [],
			customTags: [],
			model: MODEL,
			workingDirectory: null,
			effortLevel: "high",
			permissionMode: "default",
			fastMode: false,
		};

		renderContainer(pendingPayload, vi.fn(), {
			finalized: false,
			busySessionIds: new Set(["session-1"]),
			stoppableSessionIds: new Set(["session-1"]),
		});

		expect(composerMocks.props.at(-1)?.sending).toBe(true);
	});
});
