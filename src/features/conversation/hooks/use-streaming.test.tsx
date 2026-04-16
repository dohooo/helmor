import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingDeferredTool } from "@/features/conversation/pending-deferred-tool";
import type { PendingElicitation } from "@/features/conversation/pending-elicitation";
import type { AgentModelOption } from "@/lib/api";
import { WorkspaceToastProvider } from "@/lib/workspace-toast-context";
import { useConversationStreaming } from "./use-streaming";

const apiMocks = vi.hoisted(() => ({
	generateSessionTitle: vi.fn(),
	loadSessionThreadMessages: vi.fn(),
	respondToDeferredTool: vi.fn(),
	respondToElicitationRequest: vi.fn(),
	respondToPermissionRequest: vi.fn(),
	startAgentMessageStream: vi.fn(),
	stopAgentStream: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();

	return {
		...actual,
		generateSessionTitle: apiMocks.generateSessionTitle,
		loadSessionThreadMessages: apiMocks.loadSessionThreadMessages,
		respondToDeferredTool: apiMocks.respondToDeferredTool,
		respondToElicitationRequest: apiMocks.respondToElicitationRequest,
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

function createPendingElicitation(): PendingElicitation {
	return {
		provider: "claude",
		modelId: "opus-1m",
		resolvedModel: "opus-1m",
		providerSessionId: "provider-session-1",
		workingDirectory: "/tmp/helmor",
		elicitationId: "elicitation-1",
		serverName: "design-server",
		message: "Need structured input",
		mode: "form",
		requestedSchema: {
			type: "object",
			properties: {
				name: {
					type: "string",
					title: "Name",
				},
			},
			required: ["name"],
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

	function Wrapper({ children }: { children: ReactNode }) {
		return (
			<WorkspaceToastProvider value={pushToast}>
				<QueryClientProvider client={queryClient}>
					{children}
				</QueryClientProvider>
			</WorkspaceToastProvider>
		);
	}

	return { Wrapper, queryClient, pushToast };
}

describe("useConversationStreaming", () => {
	beforeEach(() => {
		apiMocks.generateSessionTitle.mockReset();
		apiMocks.loadSessionThreadMessages.mockReset();
		apiMocks.respondToDeferredTool.mockReset();
		apiMocks.respondToPermissionRequest.mockReset();
		apiMocks.startAgentMessageStream.mockReset();
		apiMocks.stopAgentStream.mockReset();

		apiMocks.generateSessionTitle.mockResolvedValue(null);
		apiMocks.loadSessionThreadMessages.mockResolvedValue([]);
		apiMocks.respondToDeferredTool.mockResolvedValue(undefined);
		apiMocks.respondToElicitationRequest.mockResolvedValue(undefined);
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
		const { Wrapper } = createWrapper();
		const { result, rerender } = renderHook(
			({ composerContextKey, displayedSessionId, displayedWorkspaceId }) =>
				useConversationStreaming({
					composerContextKey,
					displayedSelectedModelId: MODEL.id,
					displayedSessionId,
					displayedWorkspaceId,
					onInteractionSessionsChange: (sessionWorkspaceMap, _counts) => {
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
				wrapper: Wrapper,
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
				fastMode: false,
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
			undefined,
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

		const { Wrapper } = createWrapper();
		const { result } = renderHook(
			() =>
				useConversationStreaming({
					composerContextKey: "session:session-1",
					displayedSelectedModelId: MODEL.id,
					displayedSessionId: "session-1",
					displayedWorkspaceId: "workspace-1",
					selectionPending: false,
				}),
			{ wrapper: Wrapper },
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

	it("sets hasPlanReview when planCaptured event is received", async () => {
		apiMocks.startAgentMessageStream.mockImplementation(
			async (_payload: unknown, onEvent: (event: unknown) => void) => {
				onEvent({ kind: "planCaptured" });
			},
		);

		const { Wrapper } = createWrapper();
		const { result } = renderHook(
			() =>
				useConversationStreaming({
					composerContextKey: "session:session-1",
					displayedSelectedModelId: MODEL.id,
					displayedSessionId: "session-1",
					displayedWorkspaceId: "workspace-1",
					selectionPending: false,
				}),
			{ wrapper: Wrapper },
		);

		await act(async () => {
			await result.current.handleComposerSubmit({
				prompt: "plan something",
				imagePaths: [],
				filePaths: [],
				customTags: [],
				model: MODEL,
				workingDirectory: "/tmp/helmor",
				effortLevel: "medium",
				permissionMode: "plan",
				fastMode: false,
			});
		});

		expect(result.current.hasPlanReview).toBe(true);
	});

	it("clears hasPlanReview when a new message is submitted", async () => {
		apiMocks.startAgentMessageStream.mockImplementation(
			async (_payload: unknown, onEvent: (event: unknown) => void) => {
				onEvent({ kind: "planCaptured" });
			},
		);

		const { Wrapper } = createWrapper();
		const { result } = renderHook(
			() =>
				useConversationStreaming({
					composerContextKey: "session:session-1",
					displayedSelectedModelId: MODEL.id,
					displayedSessionId: "session-1",
					displayedWorkspaceId: "workspace-1",
					selectionPending: false,
				}),
			{ wrapper: Wrapper },
		);

		await act(async () => {
			await result.current.handleComposerSubmit({
				prompt: "plan something",
				imagePaths: [],
				filePaths: [],
				customTags: [],
				model: MODEL,
				workingDirectory: "/tmp/helmor",
				effortLevel: "medium",
				permissionMode: "plan",
				fastMode: false,
			});
		});

		expect(result.current.hasPlanReview).toBe(true);

		// Reset mock so the second submit does not re-emit planCaptured
		apiMocks.startAgentMessageStream.mockImplementation(async () => {});

		// Submitting a new message should clear the plan review
		await act(async () => {
			await result.current.handleComposerSubmit({
				prompt: "implement it",
				imagePaths: [],
				filePaths: [],
				customTags: [],
				model: MODEL,
				workingDirectory: "/tmp/helmor",
				effortLevel: "medium",
				permissionMode: "bypassPermissions",
				fastMode: false,
			});
		});

		expect(result.current.hasPlanReview).toBe(false);
	});

	it("tracks pending elicitation separately from deferred tools", async () => {
		const streamCallbacks: Array<(event: unknown) => void> = [];
		apiMocks.startAgentMessageStream.mockImplementation(
			async (_payload: unknown, onEvent: (event: unknown) => void) => {
				streamCallbacks.push(onEvent);
			},
		);

		const interactionSnapshots: Map<string, string>[] = [];
		const { Wrapper } = createWrapper();
		const { result } = renderHook(
			() =>
				useConversationStreaming({
					composerContextKey: "session:session-1",
					displayedSelectedModelId: MODEL.id,
					displayedSessionId: "session-1",
					displayedWorkspaceId: "workspace-1",
					onInteractionSessionsChange: (sessionWorkspaceMap, _counts) => {
						interactionSnapshots.push(new Map(sessionWorkspaceMap));
					},
					selectionPending: false,
				}),
			{ wrapper: Wrapper },
		);

		await act(async () => {
			await result.current.handleComposerSubmit({
				prompt: "Need structured input",
				imagePaths: [],
				filePaths: [],
				customTags: [],
				model: MODEL,
				workingDirectory: "/tmp/helmor",
				effortLevel: "medium",
				permissionMode: "default",
				fastMode: false,
			});
		});

		act(() => {
			streamCallbacks[0]({
				kind: "elicitationRequest",
				provider: "claude",
				modelId: "",
				resolvedModel: "opus-1m",
				sessionId: "provider-session-1",
				workingDirectory: "/tmp/helmor",
				elicitationId: "elicitation-1",
				serverName: "design-server",
				message: "Need structured input",
				mode: "form",
				requestedSchema: {
					type: "object",
					properties: {
						name: { type: "string", title: "Name" },
					},
					required: ["name"],
				},
			});
		});

		expect(result.current.pendingDeferredTool).toBeNull();
		expect(result.current.pendingElicitation).toEqual(
			expect.objectContaining({
				elicitationId: "elicitation-1",
				modelId: MODEL.id,
				serverName: "design-server",
			}),
		);
		expect(getLastInteractionSnapshot(interactionSnapshots)).toEqual(
			new Map([["session-1", "workspace-1"]]),
		);
	});

	it("keeps persisted stream errors out of the composer error state", async () => {
		const streamCallbacks: Array<(event: unknown) => void> = [];
		apiMocks.startAgentMessageStream.mockImplementation(
			async (_payload: unknown, onEvent: (event: unknown) => void) => {
				streamCallbacks.push(onEvent);
			},
		);

		const { Wrapper } = createWrapper();
		const { result } = renderHook(
			() =>
				useConversationStreaming({
					composerContextKey: "session:session-1",
					displayedSelectedModelId: MODEL.id,
					displayedSessionId: "session-1",
					displayedWorkspaceId: "workspace-1",
					selectionPending: false,
				}),
			{ wrapper: Wrapper },
		);

		await act(async () => {
			await result.current.handleComposerSubmit({
				prompt: "trigger stream error",
				imagePaths: [],
				filePaths: [],
				customTags: [],
				model: MODEL,
				workingDirectory: "/tmp/helmor",
				effortLevel: "medium",
				permissionMode: "default",
				fastMode: false,
			});
		});

		act(() => {
			streamCallbacks[0]({
				kind: "error",
				message: "Reconnecting... 1/5",
				persisted: true,
				internal: false,
			});
		});

		expect(result.current.activeSendError).toBeNull();
		expect(result.current.restoreDraft).toBeNull();
		expect(result.current.isSending).toBe(false);
	});

	it("tracks the fast prelude per session until the fast turn completes", async () => {
		const streamCallbacks: Array<(event: unknown) => void> = [];
		apiMocks.startAgentMessageStream.mockImplementation(
			async (_payload: unknown, onEvent: (event: unknown) => void) => {
				streamCallbacks.push(onEvent);
			},
		);

		const { Wrapper } = createWrapper();
		const { result, rerender } = renderHook(
			({ composerContextKey, displayedSessionId }) =>
				useConversationStreaming({
					composerContextKey,
					displayedSelectedModelId: MODEL.id,
					displayedSessionId,
					displayedWorkspaceId: "workspace-1",
					selectionPending: false,
				}),
			{
				initialProps: {
					composerContextKey: "session:session-1",
					displayedSessionId: "session-1",
				},
				wrapper: Wrapper,
			},
		);

		await act(async () => {
			await result.current.handleComposerSubmit({
				prompt: "Ship it fast",
				imagePaths: [],
				filePaths: [],
				customTags: [],
				model: MODEL,
				workingDirectory: "/tmp/helmor",
				effortLevel: "medium",
				permissionMode: "default",
				fastMode: true,
			});
		});

		expect(result.current.activeFastPreludes["session:session-1"]).toBe(true);

		rerender({
			composerContextKey: "session:session-2",
			displayedSessionId: "session-2",
		});
		expect(result.current.activeFastPreludes["session:session-1"]).toBe(true);

		rerender({
			composerContextKey: "session:session-1",
			displayedSessionId: "session-1",
		});

		act(() => {
			streamCallbacks[0]({
				kind: "update",
				messages: [
					{
						role: "user",
						id: "user-1",
						content: [{ type: "text", text: "Ship it fast" }],
					},
				],
			});
		});

		expect(result.current.activeFastPreludes["session:session-1"]).toBe(true);

		act(() => {
			streamCallbacks[0]({
				kind: "streamingPartial",
				message: {
					role: "assistant",
					id: "assistant-1",
					content: [{ type: "text", text: "Working on it" }],
					streaming: true,
				},
			});
		});

		expect(result.current.activeFastPreludes["session:session-1"]).toBe(true);

		act(() => {
			streamCallbacks[0]({
				kind: "done",
				provider: "codex",
				modelId: MODEL.id,
				resolvedModel: MODEL.cliModel,
				sessionId: "provider-session-1",
				workingDirectory: "/tmp/helmor",
				persisted: false,
			});
		});

		expect(
			result.current.activeFastPreludes["session:session-1"],
		).toBeUndefined();
	});

	it("clears the fast prelude when a fast turn ends without assistant content", async () => {
		const streamCallbacks: Array<(event: unknown) => void> = [];
		apiMocks.startAgentMessageStream.mockImplementation(
			async (_payload: unknown, onEvent: (event: unknown) => void) => {
				streamCallbacks.push(onEvent);
			},
		);

		const { Wrapper } = createWrapper();
		const { result } = renderHook(
			() =>
				useConversationStreaming({
					composerContextKey: "session:session-1",
					displayedSelectedModelId: MODEL.id,
					displayedSessionId: "session-1",
					displayedWorkspaceId: "workspace-1",
					selectionPending: false,
				}),
			{ wrapper: Wrapper },
		);

		await act(async () => {
			await result.current.handleComposerSubmit({
				prompt: "Ship it fast",
				imagePaths: [],
				filePaths: [],
				customTags: [],
				model: MODEL,
				workingDirectory: "/tmp/helmor",
				effortLevel: "medium",
				permissionMode: "default",
				fastMode: true,
			});
		});

		expect(result.current.activeFastPreludes["session:session-1"]).toBe(true);

		act(() => {
			streamCallbacks[0]({
				kind: "done",
				provider: "codex",
				modelId: MODEL.id,
				resolvedModel: MODEL.cliModel,
				sessionId: "provider-session-1",
				workingDirectory: "/tmp/helmor",
				persisted: false,
			});
		});

		expect(
			result.current.activeFastPreludes["session:session-1"],
		).toBeUndefined();
	});

	it("responds to elicitation requests without using deferred tool flow", async () => {
		const { Wrapper } = createWrapper();
		const { result } = renderHook(
			() =>
				useConversationStreaming({
					composerContextKey: "session:session-1",
					displayedSelectedModelId: MODEL.id,
					displayedSessionId: "session-1",
					displayedWorkspaceId: "workspace-1",
					selectionPending: false,
				}),
			{ wrapper: Wrapper },
		);

		await act(async () => {
			await result.current.handleElicitationResponse(
				createPendingElicitation(),
				"accept",
				{ name: "Helmor" },
			);
		});

		expect(apiMocks.respondToElicitationRequest).toHaveBeenCalledWith(
			"elicitation-1",
			"accept",
			{ name: "Helmor" },
		);
		expect(result.current.pendingElicitation).toBeNull();
		expect(result.current.isSending).toBe(true);
	});
});
