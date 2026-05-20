import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	AgentReattachRequest,
	AgentReattachResponse,
	AgentStreamEvent,
	RemoteAgentSession,
} from "@/lib/api";
import { sessionThreadCacheKey } from "@/lib/session-thread-cache";

const apiMocks = vi.hoisted(() => ({
	listRemoteAgentSessions: vi.fn(),
	startAgentReattachStream: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();
	return {
		...actual,
		listRemoteAgentSessions: apiMocks.listRemoteAgentSessions,
		startAgentReattachStream: apiMocks.startAgentReattachStream,
	};
});

import { useWorkspaceRemoteReattach } from "./use-workspace-remote-reattach";

function withQueryClient(): {
	wrapper: ({ children }: { children: ReactNode }) => ReactElement;
	queryClient: QueryClient;
} {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false, gcTime: 0, staleTime: 0 },
		},
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);
	return { wrapper, queryClient };
}

const SESSION_ID = "hs-1";
const REQUEST_ID = "rid-live-1";
const RUNTIME = "dev.box";

const LIVE_SESSION: RemoteAgentSession = {
	requestId: REQUEST_ID,
	helmorSessionId: SESSION_ID,
	provider: "claude",
	workspaceDir: "/srv/demo",
	startedAtMs: Date.now() - 5_000,
	lastEventMs: Date.now() - 100,
};

