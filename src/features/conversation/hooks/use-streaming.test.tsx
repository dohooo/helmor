import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingDeferredTool } from "@/features/conversation/pending-deferred-tool";
import type { PendingElicitation } from "@/features/conversation/pending-elicitation";
import type {
	AgentModelOption,
	ThreadMessageLike,
	ToolCallPart,
} from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import { sessionThreadCacheKey } from "@/lib/session-thread-cache";
import type {
	QueuedSubmitContext,
	SubmitQueueApi,
} from "@/lib/use-submit-queue";
import { WorkspaceToastProvider } from "@/lib/workspace-toast-context";
import { useConversationStreaming } from "./use-streaming";

// Tests that don't exercise the queue branch can share this no-op
// stub — matches the shape of `SubmitQueueApi` without side effects.
const noopSubmitQueue: SubmitQueueApi = {
	getQueue: () => [],
	findById: () => undefined,
	enqueue: () => "",
	remove: () => {},
	popNext: () => undefined,
	clear: () => {},
};

const apiMocks = vi.hoisted(() => ({
	generateSessionTitle: vi.fn(),
	loadRepoPreferences: vi.fn(),
	loadSessionThreadMessages: vi.fn(),
	renameSession: vi.fn(),
	respondToDeferredTool: vi.fn(),
	respondToElicitationRequest: vi.fn(),
	respondToPermissionRequest: vi.fn(),
	startAgentMessageStream: vi.fn(),
	steerAgentStream: vi.fn(),
	stopAgentStream: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();

	return {
		...actual,
		generateSessionTitle: apiMocks.generateSessionTitle,
		loadRepoPreferences: apiMocks.loadRepoPreferences,
		loadSessionThreadMessages: apiMocks.loadSessionThreadMessages,
		renameSession: apiMocks.renameSession,
		respondToDeferredTool: apiMocks.respondToDeferredTool,
		respondToElicitationRequest: apiMocks.respondToElicitationRequest,
		respondToPermissionRequest: apiMocks.respondToPermissionRequest,
		startAgentMessageStream: apiMocks.startAgentMessageStream,
		steerAgentStream: apiMocks.steerAgentStream,
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

function toolCall(
	id: string,
	command: string,
	streamingStatus: ToolCallPart["streamingStatus"] = "running",
): ToolCallPart {
	return {
		type: "tool-call",
		toolCallId: id,
		toolName: "Bash",
		args: { command },
		argsText: JSON.stringify({ command }),
		streamingStatus,
	};
}

function assistantMessage(
	id: string,
	content: ThreadMessageLike["content"],
	streaming = true,
): ThreadMessageLike {
	return {
		id,
		role: "assistant",
		content,
		streaming,
	};
}

describe("useConversationStreaming", () => {
	beforeEach(() => {
		apiMocks.generateSessionTitle.mockReset();
		apiMocks.loadRepoPreferences.mockReset();
		apiMocks.loadSessionThreadMessages.mockReset();
		apiMocks.renameSession.mockReset();
		apiMocks.respondToDeferredTool.mockReset();
		apiMocks.respondToPermissionRequest.mockReset();
		apiMocks.startAgentMessageStream.mockReset();
		apiMocks.steerAgentStream.mockReset();
		apiMocks.stopAgentStream.mockReset();
		apiMocks.loadRepoPreferences.mockResolvedValue({});

		apiMocks.generateSessionTitle.mockResolvedValue(null);
		apiMocks.loadSessionThreadMessages.mockResolvedValue([]);
		apiMocks.renameSession.mockResolvedValue(undefined);
		apiMocks.respondToDeferredTool.mockResolvedValue(undefined);
		apiMocks.respondToElicitationRequest.mockResolvedValue(undefined);
		apiMocks.respondToPermissionRequest.mockResolvedValue(undefined);
		// Default: steer claims the turn ended so tests that don't opt in to
		// steer semantics fall through to the normal send path. Individual
		// tests override this when they want to exercise the steer branch.
		apiMocks.steerAgentStream.mockResolvedValue({ accepted: false });
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
					followUpBehavior: "steer",
					submitQueue: noopSubmitQueue,
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
					followUpBehavior: "steer",
					submitQueue: noopSubmitQueue,
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
					followUpBehavior: "steer",
					submitQueue: noopSubmitQueue,
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
					followUpBehavior: "steer",
					submitQueue: noopSubmitQueue,
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

	it("routes a second submit while sending to steerAgentStream, not startAgentMessageStream", async () => {
		// Stream mock returns without firing `done` → isSending stays true.
		apiMocks.startAgentMessageStream.mockImplementation(
			async (_payload: unknown, _onEvent: (event: unknown) => void) => {
				return undefined;
			},
		);
		apiMocks.steerAgentStream.mockResolvedValue({
			accepted: true,
			messageId: "steer-msg-1",
		});

		const { Wrapper } = createWrapper();
		const { result } = renderHook(
			() =>
				useConversationStreaming({
					composerContextKey: "session:session-1",
					displayedSelectedModelId: MODEL.id,
					displayedSessionId: "session-1",
					displayedWorkspaceId: "workspace-1",
					selectionPending: false,
					followUpBehavior: "steer",
					submitQueue: noopSubmitQueue,
				}),
			{ wrapper: Wrapper },
		);

		await act(async () => {
			await result.current.handleComposerSubmit({
				prompt: "kick things off",
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

		expect(result.current.isSending).toBe(true);
		apiMocks.startAgentMessageStream.mockClear();

		await act(async () => {
			await result.current.handleComposerSubmit({
				prompt: "focus on failing tests first",
				imagePaths: [],
				filePaths: ["src/foo.ts"],
				customTags: [],
				model: MODEL,
				workingDirectory: "/tmp/helmor",
				effortLevel: "medium",
				permissionMode: "default",
				fastMode: false,
			});
		});

		expect(apiMocks.steerAgentStream).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: "session-1",
				prompt: "focus on failing tests first",
				files: ["src/foo.ts"],
			}),
		);
		expect(apiMocks.startAgentMessageStream).not.toHaveBeenCalled();
	});

	it("sends the repo general preference via promptPrefix on the first prompt only", async () => {
		apiMocks.loadRepoPreferences.mockResolvedValue({
			general: "Always summarize the repo conventions first.",
		});
		apiMocks.startAgentMessageStream.mockImplementation(async () => {});

		const { Wrapper, queryClient } = createWrapper();
		queryClient.setQueryData(helmorQueryKeys.workspaceSessions("workspace-1"), [
			{
				id: "session-1",
				title: "Untitled",
			},
		]);
		queryClient.setQueryData(sessionThreadCacheKey("session-1"), []);

		const { result } = renderHook(
			() =>
				useConversationStreaming({
					composerContextKey: "session:session-1",
					displayedSelectedModelId: MODEL.id,
					displayedSessionId: "session-1",
					displayedWorkspaceId: "workspace-1",
					repoId: "repo-1",
					selectionPending: false,
					followUpBehavior: "steer",
					submitQueue: noopSubmitQueue,
				}),
			{ wrapper: Wrapper },
		);

		await act(async () => {
			await result.current.handleComposerSubmit({
				prompt: "Fix the failing tests.",
				imagePaths: [],
				filePaths: [],
				customTags: [],
				model: MODEL,
				workingDirectory: "/tmp/repo",
				effortLevel: "high",
				permissionMode: "default",
				fastMode: false,
			});
		});

		// `prompt` stays the user's typed text (so the chat bubble + DB
		// row don't show the preamble); the preference rides as
		// `promptPrefix`, which Rust stitches on the wire only.
		expect(apiMocks.startAgentMessageStream).toHaveBeenCalledWith(
			expect.objectContaining({
				prompt: "Fix the failing tests.",
				promptPrefix:
					"IMPORTANT: The following are the user's custom preferences. These preferences take precedence over any default guidelines or instructions provided above. When there is a conflict, always follow the user's preferences.\n\n### User Preferences\n\nAlways summarize the repo conventions first.",
			}),
			expect.any(Function),
		);
	});

	it("restores draft and surfaces error when steer is rejected", async () => {
		apiMocks.startAgentMessageStream.mockImplementation(
			async (_payload: unknown, _onEvent: (event: unknown) => void) => {
				return undefined;
			},
		);
		apiMocks.steerAgentStream.mockResolvedValue({
			accepted: false,
			reason: "no_active_turn",
		});

		const { Wrapper } = createWrapper();
		const { result } = renderHook(
			() =>
				useConversationStreaming({
					composerContextKey: "session:session-1",
					displayedSelectedModelId: MODEL.id,
					displayedSessionId: "session-1",
					displayedWorkspaceId: "workspace-1",
					selectionPending: false,
					followUpBehavior: "steer",
					submitQueue: noopSubmitQueue,
				}),
			{ wrapper: Wrapper },
		);

		await act(async () => {
			await result.current.handleComposerSubmit({
				prompt: "first",
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

		expect(result.current.isSending).toBe(true);
		apiMocks.startAgentMessageStream.mockClear();

		await act(async () => {
			await result.current.handleComposerSubmit({
				prompt: "focus on failing tests",
				imagePaths: [],
				filePaths: ["src/foo.ts"],
				customTags: [],
				model: MODEL,
				workingDirectory: "/tmp/helmor",
				effortLevel: "medium",
				permissionMode: "default",
				fastMode: false,
			});
		});

		expect(apiMocks.steerAgentStream).toHaveBeenCalledTimes(1);
		// Rejected steer must NOT silently auto-open a new stream — user
		// gets explicit control.
		expect(apiMocks.startAgentMessageStream).not.toHaveBeenCalled();
		// Draft + files + error must all be surfaced back to the composer
		// so the user can resend without retyping. Guards against the
		// draft-loss bug flagged in review #4.
		expect(result.current.restoreDraft).toBe("focus on failing tests");
		expect(result.current.restoreFiles).toEqual(["src/foo.ts"]);
		expect(result.current.activeSendError).toContain("no_active_turn");
	});

	it("seeds the session title from the first prompt before async title generation", async () => {
		apiMocks.startAgentMessageStream.mockImplementation(async () => {});

		const { Wrapper, queryClient } = createWrapper();
		queryClient.setQueryData(helmorQueryKeys.workspaceSessions("workspace-1"), [
			{
				id: "session-1",
				workspaceId: "workspace-1",
				title: "Untitled",
				agentType: "codex",
				status: "idle",
				model: "gpt-5.4",
				permissionMode: "default",
				providerSessionId: null,
				effortLevel: null,
				unreadCount: 0,
				fastMode: false,
				createdAt: "2026-04-17T00:00:00Z",
				updatedAt: "2026-04-17T00:00:00Z",
				lastUserMessageAt: null,
				isHidden: false,
				actionKind: null,
				active: true,
			},
		]);
		queryClient.setQueryData(helmorQueryKeys.workspaceDetail("workspace-1"), {
			id: "workspace-1",
			title: "Workspace 1",
			repoId: "repo-1",
			repoName: "helmor",
			repoIconSrc: null,
			repoInitials: "HE",
			remote: "origin",
			remoteUrl: null,
			defaultBranch: "main",
			rootPath: "/tmp/helmor",
			directoryName: "helmor",
			state: "ready",
			hasUnread: false,
			workspaceUnread: 0,
			unreadSessionCount: 0,
			status: "in-progress",
			activeSessionId: "session-1",
			activeSessionTitle: "Untitled",
			activeSessionAgentType: "codex",
			activeSessionStatus: "idle",
			branch: "main",
			initializationParentBranch: "main",
			intendedTargetBranch: "main",
			pinnedAt: null,
			prTitle: null,
			archiveCommit: null,
			sessionCount: 1,
			messageCount: 0,
		});
		queryClient.setQueryData(helmorQueryKeys.workspaceGroups, [
			{
				id: "progress",
				label: "In progress",
				tone: "progress",
				rows: [
					{
						id: "workspace-1",
						title: "Workspace 1",
						repoName: "helmor",
						repoInitials: "HE",
						state: "ready",
						hasUnread: false,
						workspaceUnread: 0,
						unreadSessionCount: 0,
						status: "in-progress",
						branch: "main",
						activeSessionId: "session-1",
						activeSessionTitle: "Untitled",
						activeSessionAgentType: "codex",
						activeSessionStatus: "idle",
						prTitle: null,
						sessionCount: 1,
						messageCount: 0,
					},
				],
			},
		]);

		const { result } = renderHook(
			() =>
				useConversationStreaming({
					composerContextKey: "session:session-1",
					displayedSelectedModelId: MODEL.id,
					displayedSessionId: "session-1",
					displayedWorkspaceId: "workspace-1",
					selectionPending: false,
					followUpBehavior: "steer",
					submitQueue: noopSubmitQueue,
				}),
			{ wrapper: Wrapper },
		);

		await act(async () => {
			await result.current.handleComposerSubmit({
				prompt: "Investigate reconnect failures after restarting the session",
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

		expect(apiMocks.renameSession).toHaveBeenCalledWith(
			"session-1",
			"Investigate reconnect failures af...",
		);
		expect(apiMocks.generateSessionTitle).toHaveBeenCalledWith(
			"session-1",
			"Investigate reconnect failures after restarting the session",
			"Investigate reconnect failures af...",
		);
		expect(
			queryClient.getQueryData<Array<{ title: string }>>(
				helmorQueryKeys.workspaceSessions("workspace-1"),
			)?.[0]?.title,
		).toBe("Investigate reconnect failures af...");
		expect(
			queryClient.getQueryData<
				Array<{ rows: Array<{ activeSessionTitle: string }> }>
			>(helmorQueryKeys.workspaceGroups)?.[0]?.rows[0]?.activeSessionTitle,
		).toBe("Investigate reconnect failures af...");
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
					followUpBehavior: "steer",
					submitQueue: noopSubmitQueue,
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

	it("writes the second read-only codex command into cache as a collapsed tail immediately", async () => {
		const streamCallbacks: Array<(event: unknown) => void> = [];
		const rafCallbacks: FrameRequestCallback[] = [];
		const rafSpy = vi
			.spyOn(window, "requestAnimationFrame")
			.mockImplementation((callback: FrameRequestCallback) => {
				rafCallbacks.push(callback);
				return rafCallbacks.length;
			});
		const cancelSpy = vi
			.spyOn(window, "cancelAnimationFrame")
			.mockImplementation(() => {});
		const flushRaf = () => {
			const callback = rafCallbacks.shift();
			if (callback) {
				callback(0);
			}
		};

		apiMocks.startAgentMessageStream.mockImplementation(
			async (_payload: unknown, onEvent: (event: unknown) => void) => {
				streamCallbacks.push(onEvent);
			},
		);

		const { Wrapper, queryClient } = createWrapper();
		const { result } = renderHook(
			() =>
				useConversationStreaming({
					composerContextKey: "session:session-1",
					displayedSelectedModelId: MODEL.id,
					displayedSessionId: "session-1",
					displayedWorkspaceId: "workspace-1",
					selectionPending: false,
					followUpBehavior: "steer",
					submitQueue: noopSubmitQueue,
				}),
			{ wrapper: Wrapper },
		);

		await act(async () => {
			await result.current.handleComposerSubmit({
				prompt: "inspect files",
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

		const first = assistantMessage(
			"a1",
			[toolCall("cmd1", "cat src/App.tsx")],
			true,
		);
		const second = assistantMessage(
			"a2",
			[toolCall("cmd2", "sed -n '1,40p' src/lib/api.ts")],
			true,
		);

		act(() => {
			streamCallbacks[0]?.({
				kind: "update",
				messages: [first],
			});
		});
		act(() => {
			flushRaf();
		});

		// Tick 1 is the expected non-collapsed state: the first command
		// should still render by itself.
		const firstTick = queryClient.getQueryData<ThreadMessageLike[]>(
			sessionThreadCacheKey("session-1"),
		);
		expect(firstTick).toHaveLength(2);
		expect(firstTick?.[1]?.content[0]?.type).toBe("tool-call");

		act(() => {
			streamCallbacks[0]?.({
				kind: "streamingPartial",
				message: second,
			});
		});
		act(() => {
			flushRaf();
		});

		const cached = queryClient.getQueryData<ThreadMessageLike[]>(
			sessionThreadCacheKey("session-1"),
		);
		expect(cached).toHaveLength(2);
		const assistant = cached?.[1];
		expect(assistant?.role).toBe("assistant");
		expect(assistant?.content).toHaveLength(1);
		const [part] = assistant?.content ?? [];
		expect(part?.type).toBe("collapsed-group");
		if (part?.type !== "collapsed-group") {
			throw new Error("expected collapsed-group");
		}
		expect(part.tools).toHaveLength(2);
		expect(part.summary).toBe("Running 2 read-only commands...");

		rafSpy.mockRestore();
		cancelSpy.mockRestore();
	});

	it("surfaces a non-persisted, non-internal stream error to the composer", async () => {
		// Locks the contract that drives the StreamingMachine refactor:
		// `error` event with persisted=false, internal=false must surface
		// the message in `activeSendError` AND restore the draft so the
		// user can retry without re-typing.
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
					followUpBehavior: "steer",
					submitQueue: noopSubmitQueue,
				}),
			{ wrapper: Wrapper },
		);

		await act(async () => {
			await result.current.handleComposerSubmit({
				prompt: "first attempt",
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
				message: "Network unreachable",
				persisted: false,
				internal: false,
			});
		});

		expect(result.current.activeSendError).toBe("Network unreachable");
		expect(result.current.restoreDraft).toBe("first attempt");
		expect(result.current.isSending).toBe(false);
	});

	it("hides the message of an internal sidecar error from the composer", async () => {
		// `internal: true` indicates a sidecar bug — the underlying
		// message would just confuse the user, so we drop it. The hook
		// instead pops a generic toast (covered by the toast spy).
		const streamCallbacks: Array<(event: unknown) => void> = [];
		apiMocks.startAgentMessageStream.mockImplementation(
			async (_payload: unknown, onEvent: (event: unknown) => void) => {
				streamCallbacks.push(onEvent);
			},
		);

		const { Wrapper, pushToast } = createWrapper();
		const { result } = renderHook(
			() =>
				useConversationStreaming({
					composerContextKey: "session:session-1",
					displayedSelectedModelId: MODEL.id,
					displayedSessionId: "session-1",
					displayedWorkspaceId: "workspace-1",
					selectionPending: false,
					followUpBehavior: "steer",
					submitQueue: noopSubmitQueue,
				}),
			{ wrapper: Wrapper },
		);

		await act(async () => {
			await result.current.handleComposerSubmit({
				prompt: "trigger internal",
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
				message: "panic: borrow_mut on poisoned mutex",
				persisted: false,
				internal: true,
			});
		});

		expect(result.current.activeSendError).toBeNull();
		expect(result.current.isSending).toBe(false);
		expect(pushToast).toHaveBeenCalledWith(
			"Something went wrong. Please try again.",
			"Error",
			"destructive",
		);
	});

	it("handleStopStream is a no-op when no stream is active", async () => {
		// Defensive case: stop button is wired even when isSending is
		// false (race window between done event and UI update). Calling
		// it must not crash and must not invoke stopAgentStream.
		const { Wrapper } = createWrapper();
		const { result } = renderHook(
			() =>
				useConversationStreaming({
					composerContextKey: "session:session-1",
					displayedSelectedModelId: MODEL.id,
					displayedSessionId: "session-1",
					displayedWorkspaceId: "workspace-1",
					selectionPending: false,
					followUpBehavior: "steer",
					submitQueue: noopSubmitQueue,
				}),
			{ wrapper: Wrapper },
		);

		expect(result.current.isSending).toBe(false);
		act(() => {
			result.current.handleStopStream();
		});
		expect(apiMocks.stopAgentStream).not.toHaveBeenCalled();
	});

	it("allows a fresh submit after a non-persisted stream error", async () => {
		// The state machine refactor must preserve this: an error event
		// fully clears sending state so the next submit starts a clean
		// turn. If sendingContextKeys still had the key, the second
		// submit would route to steer instead of startAgentMessageStream.
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
					followUpBehavior: "steer",
					submitQueue: noopSubmitQueue,
				}),
			{ wrapper: Wrapper },
		);

		// First attempt — fails with a non-persisted error.
		await act(async () => {
			await result.current.handleComposerSubmit({
				prompt: "first try",
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
				message: "transient error",
				persisted: false,
				internal: false,
			});
		});

		expect(result.current.isSending).toBe(false);
		expect(apiMocks.startAgentMessageStream).toHaveBeenCalledTimes(1);
		expect(apiMocks.steerAgentStream).not.toHaveBeenCalled();

		// Second attempt — must hit the fresh-turn path, not steer.
		await act(async () => {
			await result.current.handleComposerSubmit({
				prompt: "retry",
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

		expect(apiMocks.startAgentMessageStream).toHaveBeenCalledTimes(2);
		expect(apiMocks.steerAgentStream).not.toHaveBeenCalled();
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
					followUpBehavior: "steer",
					submitQueue: noopSubmitQueue,
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
					followUpBehavior: "steer",
					submitQueue: noopSubmitQueue,
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
					followUpBehavior: "steer",
					submitQueue: noopSubmitQueue,
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
					followUpBehavior: "steer",
					submitQueue: noopSubmitQueue,
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

	describe("follow-up queue", () => {
		// Minimal in-memory queue that mirrors `useSubmitQueue` for tests.
		// The real hook keeps state in React; here we just need a stable
		// api whose mutations are observable synchronously.
		function createFakeQueue(): SubmitQueueApi & {
			snapshot: () => Map<
				string,
				Array<{ id: string; prompt: string; context: QueuedSubmitContext }>
			>;
		} {
			const store = new Map<
				string,
				Array<{
					id: string;
					context: QueuedSubmitContext;
					payload: Parameters<SubmitQueueApi["enqueue"]>[1];
				}>
			>();
			let counter = 0;
			return {
				getQueue: (sessionId) =>
					store.get(sessionId)?.map((e) => ({
						id: e.id,
						context: e.context,
						payload: e.payload,
						enqueuedAt: 0,
					})) ?? [],
				findById: (id) => {
					for (const list of store.values()) {
						const match = list.find((e) => e.id === id);
						if (match) {
							return {
								id: match.id,
								context: match.context,
								payload: match.payload,
								enqueuedAt: 0,
							};
						}
					}
					return undefined;
				},
				enqueue: (context, payload) => {
					counter += 1;
					const id = `q-${counter}`;
					const list = store.get(context.sessionId) ?? [];
					list.push({ id, context, payload });
					store.set(context.sessionId, list);
					return id;
				},
				remove: (sessionId, id) => {
					const list = store.get(sessionId);
					if (!list) return;
					const filtered = list.filter((e) => e.id !== id);
					if (filtered.length === 0) store.delete(sessionId);
					else store.set(sessionId, filtered);
				},
				popNext: (sessionId) => {
					const list = store.get(sessionId);
					if (!list || list.length === 0) return undefined;
					const [head, ...rest] = list;
					if (rest.length === 0) store.delete(sessionId);
					else store.set(sessionId, rest);
					return {
						id: head.id,
						context: head.context,
						payload: head.payload,
						enqueuedAt: 0,
					};
				},
				clear: (sessionId) => {
					store.delete(sessionId);
				},
				snapshot: () => {
					const out = new Map<
						string,
						Array<{ id: string; prompt: string; context: QueuedSubmitContext }>
					>();
					for (const [sid, list] of store) {
						out.set(
							sid,
							list.map((e) => ({
								id: e.id,
								prompt: e.payload.prompt,
								context: e.context,
							})),
						);
					}
					return out;
				},
			};
		}

		it("queues follow-up submits instead of steering when behavior is 'queue'", async () => {
			const streamCallbacks: Array<(event: unknown) => void> = [];
			apiMocks.startAgentMessageStream.mockImplementation(
				async (_payload: unknown, onEvent: (event: unknown) => void) => {
					streamCallbacks.push(onEvent);
				},
			);
			const queue = createFakeQueue();

			const { Wrapper } = createWrapper();
			const { result } = renderHook(
				() =>
					useConversationStreaming({
						composerContextKey: "session:session-1",
						displayedSelectedModelId: MODEL.id,
						displayedSessionId: "session-1",
						displayedWorkspaceId: "workspace-1",
						selectionPending: false,
						followUpBehavior: "queue",
						submitQueue: queue,
					}),
				{ wrapper: Wrapper },
			);

			// Start a real turn first — this establishes the activeSession
			// and sending state that the queue branch checks for.
			await act(async () => {
				await result.current.handleComposerSubmit({
					prompt: "First",
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
			expect(result.current.isSending).toBe(true);

			// Follow-up while the turn is active — should enqueue, not steer.
			await act(async () => {
				await result.current.handleComposerSubmit({
					prompt: "Follow up",
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
			expect(apiMocks.steerAgentStream).not.toHaveBeenCalled();
			const enqueued = queue.snapshot().get("session-1");
			expect(enqueued).toHaveLength(1);
			expect(enqueued?.[0]).toMatchObject({
				id: "q-1",
				prompt: "Follow up",
				context: {
					sessionId: "session-1",
					workspaceId: "workspace-1",
					contextKey: "session:session-1",
				},
			});
		});

		it("drains the queue when the active turn finishes", async () => {
			const streamCallbacks: Array<(event: unknown) => void> = [];
			apiMocks.startAgentMessageStream.mockImplementation(
				async (_payload: unknown, onEvent: (event: unknown) => void) => {
					streamCallbacks.push(onEvent);
				},
			);
			const queue = createFakeQueue();

			const { Wrapper } = createWrapper();
			const { result } = renderHook(
				() =>
					useConversationStreaming({
						composerContextKey: "session:session-1",
						displayedSelectedModelId: MODEL.id,
						displayedSessionId: "session-1",
						displayedWorkspaceId: "workspace-1",
						selectionPending: false,
						followUpBehavior: "queue",
						submitQueue: queue,
					}),
				{ wrapper: Wrapper },
			);

			// Kick off the primary turn.
			await act(async () => {
				await result.current.handleComposerSubmit({
					prompt: "Primary",
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

			// Enqueue a follow-up.
			await act(async () => {
				await result.current.handleComposerSubmit({
					prompt: "Queued",
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
			expect(queue.snapshot().get("session-1")).toHaveLength(1);

			// Finish the first turn — drain effect should pop + replay.
			await act(async () => {
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
			// Drain is scheduled via `queueMicrotask`; let it run.
			await act(async () => {
				await Promise.resolve();
			});

			expect(queue.snapshot().has("session-1")).toBe(false);
			// Second `startAgentMessageStream` call carries the queued prompt.
			expect(apiMocks.startAgentMessageStream).toHaveBeenCalledTimes(2);
			const secondCallPayload = apiMocks.startAgentMessageStream.mock
				.calls[1][0] as { prompt: string };
			expect(secondCallPayload.prompt).toBe("Queued");
		});

		it("handleRemoveQueued removes an item without firing any API", async () => {
			const queue = createFakeQueue();
			queue.enqueue(
				{
					sessionId: "session-1",
					workspaceId: "workspace-1",
					contextKey: "session:session-1",
				},
				{
					prompt: "drop me",
					imagePaths: [],
					filePaths: [],
					customTags: [],
					model: MODEL,
					workingDirectory: "/tmp/helmor",
					effortLevel: "medium",
					permissionMode: "default",
					fastMode: false,
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
						followUpBehavior: "queue",
						submitQueue: queue,
					}),
				{ wrapper: Wrapper },
			);

			act(() => {
				result.current.handleRemoveQueued("q-1");
			});
			expect(queue.snapshot().has("session-1")).toBe(false);
			expect(apiMocks.steerAgentStream).not.toHaveBeenCalled();
			expect(apiMocks.startAgentMessageStream).not.toHaveBeenCalled();
		});

		it("handleSteerQueued converts a queued item to a steer", async () => {
			const streamCallbacks: Array<(event: unknown) => void> = [];
			apiMocks.startAgentMessageStream.mockImplementation(
				async (_payload: unknown, onEvent: (event: unknown) => void) => {
					streamCallbacks.push(onEvent);
				},
			);
			apiMocks.steerAgentStream.mockResolvedValue({ accepted: true });

			const queue = createFakeQueue();
			const { Wrapper } = createWrapper();
			const { result } = renderHook(
				() =>
					useConversationStreaming({
						composerContextKey: "session:session-1",
						displayedSelectedModelId: MODEL.id,
						displayedSessionId: "session-1",
						displayedWorkspaceId: "workspace-1",
						selectionPending: false,
						followUpBehavior: "queue",
						submitQueue: queue,
					}),
				{ wrapper: Wrapper },
			);

			// Kick off a turn so an activeSession exists for steer to target.
			await act(async () => {
				await result.current.handleComposerSubmit({
					prompt: "Primary",
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

			// Queue a follow-up.
			await act(async () => {
				await result.current.handleComposerSubmit({
					prompt: "Actually, go faster",
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

			// Trigger steer on the queued item.
			await act(async () => {
				await result.current.handleSteerQueued("q-1");
			});

			expect(queue.snapshot().has("session-1")).toBe(false);
			expect(apiMocks.steerAgentStream).toHaveBeenCalledWith(
				expect.objectContaining({ prompt: "Actually, go faster" }),
			);
		});

		it("drains against the queued session even after the user navigates away", async () => {
			const streamCallbacks: Array<(event: unknown) => void> = [];
			apiMocks.startAgentMessageStream.mockImplementation(
				async (_payload: unknown, onEvent: (event: unknown) => void) => {
					streamCallbacks.push(onEvent);
				},
			);
			const queue = createFakeQueue();

			const { Wrapper } = createWrapper();
			// Start displayed on session A.
			const { result, rerender } = renderHook(
				({ sessionId, workspaceId, contextKey }) =>
					useConversationStreaming({
						composerContextKey: contextKey,
						displayedSelectedModelId: MODEL.id,
						displayedSessionId: sessionId,
						displayedWorkspaceId: workspaceId,
						selectionPending: false,
						followUpBehavior: "queue",
						submitQueue: queue,
					}),
				{
					initialProps: {
						sessionId: "session-A",
						workspaceId: "workspace-1",
						contextKey: "session:session-A",
					},
					wrapper: Wrapper,
				},
			);

			// Kick off a turn in session A.
			await act(async () => {
				await result.current.handleComposerSubmit({
					prompt: "A primary",
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
			// Queue a follow-up in session A.
			await act(async () => {
				await result.current.handleComposerSubmit({
					prompt: "A follow-up",
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
			expect(queue.snapshot().get("session-A")).toHaveLength(1);

			// User navigates to session B BEFORE A's turn finishes.
			rerender({
				sessionId: "session-B",
				workspaceId: "workspace-1",
				contextKey: "session:session-B",
			});

			// A's turn finishes → drain fires.
			await act(async () => {
				streamCallbacks[0]({
					kind: "done",
					provider: "codex",
					modelId: MODEL.id,
					resolvedModel: MODEL.cliModel,
					sessionId: "provider-session-A",
					workingDirectory: "/tmp/helmor",
					persisted: false,
				});
			});
			await act(async () => {
				await Promise.resolve();
			});

			// Queue for A is empty, queue for B untouched.
			expect(queue.snapshot().has("session-A")).toBe(false);
			expect(queue.snapshot().has("session-B")).toBe(false);
			// The drained submit targeted session A (NOT B, which is
			// currently displayed) — verified via the helmorSessionId
			// passed to the second `startAgentMessageStream` call.
			expect(apiMocks.startAgentMessageStream).toHaveBeenCalledTimes(2);
			const drainedPayload = apiMocks.startAgentMessageStream.mock
				.calls[1][0] as { prompt: string; helmorSessionId: string };
			expect(drainedPayload.prompt).toBe("A follow-up");
			expect(drainedPayload.helmorSessionId).toBe("session-A");
		});

		it("forceQueue bypasses followUpBehavior='steer' and always queues", async () => {
			apiMocks.startAgentMessageStream.mockImplementation(
				async (_payload: unknown, _onEvent: (event: unknown) => void) => {
					// Leave the turn streaming — don't emit 'done'.
				},
			);
			apiMocks.steerAgentStream.mockResolvedValue({ accepted: true });
			const queue = createFakeQueue();

			const { Wrapper } = createWrapper();
			const { result } = renderHook(
				() =>
					useConversationStreaming({
						composerContextKey: "session:session-1",
						displayedSelectedModelId: MODEL.id,
						displayedSessionId: "session-1",
						displayedWorkspaceId: "workspace-1",
						selectionPending: false,
						// User has `steer` configured — normally the next
						// submit would steer. `forceQueue: true` must override.
						followUpBehavior: "steer",
						submitQueue: queue,
					}),
				{ wrapper: Wrapper },
			);

			// Kick off a turn.
			await act(async () => {
				await result.current.handleComposerSubmit({
					prompt: "Primary",
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
			expect(result.current.isSending).toBe(true);

			// Host-triggered submit with forceQueue=true while streaming.
			await act(async () => {
				await result.current.handleComposerSubmit({
					prompt: "Resolve conflict",
					imagePaths: [],
					filePaths: [],
					customTags: [],
					model: MODEL,
					workingDirectory: "/tmp/helmor",
					effortLevel: "medium",
					permissionMode: "default",
					fastMode: false,
					forceQueue: true,
				});
			});

			// Must have queued — not steered.
			expect(apiMocks.steerAgentStream).not.toHaveBeenCalled();
			const enqueued = queue.snapshot().get("session-1");
			expect(enqueued).toHaveLength(1);
			expect(enqueued?.[0]?.prompt).toBe("Resolve conflict");
		});

		it("followUpBehaviorOverride='queue' flips a 'steer' default into the queue for one submit", async () => {
			apiMocks.startAgentMessageStream.mockImplementation(
				async (_payload: unknown, _onEvent: (event: unknown) => void) => {
					// Leave the turn streaming.
				},
			);
			apiMocks.steerAgentStream.mockResolvedValue({ accepted: true });
			const queue = createFakeQueue();

			const { Wrapper } = createWrapper();
			const { result } = renderHook(
				() =>
					useConversationStreaming({
						composerContextKey: "session:session-1",
						displayedSelectedModelId: MODEL.id,
						displayedSessionId: "session-1",
						displayedWorkspaceId: "workspace-1",
						selectionPending: false,
						// Default is steer — without the override the next
						// submit would steer mid-turn.
						followUpBehavior: "steer",
						submitQueue: queue,
					}),
				{ wrapper: Wrapper },
			);

			await act(async () => {
				await result.current.handleComposerSubmit({
					prompt: "Primary",
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
			expect(result.current.isSending).toBe(true);

			await act(async () => {
				await result.current.handleComposerSubmit({
					prompt: "One-shot queue",
					imagePaths: [],
					filePaths: [],
					customTags: [],
					model: MODEL,
					workingDirectory: "/tmp/helmor",
					effortLevel: "medium",
					permissionMode: "default",
					fastMode: false,
					followUpBehaviorOverride: "queue",
				});
			});

			expect(apiMocks.steerAgentStream).not.toHaveBeenCalled();
			const enqueued = queue.snapshot().get("session-1");
			expect(enqueued).toHaveLength(1);
			expect(enqueued?.[0]?.prompt).toBe("One-shot queue");
		});

		it("followUpBehaviorOverride='steer' flips a 'queue' default into a mid-turn steer", async () => {
			apiMocks.startAgentMessageStream.mockImplementation(
				async (_payload: unknown, _onEvent: (event: unknown) => void) => {
					// Leave the turn streaming.
				},
			);
			apiMocks.steerAgentStream.mockResolvedValue({ accepted: true });
			const queue = createFakeQueue();

			const { Wrapper } = createWrapper();
			const { result } = renderHook(
				() =>
					useConversationStreaming({
						composerContextKey: "session:session-1",
						displayedSelectedModelId: MODEL.id,
						displayedSessionId: "session-1",
						displayedWorkspaceId: "workspace-1",
						selectionPending: false,
						followUpBehavior: "queue",
						submitQueue: queue,
					}),
				{ wrapper: Wrapper },
			);

			await act(async () => {
				await result.current.handleComposerSubmit({
					prompt: "Primary",
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
			expect(result.current.isSending).toBe(true);

			await act(async () => {
				await result.current.handleComposerSubmit({
					prompt: "One-shot steer",
					imagePaths: [],
					filePaths: [],
					customTags: [],
					model: MODEL,
					workingDirectory: "/tmp/helmor",
					effortLevel: "medium",
					permissionMode: "default",
					fastMode: false,
					followUpBehaviorOverride: "steer",
				});
			});

			expect(apiMocks.steerAgentStream).toHaveBeenCalledTimes(1);
			expect(queue.snapshot().get("session-1") ?? []).toHaveLength(0);
		});

		it("forceQueue takes precedence over followUpBehaviorOverride='steer'", async () => {
			apiMocks.startAgentMessageStream.mockImplementation(
				async (_payload: unknown, _onEvent: (event: unknown) => void) => {},
			);
			apiMocks.steerAgentStream.mockResolvedValue({ accepted: true });
			const queue = createFakeQueue();

			const { Wrapper } = createWrapper();
			const { result } = renderHook(
				() =>
					useConversationStreaming({
						composerContextKey: "session:session-1",
						displayedSelectedModelId: MODEL.id,
						displayedSessionId: "session-1",
						displayedWorkspaceId: "workspace-1",
						selectionPending: false,
						followUpBehavior: "queue",
						submitQueue: queue,
					}),
				{ wrapper: Wrapper },
			);

			await act(async () => {
				await result.current.handleComposerSubmit({
					prompt: "Primary",
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
			expect(result.current.isSending).toBe(true);

			await act(async () => {
				await result.current.handleComposerSubmit({
					prompt: "Resolve conflict",
					imagePaths: [],
					filePaths: [],
					customTags: [],
					model: MODEL,
					workingDirectory: "/tmp/helmor",
					effortLevel: "medium",
					permissionMode: "default",
					fastMode: false,
					forceQueue: true,
					followUpBehaviorOverride: "steer",
				});
			});

			expect(apiMocks.steerAgentStream).not.toHaveBeenCalled();
			const enqueued = queue.snapshot().get("session-1");
			expect(enqueued).toHaveLength(1);
			expect(enqueued?.[0]?.prompt).toBe("Resolve conflict");
		});

		it("handleSteerQueued re-enqueues the item when provider rejects the steer", async () => {
			apiMocks.startAgentMessageStream.mockImplementation(
				async (_payload: unknown, _onEvent: (event: unknown) => void) => {
					// Leave turn streaming.
				},
			);
			// Provider says "too late" — the turn already ended between
			// click and RPC. Without the re-enqueue, the queued prompt
			// is silently lost.
			apiMocks.steerAgentStream.mockResolvedValue({
				accepted: false,
				reason: "turn already completed",
			});
			const queue = createFakeQueue();

			const { Wrapper } = createWrapper();
			const { result } = renderHook(
				() =>
					useConversationStreaming({
						composerContextKey: "session:session-1",
						displayedSelectedModelId: MODEL.id,
						displayedSessionId: "session-1",
						displayedWorkspaceId: "workspace-1",
						selectionPending: false,
						followUpBehavior: "queue",
						submitQueue: queue,
					}),
				{ wrapper: Wrapper },
			);

			// Kick off a turn + queue a follow-up.
			await act(async () => {
				await result.current.handleComposerSubmit({
					prompt: "Primary",
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
			await act(async () => {
				await result.current.handleComposerSubmit({
					prompt: "Follow-up",
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
			expect(queue.snapshot().get("session-1")).toHaveLength(1);

			// Steer attempt — provider rejects.
			await act(async () => {
				await result.current.handleSteerQueued("q-1");
			});

			// The item must have been put back in the queue (new id OK,
			// same prompt). The user's prompt is NOT lost.
			const after = queue.snapshot().get("session-1");
			expect(after).toHaveLength(1);
			expect(after?.[0]?.prompt).toBe("Follow-up");
			// Error surfaces in the send-error bag so UI can toast / show it.
			expect(result.current.activeSendError).toMatch(/Steer rejected/);
		});

		it("handleSteerQueued falls back to a fresh turn when the stream has already ended", async () => {
			apiMocks.startAgentMessageStream.mockImplementation(
				async (_payload: unknown, _onEvent: (event: unknown) => void) => {
					// Leave streaming.
				},
			);
			const queue = createFakeQueue();

			const { Wrapper } = createWrapper();
			const { result } = renderHook(
				() =>
					useConversationStreaming({
						composerContextKey: "session:session-1",
						displayedSelectedModelId: MODEL.id,
						displayedSessionId: "session-1",
						displayedWorkspaceId: "workspace-1",
						selectionPending: false,
						followUpBehavior: "queue",
						submitQueue: queue,
					}),
				{ wrapper: Wrapper },
			);

			// Manually seed the queue without an active stream — the
			// "user clicked Steer just after turn ended" race.
			act(() => {
				queue.enqueue(
					{
						sessionId: "session-1",
						workspaceId: "workspace-1",
						contextKey: "session:session-1",
					},
					{
						prompt: "Orphan",
						imagePaths: [],
						filePaths: [],
						customTags: [],
						model: MODEL,
						workingDirectory: "/tmp/helmor",
						effortLevel: "medium",
						permissionMode: "default",
						fastMode: false,
					},
				);
			});

			await act(async () => {
				await result.current.handleSteerQueued("q-1");
			});

			// Should have started a fresh turn with the payload instead
			// of dropping it silently. The prompt may be wrapped in a
			// repo-preferences prelude for the first user message, so
			// just check the Orphan string appears in it.
			expect(apiMocks.steerAgentStream).not.toHaveBeenCalled();
			expect(apiMocks.startAgentMessageStream).toHaveBeenCalledTimes(1);
			const firstCall = apiMocks.startAgentMessageStream.mock.calls[0][0] as {
				prompt: string;
				helmorSessionId: string;
			};
			expect(firstCall.prompt).toContain("Orphan");
			expect(firstCall.helmorSessionId).toBe("session-1");
			expect(queue.snapshot().has("session-1")).toBe(false);
		});

		it("drains queued items one-per-turn across chained turns", async () => {
			const streamCallbacks: Array<(event: unknown) => void> = [];
			apiMocks.startAgentMessageStream.mockImplementation(
				async (_payload: unknown, onEvent: (event: unknown) => void) => {
					streamCallbacks.push(onEvent);
				},
			);
			const queue = createFakeQueue();

			const { Wrapper } = createWrapper();
			const { result } = renderHook(
				() =>
					useConversationStreaming({
						composerContextKey: "session:session-1",
						displayedSelectedModelId: MODEL.id,
						displayedSessionId: "session-1",
						displayedWorkspaceId: "workspace-1",
						selectionPending: false,
						followUpBehavior: "queue",
						submitQueue: queue,
					}),
				{ wrapper: Wrapper },
			);

			// Start primary.
			await act(async () => {
				await result.current.handleComposerSubmit({
					prompt: "Primary",
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
			// Queue two follow-ups.
			for (const prompt of ["One", "Two"]) {
				await act(async () => {
					await result.current.handleComposerSubmit({
						prompt,
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
			}
			expect(queue.snapshot().get("session-1")).toHaveLength(2);

			// Finish primary → drain pops "One".
			await act(async () => {
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
			await act(async () => {
				await Promise.resolve();
			});
			expect(apiMocks.startAgentMessageStream).toHaveBeenCalledTimes(2);
			expect(queue.snapshot().get("session-1")).toHaveLength(1);

			// Finish second → drain pops "Two".
			await act(async () => {
				streamCallbacks[1]({
					kind: "done",
					provider: "codex",
					modelId: MODEL.id,
					resolvedModel: MODEL.cliModel,
					sessionId: "provider-session-1",
					workingDirectory: "/tmp/helmor",
					persisted: false,
				});
			});
			await act(async () => {
				await Promise.resolve();
			});
			expect(apiMocks.startAgentMessageStream).toHaveBeenCalledTimes(3);
			expect(queue.snapshot().has("session-1")).toBe(false);
			const thirdPayload = apiMocks.startAgentMessageStream.mock
				.calls[2][0] as { prompt: string };
			expect(thirdPayload.prompt).toBe("Two");
		});

		it("drains queued items when the prior turn errors instead of done", async () => {
			const streamCallbacks: Array<(event: unknown) => void> = [];
			apiMocks.startAgentMessageStream.mockImplementation(
				async (_payload: unknown, onEvent: (event: unknown) => void) => {
					streamCallbacks.push(onEvent);
				},
			);
			const queue = createFakeQueue();

			const { Wrapper } = createWrapper();
			const { result } = renderHook(
				() =>
					useConversationStreaming({
						composerContextKey: "session:session-1",
						displayedSelectedModelId: MODEL.id,
						displayedSessionId: "session-1",
						displayedWorkspaceId: "workspace-1",
						selectionPending: false,
						followUpBehavior: "queue",
						submitQueue: queue,
					}),
				{ wrapper: Wrapper },
			);

			await act(async () => {
				await result.current.handleComposerSubmit({
					prompt: "Primary",
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
			await act(async () => {
				await result.current.handleComposerSubmit({
					prompt: "Queued after error",
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

			await act(async () => {
				streamCallbacks[0]({
					kind: "error",
					provider: "codex",
					modelId: MODEL.id,
					message: "boom",
					persisted: true,
					internal: false,
				});
			});
			await act(async () => {
				await Promise.resolve();
			});

			// error-path also drains — queued prompt doesn't get stuck.
			expect(apiMocks.startAgentMessageStream).toHaveBeenCalledTimes(2);
			expect(queue.snapshot().has("session-1")).toBe(false);
		});
	});
});
