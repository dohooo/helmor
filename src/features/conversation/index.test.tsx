import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ComposerSubmitPayload } from "./hooks/use-streaming";

const streamingMocks = vi.hoisted(() => ({
	handleComposerSubmit: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();
	return {
		...actual,
		loadSessionThreadMessages: vi.fn().mockResolvedValue([]),
	};
});

vi.mock("@/features/composer/container", () => ({
	WorkspaceComposerContainer: () => <div data-testid="composer" />,
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
		sendingSessionIds: new Set(),
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
				}}
				onPendingCreatedWorkspaceSubmitConsumed={onConsumed}
				workspaceRootPath="/tmp/new-workspace"
				composerOnly
			/>
		</QueryClientProvider>,
	);
}

describe("WorkspaceConversationContainer", () => {
	it("dispatches a created workspace submit through the normal send path", async () => {
		const onConsumed = vi.fn();
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

		renderContainer(pendingPayload, onConsumed);

		await waitFor(() => {
			expect(streamingMocks.handleComposerSubmit).toHaveBeenCalledWith({
				...pendingPayload,
				workingDirectory: "/tmp/new-workspace",
			});
		});
		expect(onConsumed).toHaveBeenCalledWith("pending-1");
	});
});