describe("useWorkspaceRemoteReattach", () => {
	beforeEach(() => {
		apiMocks.listRemoteAgentSessions.mockReset();
		apiMocks.startAgentReattachStream.mockReset();
		apiMocks.startAgentReattachStream.mockResolvedValue({
			accepted: true,
			lastSeq: 0,
			replayedCount: 0,
			replayGap: null,
		} satisfies AgentReattachResponse);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns idle when runtimeName is null (local workspace)", () => {
		const { wrapper } = withQueryClient();
		const { result } = renderHook(
			() =>
				useWorkspaceRemoteReattach({
					sessionId: SESSION_ID,
					workspaceId: "ws-1",
					runtimeName: null,
					provider: null,
					modelId: null,
					workingDirectory: null,
					isAlreadyStreaming: false,
				}),
			{ wrapper },
		);
		expect(result.current.isReattaching).toBe(false);
		expect(apiMocks.listRemoteAgentSessions).not.toHaveBeenCalled();
	});

	it("returns idle for the reserved local runtime name", () => {
		const { wrapper } = withQueryClient();
		const { result } = renderHook(
			() =>
				useWorkspaceRemoteReattach({
					sessionId: SESSION_ID,
					workspaceId: "ws-1",
					runtimeName: "local",
					provider: null,
					modelId: null,
					workingDirectory: null,
					isAlreadyStreaming: false,
				}),
			{ wrapper },
		);
		expect(result.current.isReattaching).toBe(false);
		expect(apiMocks.listRemoteAgentSessions).not.toHaveBeenCalled();
	});

	it("skips reattach when the chat is already streaming this session", () => {
		const { wrapper } = withQueryClient();
		renderHook(
			() =>
				useWorkspaceRemoteReattach({
					sessionId: SESSION_ID,
					workspaceId: "ws-1",
					runtimeName: RUNTIME,
					provider: null,
					modelId: null,
					workingDirectory: null,
					isAlreadyStreaming: true,
				}),
			{ wrapper },
		);
		expect(apiMocks.listRemoteAgentSessions).not.toHaveBeenCalled();
		expect(apiMocks.startAgentReattachStream).not.toHaveBeenCalled();
	});

	it("auto-fires reattach when a matching live session exists", async () => {
		apiMocks.listRemoteAgentSessions.mockResolvedValue([LIVE_SESSION]);
		const { wrapper } = withQueryClient();
		const { result } = renderHook(
			() =>
				useWorkspaceRemoteReattach({
					sessionId: SESSION_ID,
					workspaceId: "ws-1",
					runtimeName: RUNTIME,
					provider: null,
					modelId: null,
					workingDirectory: null,
					isAlreadyStreaming: false,
				}),
			{ wrapper },
		);
		await waitFor(() => {
			expect(apiMocks.startAgentReattachStream).toHaveBeenCalled();
		});
		const req = apiMocks.startAgentReattachStream.mock
			.calls[0][0] as AgentReattachRequest;
		expect(req.requestId).toBe(REQUEST_ID);
		expect(req.helmorSessionId).toBe(SESSION_ID);
		expect(result.current.currentRequestId).toBe(REQUEST_ID);
		expect(result.current.isReattaching).toBe(true);
	});

	it("surfaces daemon replay diagnostics (replayedCount + replayGap) on the hook state", async () => {
		// Phase 24r: after the attach RPC resolves, the hook stashes
		// the daemon-reported replay diagnostics so the workspace
		// chip can render "Rebuilding history (N events)" + the gap
		// banner when applicable.
		apiMocks.startAgentReattachStream.mockResolvedValueOnce({
			accepted: true,
			lastSeq: 99,
			replayedCount: 7,
			replayGap: 50,
		} satisfies AgentReattachResponse);
		apiMocks.listRemoteAgentSessions.mockResolvedValue([LIVE_SESSION]);
		const { wrapper } = withQueryClient();
		const { result } = renderHook(
			() =>
				useWorkspaceRemoteReattach({
					sessionId: SESSION_ID,
					workspaceId: "ws-1",
					runtimeName: RUNTIME,
					provider: null,
					modelId: null,
					workingDirectory: null,
					isAlreadyStreaming: false,
				}),
			{ wrapper },
		);
		await waitFor(() => {
			expect(result.current.replayedCount).toBe(7);
		});
		expect(result.current.replayGap).toBe(50);
		// Still reattaching — the streaming loop is alive even
		// though the response has resolved.
		expect(result.current.isReattaching).toBe(true);
		expect(result.current.currentRequestId).toBe(REQUEST_ID);
	});

	it("does not fire reattach when no live session matches this helmor session", async () => {
		apiMocks.listRemoteAgentSessions.mockResolvedValue([
			{
				...LIVE_SESSION,
				helmorSessionId: "different-session",
			},
		]);
		const { wrapper } = withQueryClient();
		const { result } = renderHook(
			() =>
				useWorkspaceRemoteReattach({
					sessionId: SESSION_ID,
					workspaceId: "ws-1",
					runtimeName: RUNTIME,
					provider: null,
					modelId: null,
					workingDirectory: null,
					isAlreadyStreaming: false,
				}),
			{ wrapper },
		);
		await waitFor(() => {
			expect(apiMocks.listRemoteAgentSessions).toHaveBeenCalled();
		});
		expect(apiMocks.startAgentReattachStream).not.toHaveBeenCalled();
		expect(result.current.isReattaching).toBe(false);
	});

	it("writes update messages into the session thread cache anchored to persisted prefix", async () => {
		let onEvent: ((event: AgentStreamEvent) => void) | null = null;
		apiMocks.startAgentReattachStream.mockImplementation(
			async (
				_req: AgentReattachRequest,
				cb: (event: AgentStreamEvent) => void,
			) => {
				onEvent = cb;
				return {
					accepted: true,
					lastSeq: 0,
					replayedCount: 0,
					replayGap: null,
				};
			},
		);
		apiMocks.listRemoteAgentSessions.mockResolvedValue([LIVE_SESSION]);

		const { wrapper, queryClient } = withQueryClient();
		// Seed a persisted user message so the prefix has something to
		// anchor against.
		queryClient.setQueryData(sessionThreadCacheKey(SESSION_ID), [
			{
				id: "u1",
				role: "user",
				content: [{ type: "text", id: "ut", text: "hi remote" }],
			},
		]);

		renderHook(
			() =>
				useWorkspaceRemoteReattach({
					sessionId: SESSION_ID,
					workspaceId: "ws-1",
					runtimeName: RUNTIME,
					provider: null,
					modelId: null,
					workingDirectory: null,
					isAlreadyStreaming: false,
				}),
			{ wrapper },
		);
		await waitFor(() => {
			expect(apiMocks.startAgentReattachStream).toHaveBeenCalled();
		});

		expect(onEvent).not.toBeNull();
		act(() => {
			onEvent?.({
				kind: "update",
				messages: [
					{
						id: "a1",
						role: "assistant",
						content: [
							{ type: "text", id: "at", text: "live remote assistant" },
						],
					},
				],
			});
		});
		const cached = queryClient.getQueryData(
			sessionThreadCacheKey(SESSION_ID),
		) as ReturnType<typeof Array.prototype.slice> | undefined;
		expect(cached).toHaveLength(2);
		expect((cached as { id: string }[])[0].id).toBe("u1");
		expect((cached as { id: string }[])[1].id).toBe("a1");
	});

	it("invalidates session messages on done and clears reattaching state", async () => {
		let onEvent: ((event: AgentStreamEvent) => void) | null = null;
		apiMocks.startAgentReattachStream.mockImplementation(
			async (
				_req: AgentReattachRequest,
				cb: (event: AgentStreamEvent) => void,
			) => {
				onEvent = cb;
				return {
					accepted: true,
					lastSeq: 0,
					replayedCount: 0,
					replayGap: null,
				};
			},
		);
		apiMocks.listRemoteAgentSessions.mockResolvedValue([LIVE_SESSION]);
		const { wrapper, queryClient } = withQueryClient();
		const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
		const { result } = renderHook(
			() =>
				useWorkspaceRemoteReattach({
					sessionId: SESSION_ID,
					workspaceId: "ws-1",
					runtimeName: RUNTIME,
					provider: null,
					modelId: null,
					workingDirectory: null,
					isAlreadyStreaming: false,
				}),
			{ wrapper },
		);
		await waitFor(() => {
			expect(result.current.isReattaching).toBe(true);
		});
		act(() => {
			onEvent?.({
				kind: "done",
				provider: "claude",
				modelId: "claude-opus-4",
				resolvedModel: "claude-opus-4",
				sessionId: "sdk-session-1",
				workingDirectory: "/srv/demo",
				persisted: false,
			});
		});
		expect(result.current.isReattaching).toBe(false);
		expect(result.current.terminalLabel).toBe("Caught up.");
		expect(invalidateSpy).toHaveBeenCalled();
	});

	it("surfaces an error when the attach RPC throws", async () => {
		apiMocks.listRemoteAgentSessions.mockResolvedValue([LIVE_SESSION]);
		apiMocks.startAgentReattachStream.mockRejectedValueOnce(
			new Error("transport closed"),
		);
		const { wrapper } = withQueryClient();
		const { result } = renderHook(
			() =>
				useWorkspaceRemoteReattach({
					sessionId: SESSION_ID,
					workspaceId: "ws-1",
					runtimeName: RUNTIME,
					provider: null,
					modelId: null,
					workingDirectory: null,
					isAlreadyStreaming: false,
				}),
			{ wrapper },
		);
		await waitFor(() => {
			expect(result.current.error).toMatch(/transport closed/);
		});
		expect(result.current.isReattaching).toBe(false);
	});
});
