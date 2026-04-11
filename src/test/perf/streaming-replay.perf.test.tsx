/**
 * Streaming-replay perf harness.
 *
 * Where `conversation-render.perf.test.tsx` measures session-bounce + 100
 * synthetic chunks against a fully-static thread, this harness measures the
 * **streaming hot path** by replaying a real Claude Code SDK capture
 * (`fixtures/streaming-tool-use.jsonl`, 730 stream events) into the panel
 * tick-by-tick.
 *
 * Output line: `HELMOR_PERF_STREAMING_TOTAL=<n>` where `n` =
 *   sum(messageRows.rendersBySession) + sum(composer.rendersByContext) +
 *   sum(sidebarRows). Lower is better.
 *
 * Phase 1 baseline: this is the metric that Phase 2 streaming optimisations
 * (A2 estimator-in-worker, A3 fine-grained signals, A1' deferred hydration)
 * will be judged against.
 */

if (typeof window !== "undefined") {
	const url = new URL(window.location.href);
	url.searchParams.set("debugRenderCounts", "1");
	window.history.replaceState(null, "", url.toString());
	(
		window as unknown as { __HELMOR_DEV_RENDER_STATS__?: unknown }
	).__HELMOR_DEV_RENDER_STATS__ = undefined;

	// Same jsdom layout-stub trick as conversation-render.perf.test.tsx —
	// jsdom returns 0 for everything otherwise, which makes the
	// ProgressiveConversationViewport's window-trim logic degenerate.
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
			return 4096;
		},
	});
}

import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { afterAll, beforeAll, describe, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type {
	ExtendedMessagePart,
	ThreadMessageLike,
	WorkspaceDetail,
	WorkspaceSessionSummary,
} from "@/lib/api";
import { createHelmorQueryClient } from "@/lib/query-client";
import { countFixtureRows, replayFixture } from "./fixture-loader";

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

vi.mock("streamdown", () => ({
	Streamdown: ({ children }: { children?: React.ReactNode }) => (
		<div data-test="streamdown">{children}</div>
	),
}));

vi.mock("@/components/streamdown-components", () => ({
	streamdownComponents: {},
}));

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
		sessionCount: 1,
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

function makeStaticHistory(count: number): ThreadMessageLike[] {
	const out: ThreadMessageLike[] = [];
	for (let i = 0; i < count; i += 1) {
		const role = i % 2 === 0 ? "user" : "assistant";
		const text = `${role} pre-stream history ${i} — lorem ipsum dolor sit amet `;
		out.push({
			id: `hist-${i}`,
			role: role as "user" | "assistant",
			createdAt: new Date(0).toISOString(),
			content: [{ type: "text", text } as ExtendedMessagePart],
		});
	}
	return out;
}

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

describe("streaming replay perf", () => {
	it("replays a real Claude SDK capture into the panel and emits HELMOR_PERF_STREAMING_TOTAL", async () => {
		resetStats();

		const workspace = makeWorkspace("ws-1");
		const sessionA = makeSession("ws-1", "sess-a", "Session A");
		const sessions = [sessionA];

		// 20 historical messages so the viewport is in virtualized mode
		// (NON_VIRTUALIZED_THREAD_MESSAGE_LIMIT is 12) — this exercises the
		// same path that real users hit during streaming.
		const history = makeStaticHistory(20);

		const queryClient = createHelmorQueryClient();
		queryClient.setDefaultOptions({
			queries: {
				...queryClient.getDefaultOptions().queries,
				retry: false,
			},
		});

		const buildPanel = (messages: ThreadMessageLike[], sending: boolean) => (
			<QueryClientProvider client={queryClient}>
				<TooltipProvider delayDuration={0}>
					<WorkspacePanel
						workspace={workspace}
						sessions={sessions}
						selectedSessionId={sessionA.id}
						selectedProvider="claude-code"
						sessionPanes={[
							{
								sessionId: sessionA.id,
								messages,
								sending,
								hasLoaded: true,
								presentationState: "presented",
							},
						]}
						loadingWorkspace={false}
						loadingSession={false}
						sending={sending}
					/>
				</TooltipProvider>
			</QueryClientProvider>
		);

		// Initial mount: history only, no streaming yet.
		const { rerender } = render(buildPanel(history, false));

		// Replay every snapshot from the fixture. We cap at a reasonable
		// upper bound just so a corrupted fixture can't deadlock CI.
		const REPLAY_CAP = 1000;
		let snapshotCount = 0;
		for (const snapshot of replayFixture({
			staticHistory: history,
			limit: REPLAY_CAP,
		})) {
			snapshotCount += 1;
			// eslint-disable-next-line no-await-in-loop
			await act(async () => {
				rerender(buildPanel(snapshot.thread, true));
			});
		}

		// Final commit: streaming complete, sending=false. This is what
		// `done` event triggers in the real pipeline.
		await act(async () => {
			rerender(buildPanel(history, false));
		});
		await act(async () => {});

		const total = sumStats(readStats());

		// eslint-disable-next-line no-console
		console.log(`HELMOR_PERF_STREAMING_TOTAL=${total}`);
		// eslint-disable-next-line no-console
		console.log(`HELMOR_PERF_STREAMING_SNAPSHOTS=${snapshotCount}`);
		// eslint-disable-next-line no-console
		console.log(`HELMOR_PERF_STREAMING_FIXTURE_ROWS=${countFixtureRows()}`);

		if (readStats() === null) {
			throw new Error(
				"dev-render-debug stats not initialised — ?debugRenderCounts=1 gate did not fire",
			);
		}
	});
});
