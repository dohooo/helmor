/**
 * Autoresearch perf harness — DO NOT delete or weaken without authorization.
 *
 * This test exists to give the autoresearch loop a single mechanical number
 * for HELMOR_PERF_TOTAL: the total number of "wasted" or "expected" renders
 * accumulated by `dev-render-debug` while a real WorkspacePanel is exercised
 * through three scenarios:
 *
 *   1. Mount the panel with a populated session.
 *   2. Switch to a different session, then switch back.
 *   3. Stream-append 50 chunks to the active session, simulating an agent
 *      response.
 *
 * The render counters live in `src/lib/dev-render-debug.ts` and write to
 * `window.__HELMOR_DEV_RENDER_STATS__` once `?debugRenderCounts=1` is in the
 * URL. We set that URL before importing the panel so the gate flips before any
 * memoised closures capture `false`.
 *
 * Lower is better. The number includes:
 *   - sum of `messageRows.rendersBySession` values
 *   - sum of `composer.rendersByContext` values
 *   - sum of `sidebarRows` values
 *
 * The single line `HELMOR_PERF_TOTAL=<n>` is what the verify command greps.
 */

// Flip the dev-render-debug gate BEFORE any module that calls
// `recordMessageRender` is evaluated.
if (typeof window !== "undefined") {
	const url = new URL(window.location.href);
	url.searchParams.set("debugRenderCounts", "1");
	window.history.replaceState(null, "", url.toString());
	(
		window as unknown as { __HELMOR_DEV_RENDER_STATS__?: unknown }
	).__HELMOR_DEV_RENDER_STATS__ = undefined;

	// jsdom returns 0 for every layout-derived measurement, which makes
	// ProgressiveConversationViewport's visible-window calculation degenerate
	// (no rows are excluded, ResizeObserver never settles paneWidth, etc).
	// We patch the prototypes to return a realistic desktop-pane size so the
	// perf harness exercises the same window-trim path real users hit.
	const PANE_WIDTH = 800;
	const PANE_HEIGHT = 720;
	const ALL_LAYOUT_HOST = HTMLElement.prototype;
	Object.defineProperty(ALL_LAYOUT_HOST, "clientWidth", {
		configurable: true,
		get() {
			return PANE_WIDTH;
		},
	});
	Object.defineProperty(ALL_LAYOUT_HOST, "clientHeight", {
		configurable: true,
		get() {
			return PANE_HEIGHT;
		},
	});
	Object.defineProperty(ALL_LAYOUT_HOST, "scrollHeight", {
		configurable: true,
		get() {
			// `scrollHeight` is read by the panel's session-switch snap-to-bottom
			// effect (`scrollParent.scrollTop = scrollParent.scrollHeight`).
			// Returning a number larger than the viewport keeps it from
			// degenerating to 0.
			return 4096;
		},
	});
}

import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { afterAll, beforeAll, describe, it, vi } from "vitest";
import type {
	ExtendedMessagePart,
	ThreadMessageLike,
	WorkspaceDetail,
	WorkspaceSessionSummary,
} from "@/lib/api";
import { createHelmorQueryClient } from "@/lib/query-client";

// ---------------------------------------------------------------------------
// Module mocks — keep heavy deps from blowing up jsdom and from doing real IPC.
// ---------------------------------------------------------------------------

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();
	return {
		...actual,
		listRemoteBranches: vi.fn(async () => []),
		loadHiddenSessions: vi.fn(async () => []),
		createSession: vi.fn(async () => ({ id: "noop" })),
		deleteSession: vi.fn(async () => undefined),
		hideSession: vi.fn(async () => undefined),
		unhideSession: vi.fn(async () => undefined),
		renameSession: vi.fn(async () => undefined),
		updateIntendedTargetBranch: vi.fn(async () => undefined),
	};
});

