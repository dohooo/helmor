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
import { WorkspaceToastProvider } from "@/lib/workspace-toast-context";
import { useConversationStreaming } from "./use-streaming";

const apiMocks = vi.hoisted(() => ({
	generateSessionTitle: vi.fn(),
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
		apiMocks.loadSessionThreadMessages.mockReset();
		apiMocks.renameSession.mockReset();
		apiMocks.respondToDeferredTool.mockReset();
		apiMocks.respondToPermissionRequest.mockReset();
		apiMocks.startAgentMessageStream.mockReset();
		apiMocks.steerAgentStream.mockReset();
		apiMocks.stopAgentStream.mockReset();

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
				contextTokenCount: 0,
				contextUsedPercent: null,
				thinkingEnabled: true,
				fastMode: false,
				agentPersonality: null,
				createdAt: "2026-04-17T00:00:00Z",
				updatedAt: "2026-04-17T00:00:00Z",
				lastUserMessageAt: null,
				resumeSessionAt: null,
				isHidden: false,
				isCompacting: false,
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
			sessionUnreadTotal: 0,
			unreadSessionCount: 0,
			derivedStatus: "in-progress",
			manualStatus: null,
			activeSessionId: "session-1",
			activeSessionTitle: "Untitled",
			activeSessionAgentType: "codex",
			activeSessionStatus: "idle",
			branch: "main",
			initializationParentBranch: "main",
			intendedTargetBranch: "main",
			notes: null,
			pinnedAt: null,
			prTitle: null,
			prDescription: null,
			archiveCommit: null,
			sessionCount: 1,
			messageCount: 0,
			attachmentCount: 0,
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
						sessionUnreadTotal: 0,
						unreadSessionCount: 0,
						derivedStatus: "in-progress",
						manualStatus: null,
						branch: "main",
						activeSessionId: "session-1",
						activeSessionTitle: "Untitled",
						activeSessionAgentType: "codex",
						activeSessionStatus: "idle",
						prTitle: null,
						sessionCount: 1,
						messageCount: 0,
						attachmentCount: 0,
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
