import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingDeferredTool } from "@/features/conversation/pending-deferred-tool";
import type { AgentModelOption } from "@/lib/api";
import { WorkspaceToastProvider } from "@/lib/workspace-toast-context";
import { useConversationStreaming } from "./use-streaming";

const apiMocks = vi.hoisted(() => ({
	generateSessionTitle: vi.fn(),
	respondToDeferredTool: vi.fn(),
	respondToPermissionRequest: vi.fn(),
	startAgentMessageStream: vi.fn(),
	stopAgentStream: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();

	return {
		...actual,
		generateSessionTitle: apiMocks.generateSessionTitle,
		respondToDeferredTool: apiMocks.respondToDeferredTool,
		respondToPermissionRequest: apiMocks.respondToPermissionRequest,
		startAgentMessageStream: apiMocks.startAgentMessageStream,
		stopAgentStream: apiMocks.stopAgentStream,
	};
});

const MODEL: AgentModelOption = {
	id: "gpt-5.4",
	provider: "codex",
	label: "GPT-5.4",
	cliModel: "gpt-5.4",
};

function createDeferredTool(): PendingDeferredTool {
	return {
		provider: "claude",
		modelId: "opus-1m",
		resolvedModel: "opus-1m",
		providerSessionId: "provider-session-1",
		workingDirectory: "/tmp/helmor",
		permissionMode: "default",
		toolUseId: "tool-1",
		toolName: "AskUserQuestion",
		toolInput: {
			question: "Pick one",
		},
	};
}

function getLastInteractionSnapshot(
	interactionSnapshots: Map<string, string>[],
) {
	return interactionSnapshots[interactionSnapshots.length - 1];
}

function createWrapper() {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: {
				retry: false,
			},
		},
	});
	const pushToast = vi.fn();

	return function Wrapper({ children }: { children: ReactNode }) {
		return (
			<WorkspaceToastProvider value={pushToast}>
				<QueryClientProvider client={queryClient}>
					{children}
				</QueryClientProvider>
			</WorkspaceToastProvider>
		);
	};
}

describe("useConversationStreaming", () => {
	beforeEach(() => {
		apiMocks.generateSessionTitle.mockReset();
		apiMocks.respondToDeferredTool.mockReset();
		apiMocks.respondToPermissionRequest.mockReset();
		apiMocks.startAgentMessageStream.mockReset();
		apiMocks.stopAgentStream.mockReset();

		apiMocks.generateSessionTitle.mockResolvedValue(null);
		apiMocks.respondToDeferredTool.mockResolvedValue(undefined);
		apiMocks.respondToPermissionRequest.mockResolvedValue(undefined);
		apiMocks.stopAgentStream.mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("keeps approval requests scoped to their session context", async () => {
		const streamCallbacks: Array<(event: unknown) => void> = [];
		apiMocks.startAgentMessageStream.mockImplementation(
			async (_payload: unknown, onEvent: (event: unknown) => void) => {
				streamCallbacks.push(onEvent);
			},
		);

		const interactionSnapshots: Map<string, string>[] = [];
		const wrapper = createWrapper();
		const { result, rerender } = renderHook(
			({ composerContextKey, displayedSessionId, displayedWorkspaceId }) =>
				useConversationStreaming({
					composerContextKey,
					displayedSelectedModelId: MODEL.id,
					displayedSessionId,
					displayedWorkspaceId,
					onInteractionSessionsChange: (sessionWorkspaceMap) => {
						interactionSnapshots.push(new Map(sessionWorkspaceMap));
					},
					selectionPending: false,
				}),
			{
				initialProps: {
					composerContextKey: "session:session-1",
					displayedSessionId: "session-1",
					displayedWorkspaceId: "workspace-1",
				},
				wrapper,
			},
		);

		await act(async () => {
			await result.current.handleComposerSubmit({
				prompt: "Need approval",
				imagePaths: [],
				filePaths: [],
				customTags: [],
				model: MODEL,
				workingDirectory: "/tmp/helmor",
				effortLevel: "medium",
				permissionMode: "default",
			});
		});

		expect(streamCallbacks).toHaveLength(1);

		act(() => {
			streamCallbacks[0]({
				kind: "permissionRequest",
				permissionId: "permission-1",
				toolName: "run_in_terminal",
				toolInput: { command: "git status" },
				title: "Shell command",
				description: "Run git status",
			});
		});

		expect(result.current.pendingPermissions).toHaveLength(1);
		expect(getLastInteractionSnapshot(interactionSnapshots)).toEqual(
			new Map([["session-1", "workspace-1"]]),
		);

		rerender({
			composerContextKey: "session:session-2",
			displayedSessionId: "session-2",
			displayedWorkspaceId: "workspace-1",
		});

		expect(result.current.pendingPermissions).toEqual([]);
		expect(getLastInteractionSnapshot(interactionSnapshots)).toEqual(
			new Map([["session-1", "workspace-1"]]),
		);

		rerender({
			composerContextKey: "session:session-1",
			displayedSessionId: "session-1",
			displayedWorkspaceId: "workspace-1",
		});

		expect(result.current.pendingPermissions).toHaveLength(1);

		act(() => {
			result.current.handlePermissionResponse("permission-1", "allow");
		});

		expect(apiMocks.respondToPermissionRequest).toHaveBeenCalledWith(
			"permission-1",
			"allow",
		);
		expect(result.current.pendingPermissions).toEqual([]);
		expect(getLastInteractionSnapshot(interactionSnapshots)).toEqual(new Map());
	});

	it("uses the Helmor session id when stopping a resumed deferred stream", async () => {
		apiMocks.startAgentMessageStream.mockImplementation(
			async (_payload: unknown, _onEvent: (event: unknown) => void) => {
				return undefined;
			},
		);

		const wrapper = createWrapper();
		const { result } = renderHook(
			() =>
				useConversationStreaming({
					composerContextKey: "session:session-1",
					displayedSelectedModelId: MODEL.id,
					displayedSessionId: "session-1",
					displayedWorkspaceId: "workspace-1",
					selectionPending: false,
				}),
			{ wrapper },
		);

		await act(async () => {
			await result.current.handleDeferredToolResponse(
				createDeferredTool(),
				"allow",
			);
		});

		expect(apiMocks.startAgentMessageStream).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "claude",
				modelId: "opus-1m",
				resumeOnly: true,
				sessionId: "provider-session-1",
				helmorSessionId: "session-1",
			}),
			expect.any(Function),
		);

		act(() => {
			result.current.handleStopStream();
		});

		expect(apiMocks.stopAgentStream).toHaveBeenCalledWith(
			"session-1",
			"claude",
		);
		expect(apiMocks.stopAgentStream).not.toHaveBeenCalledWith(
			"provider-session-1",
			"claude",
		);
	});
});