// Streamdown brings in shiki/code-highlighting and is heavy. Replace it with
// a trivial element so the perf harness measures conversation chrome, not
// markdown rendering.
vi.mock("streamdown", () => ({
	Streamdown: ({ children }: { children?: React.ReactNode }) => (
		<div data-test="streamdown">{children}</div>
	),
}));

vi.mock("@/components/streamdown-components", () => ({
	streamdownComponents: {},
}));

// ---------------------------------------------------------------------------
// Synthetic data builders
// ---------------------------------------------------------------------------

function makeWorkspace(id: string): WorkspaceDetail {
	return {
		id,
		title: `WS ${id}`,
		repoId: "repo-1",
		repoName: "repo",
		directoryName: "repo",
		state: "active",
		hasUnread: false,
		workspaceUnread: 0,
		sessionUnreadTotal: 0,
		unreadSessionCount: 0,
		derivedStatus: "active",
		sessionCount: 2,
		messageCount: 0,
		attachmentCount: 0,
	};
}

function makeSession(
	workspaceId: string,
	id: string,
	title: string,
): WorkspaceSessionSummary {
	return {
		id,
		workspaceId,
		title,
		agentType: "claude-code",
		status: "idle",
		permissionMode: "ask",
		unreadCount: 0,
		contextTokenCount: 0,
		thinkingEnabled: false,
		fastMode: false,
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
		isHidden: false,
		isCompacting: false,
		active: false,
	};
}

function userMessage(id: string, text: string): ThreadMessageLike {
	return {
		id,
		role: "user",
		createdAt: new Date(0).toISOString(),
		content: [{ type: "text", text } as ExtendedMessagePart],
	};
}

function assistantMessage(
	id: string,
	text: string,
	streaming = false,
): ThreadMessageLike {
	return {
		id,
		role: "assistant",
		createdAt: new Date(0).toISOString(),
		content: [{ type: "text", text } as ExtendedMessagePart],
		streaming,
	};
}

/**
 * Build a thread of N alternating user/assistant text messages. We deliberately
 * exceed `NON_VIRTUALIZED_THREAD_MESSAGE_LIMIT` (12) so the test exercises
 * `ProgressiveConversationViewport`, not the plain-thread fast path.
 */
function makeThread(count: number): ThreadMessageLike[] {
	const out: ThreadMessageLike[] = [];
	for (let i = 0; i < count; i += 1) {
		const role = i % 2 === 0 ? "user" : "assistant";
		const text =
			`${role} message ${i} — ` + "lorem ipsum dolor sit amet ".repeat(3);
		out.push(
			role === "user"
				? userMessage(`m${i}`, text)
				: assistantMessage(`m${i}`, text),
		);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Render stats helpers
// ---------------------------------------------------------------------------

type DevRenderStats = {
	composer: { rendersByContext: Record<string, number> };
	sidebarRows: Record<string, number>;
	messageRows: { rendersBySession: Record<string, number> };
};

function readStats(): DevRenderStats | null {
	if (typeof window === "undefined") return null;
	const stats = (
		window as unknown as { __HELMOR_DEV_RENDER_STATS__?: DevRenderStats }
	).__HELMOR_DEV_RENDER_STATS__;
	return stats ?? null;
}

function sumStats(stats: DevRenderStats | null): number {
	if (!stats) return 0;
	const sumValues = (record: Record<string, number>) =>
		Object.values(record).reduce((acc, value) => acc + value, 0);
	return (
		sumValues(stats.messageRows.rendersBySession) +
		sumValues(stats.composer.rendersByContext) +
		sumValues(stats.sidebarRows)
	);
}

function resetStats() {
	if (typeof window === "undefined") return;
	(
		window as unknown as { __HELMOR_DEV_RENDER_STATS__?: unknown }
	).__HELMOR_DEV_RENDER_STATS__ = undefined;
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

// Lazy import so the URL flip and mocks above are in place first.
type LazyPanel =
	typeof import("@/components/workspace-panel")["WorkspacePanel"];
let WorkspacePanel: LazyPanel;

beforeAll(async () => {
	const mod = await import("@/components/workspace-panel");
	WorkspacePanel = mod.WorkspacePanel;
});

afterAll(() => {
	cleanup();
});

describe("conversation render perf", () => {
	it("measures total render count across switch + stream scenarios", async () => {
		resetStats();

		const workspace = makeWorkspace("ws-1");
		const sessionA = makeSession("ws-1", "sess-a", "Session A");
		const sessionB = makeSession("ws-1", "sess-b", "Session B");
		const sessions = [sessionA, sessionB];

		const initialThread = makeThread(30);
		let streamingThread = makeThread(30);

		const queryClient = createHelmorQueryClient();
		queryClient.setDefaultOptions({
			queries: {
				...queryClient.getDefaultOptions().queries,
				retry: false,
			},
		});

		const buildPanel = (params: {
			selectedSessionId: string;
			messages: ThreadMessageLike[];
			sending: boolean;
		}) => (
			<QueryClientProvider client={queryClient}>
				<WorkspacePanel
					workspace={workspace}
					sessions={sessions}
					selectedSessionId={params.selectedSessionId}
					selectedProvider="claude-code"
					sessionPanes={[
						{
							sessionId: params.selectedSessionId,
							messages: params.messages,
							sending: params.sending,
							hasLoaded: true,
							presentationState: "presented",
						},
					]}
					loadingWorkspace={false}
					loadingSession={false}
					sending={params.sending}
				/>
			</QueryClientProvider>
		);

		// Scenario 1: initial mount
		const { rerender } = render(
			buildPanel({
				selectedSessionId: sessionA.id,
				messages: initialThread,
				sending: false,
			}),
		);

		// Scenario 2: bounce between sessions A ↔ B three times. Each switch
		// remounts the viewport (key={sessionId} on ScrollArea), so the cost of
		// the cold-render path is what dominates this scenario.
		const threadB = makeThread(25);
		for (let bounce = 0; bounce < 3; bounce += 1) {
			// eslint-disable-next-line no-await-in-loop
			await act(async () => {
				rerender(
					buildPanel({
						selectedSessionId: sessionB.id,
						messages: threadB,
						sending: false,
					}),
				);
			});
			// eslint-disable-next-line no-await-in-loop
			await act(async () => {
				rerender(
					buildPanel({
						selectedSessionId: sessionA.id,
						messages: initialThread,
						sending: false,
					}),
				);
			});
		}

		// Scenario 3: stream-append 100 chunks to the tail of session A
		for (let i = 0; i < 100; i += 1) {
			const tailIndex = streamingThread.length - 1;
			const tail = streamingThread[tailIndex]!;
			const updatedTail: ThreadMessageLike = {
				...tail,
				content: [
					{
						type: "text",
						text: `${(tail.content[0] as { text: string }).text} chunk-${i}`,
					} as ExtendedMessagePart,
				],
				streaming: true,
			};
			streamingThread = [...streamingThread.slice(0, tailIndex), updatedTail];
			// eslint-disable-next-line no-await-in-loop
			await act(async () => {
				rerender(
					buildPanel({
						selectedSessionId: sessionA.id,
						messages: streamingThread,
						sending: true,
					}),
				);
			});
		}

		// Flush any pending microtasks before reading stats.
		await act(async () => {});

		const total = sumStats(readStats());

		// eslint-disable-next-line no-console
		console.log(`HELMOR_PERF_TOTAL=${total}`);

		// The harness must always emit a number; even 0 is valid output for the
		// verify command. Sanity check: stats object must exist (i.e. the gate
		// fired correctly).
		if (readStats() === null) {
			throw new Error(
				"dev-render-debug stats not initialised — ?debugRenderCounts=1 gate did not fire",
			);
		}
	});
});
