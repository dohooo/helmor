import { QueryClient } from "@tanstack/react-query";
import { RouterContextProvider, RouterProvider } from "@tanstack/react-router";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	loadSessionThreadMessages,
	loadWorkspaceDetail,
	loadWorkspaceSessions,
	type ThreadMessageLike,
	type WorkspaceDetail,
	type WorkspaceGroup,
	type WorkspaceRow,
	type WorkspaceSessionSummary,
} from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import { SCHEDULE_AFTER_PAINT_FALLBACK_MS } from "@/lib/schedule-after-paint";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import { router } from "@/router";
import { locationToSelection } from "@/router/location-mapping";
import { navigateSelection } from "@/router/navigate-selection";
import { useSelectionController } from "./use-selection-controller";

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();
	return {
		...actual,
		triggerWorkspaceFetch: vi.fn(),
		prewarmSlashCommandsForWorkspace: vi.fn(),
		// Deterministic fetch control for the cold-flip tests. Default to a
		// never-resolving fetch so the fire-and-forget prefetches the warm
		// tests trigger can't write into the seeded caches mid-test.
		loadWorkspaceDetail: vi.fn(() => new Promise(() => {})),
		loadWorkspaceSessions: vi.fn(() => new Promise(() => {})),
		loadSessionThreadMessages: vi.fn(() => new Promise(() => {})),
	};
});

// Stage 3b: the router is the source of truth for navigation INTENT
// (`selectedWorkspaceId` / `selectedSessionId` / `viewMode`). These used to be
// store fields the controller `state` exposed; they are now read off
// `router.state.location`. The harness mounts a `RouterProvider` so the
// controller's `navigate` calls commit the location synchronously (memory
// history), and these helpers read the SAME observable intent back so every
// assertion's MEANING is preserved — only the source of the value moved.
function routerSelection() {
	const loc = router.state.location;
	return locationToSelection({
		pathname: loc.pathname,
		search: loc.search as { view?: string },
	});
}

// Mount the controller so its `navigate` calls are live and commit
// synchronously. A real `<RouterProvider>` (rendered as a sibling) mounts the
// Transitioner that subscribes history → memory-history `push`/`replace`
// commits the location synchronously. The hook itself reads the router through
// a bare `<RouterContextProvider>` around `children` (the RouterProvider's own
// route components render null, so the hook can't live inside them).
function routerWrapper({ children }: { children: ReactNode }) {
	return (
		<>
			<RouterProvider
				router={router}
				context={{
					queryClient: new QueryClient(),
					onOpenSettings: () => {},
					appShell: () => null,
				}}
			/>
			<RouterContextProvider router={router}>{children}</RouterContextProvider>
		</>
	);
}

// The module-scope router is a singleton shared across tests — reset its
// location before each so prior navigations don't leak in.
beforeEach(() => {
	router.history.replace("/");
});

// The deferred displayed-flip tests stub rAF (callback map, manual flush — same
// pattern as navigation/container.test.tsx) and use fake timers for the
// setTimeout(0) inner step + the fallback timer. Restore both unconditionally so
// the real-timer tests in this file stay untouched.
const originalRequestAnimationFrame = window.requestAnimationFrame;
const originalCancelAnimationFrame = window.cancelAnimationFrame;

afterEach(() => {
	vi.useRealTimers();
	Object.defineProperty(window, "requestAnimationFrame", {
		configurable: true,
		writable: true,
		value: originalRequestAnimationFrame,
	});
	Object.defineProperty(window, "cancelAnimationFrame", {
		configurable: true,
		writable: true,
		value: originalCancelAnimationFrame,
	});
	// Per-test loader overrides (cold-flip tests) must not leak forward.
	vi.mocked(loadWorkspaceDetail).mockImplementation(
		() => new Promise(() => {}),
	);
	vi.mocked(loadWorkspaceSessions).mockImplementation(
		() => new Promise(() => {}),
	);
	vi.mocked(loadSessionThreadMessages).mockImplementation(
		() => new Promise(() => {}),
	);
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

// Drain a cold prime's resolution under fake timers: react-query schedules
// its notifications via setTimeout(0), so interleave zero-advances with
// microtask flushes until the ensure → then chain settles.
async function flushPrimeResolution() {
	for (let i = 0; i < 8; i += 1) {
		await act(async () => {
			vi.advanceTimersByTime(0);
			await Promise.resolve();
		});
	}
}

// Install fake timers + a manual-flush rAF stub. Only setTimeout/clearTimeout
// are faked (the flip's inner step + 80ms fallback) so the rAF stub below owns
// the frame channel. `flushFrames` runs (and consumes) every captured frame
// callback; cancelAnimationFrame deletes the callback, so a cancelled flip's
// frame never runs — letting tests assert the cancellation itself via
// `frameCallbacks.size`.
function installFlipTimingHarness() {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const frameCallbacks = new Map<number, FrameRequestCallback>();
	let nextFrameId = 1;
	Object.defineProperty(window, "requestAnimationFrame", {
		configurable: true,
		writable: true,
		value: vi.fn((callback: FrameRequestCallback) => {
			const id = nextFrameId;
			nextFrameId += 1;
			frameCallbacks.set(id, callback);
			return id;
		}),
	});
	Object.defineProperty(window, "cancelAnimationFrame", {
		configurable: true,
		writable: true,
		value: vi.fn((id: number) => {
			frameCallbacks.delete(id);
		}),
	});
	const flushFrames = () => {
		for (const [id, callback] of [...frameCallbacks]) {
			frameCallbacks.delete(id);
			callback(performance.now());
		}
	};
	return { frameCallbacks, flushFrames };
}

function makeWorkspace(id: string, name = id): WorkspaceDetail {
	return {
		id,
		name,
		title: name,
		description: null,
		summary: null,
		repoId: "repo-1",
		repoName: "repo",
		branch: "feature/branch",
		defaultBranch: "main",
		intendedTargetBranch: "main",
		remote: "origin",
		remoteUrl: null,
		state: "ready",
		tone: "progress",
		mode: "worktree",
		rootPath: `/tmp/${id}`,
		createdAt: "2024-01-01T00:00:00.000Z",
		updatedAt: "2024-01-01T00:00:00.000Z",
		setupCompletedAt: "2024-01-01T00:00:00.000Z",
		activeSessionId: `${id}-session-1`,
		visibility: "visible",
		unreadSessionCount: 0,
		hasUnread: false,
		workspaceUnread: false,
		actionMode: null,
		actionContext: null,
		prSyncState: null,
		prUrl: null,
		prTitle: null,
		prDraft: false,
		prChecksTone: null,
		prMergeable: null,
		conflictCount: 0,
		uncommittedCount: 0,
		labelIds: [],
		summaryStage: null,
		archivedAt: null,
		bytesIndexed: null,
	} as unknown as WorkspaceDetail;
}

function makeSession(
	id: string,
	overrides: Partial<WorkspaceSessionSummary> = {},
): WorkspaceSessionSummary {
	return {
		id,
		workspaceId: "ws-1",
		title: id,
		summary: null,
		preview: null,
		active: false,
		archived: false,
		createdAt: "2024-01-01T00:00:00.000Z",
		updatedAt: "2024-01-01T00:00:00.000Z",
		messageCount: 0,
		unreadCount: 0,
		settledAt: null,
		hidden: false,
		...overrides,
	} as unknown as WorkspaceSessionSummary;
}

function seedWorkspaceCache(
	queryClient: QueryClient,
	workspaceId: string,
	sessions: WorkspaceSessionSummary[] = [],
) {
	queryClient.setQueryData(
		helmorQueryKeys.workspaceDetail(workspaceId),
		makeWorkspace(workspaceId),
	);
	queryClient.setQueryData(
		helmorQueryKeys.workspaceSessions(workspaceId),
		sessions,
	);
	for (const session of sessions) {
		queryClient.setQueryData(
			[...helmorQueryKeys.sessionMessages(session.id), "thread"],
			[],
		);
	}
}

function buildHookProps(
	overrides: {
		queryClient?: QueryClient;
		workspaceGroups?: WorkspaceGroup[];
		archivedRows?: WorkspaceRow[];
		updateSettings?: (patch: unknown) => void;
		onWorkspaceSwitched?: () => void;
		onStartOpened?: (opts: { persist: boolean }) => void;
	} = {},
) {
	const queryClient = overrides.queryClient ?? new QueryClient();
	const updateSettings = overrides.updateSettings ?? vi.fn();
	return {
		queryClient,
		workspaceGroups: overrides.workspaceGroups ?? [],
		archivedRows: overrides.archivedRows ?? [],
		appSettings: { ...DEFAULT_SETTINGS },
		areSettingsLoaded: true,
		updateSettings: updateSettings as (
			patch: Partial<typeof DEFAULT_SETTINGS>,
		) => void | Promise<void>,
		onWorkspaceSwitched: overrides.onWorkspaceSwitched,
		onStartOpened: overrides.onStartOpened,
	} as const;
}

describe("useSelectionController", () => {
	it("commits the router synchronously and defers the displayed flip by one frame", () => {
		const { flushFrames } = installFlipTimingHarness();
		const queryClient = new QueryClient();
		seedWorkspaceCache(queryClient, "ws-A", [
			makeSession("ws-A-session-1", { active: true }),
		]);
		seedWorkspaceCache(queryClient, "ws-B", [
			makeSession("ws-B-session-1", { active: true }),
		]);
		const { result } = renderHook(
			() => useSelectionController(buildHookProps({ queryClient })),
			{ wrapper: routerWrapper },
		);

		// Seed the paint track (displayed === null flips synchronously).
		act(() => {
			result.current.actions.selectWorkspace("ws-A");
		});
		expect(result.current.state.displayedWorkspaceId).toBe("ws-A");

		const displayedLog: Array<string | null> = [];
		const unsubscribe = result.current.store.subscribe((s) => {
			displayedLog.push(s.displayedWorkspaceId);
		});

		act(() => {
			result.current.actions.selectWorkspace("ws-B");
		});

		// Router intent (and the sidebar highlight it drives) commits inside the
		// input task; the displayed paint track holds the old workspace until the
		// scheduled flip runs.
		expect(routerSelection().workspaceId).toBe("ws-B");
		expect(routerSelection().sessionId).toBe("ws-B-session-1");
		expect(result.current.state.displayedWorkspaceId).toBe("ws-A");
		expect(result.current.state.displayedSessionId).toBe("ws-A-session-1");

		// rAF → setTimeout(0) lands the flip exactly once.
		act(() => {
			flushFrames();
			vi.advanceTimersByTime(0);
		});
		expect(result.current.state.displayedWorkspaceId).toBe("ws-B");
		expect(result.current.state.displayedSessionId).toBe("ws-B-session-1");
		expect(displayedLog).toEqual(["ws-B"]);
		unsubscribe();
	});

	it("re-selecting the current workspace bumps the reselect tick instead of switching", () => {
		const queryClient = new QueryClient();
		seedWorkspaceCache(queryClient, "ws-A", [makeSession("ws-A-session-1")]);
		const onWorkspaceSwitched = vi.fn();
		const { result } = renderHook(
			() =>
				useSelectionController(
					buildHookProps({ queryClient, onWorkspaceSwitched }),
				),
			{ wrapper: routerWrapper },
		);

		act(() => {
			result.current.actions.selectWorkspace("ws-A");
		});
		const tickBefore = result.current.state.reselectTick;
		expect(onWorkspaceSwitched).toHaveBeenCalledTimes(1);

		act(() => {
			result.current.actions.selectWorkspace("ws-A");
		});

		expect(result.current.state.reselectTick).toBe(tickBefore + 1);
		expect(result.current.state.displayedWorkspaceId).toBe("ws-A");
		expect(onWorkspaceSwitched).toHaveBeenCalledTimes(1);
	});

	it("rapid A → B switch only flips the display to B (stale flip cancelled)", () => {
		const { flushFrames } = installFlipTimingHarness();
		const queryClient = new QueryClient();
		seedWorkspaceCache(queryClient, "ws-0", [makeSession("ws-0-session-1")]);
		seedWorkspaceCache(queryClient, "ws-A", [makeSession("ws-A-session-1")]);
		seedWorkspaceCache(queryClient, "ws-B", [makeSession("ws-B-session-1")]);

		const { result } = renderHook(
			() => useSelectionController(buildHookProps({ queryClient })),
			{ wrapper: routerWrapper },
		);

		act(() => {
			result.current.actions.selectWorkspace("ws-0");
		});
		expect(result.current.state.displayedWorkspaceId).toBe("ws-0");

		const displayedLog: Array<string | null> = [];
		const unsubscribe = result.current.store.subscribe((s) => {
			displayedLog.push(s.displayedWorkspaceId);
		});

		act(() => {
			result.current.actions.selectWorkspace("ws-A");
			result.current.actions.selectWorkspace("ws-B");
		});

		expect(routerSelection().workspaceId).toBe("ws-B");
		// Neither flip has run yet — the display still shows the origin.
		expect(result.current.state.displayedWorkspaceId).toBe("ws-0");

		act(() => {
			flushFrames();
			vi.runOnlyPendingTimers();
		});

		// Only B's flip lands; A's scheduled flip was cancelled by B's schedule.
		expect(result.current.state.displayedWorkspaceId).toBe("ws-B");
		expect(displayedLog).toEqual(["ws-B"]);
		unsubscribe();
	});

	it("falls back to the fallback timer exactly once when rAF never fires", () => {
		installFlipTimingHarness();
		const queryClient = new QueryClient();
		seedWorkspaceCache(queryClient, "ws-A", [makeSession("ws-A-session-1")]);
		seedWorkspaceCache(queryClient, "ws-B", [makeSession("ws-B-session-1")]);

		const { result } = renderHook(
			() => useSelectionController(buildHookProps({ queryClient })),
			{ wrapper: routerWrapper },
		);

		act(() => {
			result.current.actions.selectWorkspace("ws-A");
		});

		const displayedLog: Array<string | null> = [];
		const unsubscribe = result.current.store.subscribe((s) => {
			displayedLog.push(s.displayedWorkspaceId);
		});

		act(() => {
			result.current.actions.selectWorkspace("ws-B");
		});
		expect(result.current.state.displayedWorkspaceId).toBe("ws-A");

		// rAF is stuck (callbacks captured, never flushed) → the fallback timer
		// must land the flip.
		act(() => {
			vi.advanceTimersByTime(SCHEDULE_AFTER_PAINT_FALLBACK_MS);
		});
		expect(result.current.state.displayedWorkspaceId).toBe("ws-B");
		expect(displayedLog).toEqual(["ws-B"]);

		// Nothing else fires a second flip.
		act(() => {
			vi.runOnlyPendingTimers();
		});
		expect(displayedLog).toEqual(["ws-B"]);
		unsubscribe();
	});

	it("runs the flip exactly once when a late rAF dispatch races the fallback (consumed guard)", () => {
		const { frameCallbacks } = installFlipTimingHarness();
		const queryClient = new QueryClient();
		seedWorkspaceCache(queryClient, "ws-A", [makeSession("ws-A-session-1")]);
		seedWorkspaceCache(queryClient, "ws-B", [makeSession("ws-B-session-1")]);

		const { result } = renderHook(
			() => useSelectionController(buildHookProps({ queryClient })),
			{ wrapper: routerWrapper },
		);

		act(() => {
			result.current.actions.selectWorkspace("ws-A");
		});

		const displayedLog: Array<string | null> = [];
		const unsubscribe = result.current.store.subscribe((s) => {
			displayedLog.push(s.displayedWorkspaceId);
		});

		act(() => {
			result.current.actions.selectWorkspace("ws-B");
		});
		// Keep a reference to the frame callback BEFORE the fallback's run
		// cancels it — simulating a frame callback that was already dispatched
		// when the cancellation raced in.
		const lateFrameCallbacks = [...frameCallbacks.values()];

		act(() => {
			vi.advanceTimersByTime(SCHEDULE_AFTER_PAINT_FALLBACK_MS);
		});
		expect(result.current.state.displayedWorkspaceId).toBe("ws-B");
		expect(displayedLog).toEqual(["ws-B"]);

		// The late frame schedules the inner setTimeout(0); its run must hit the
		// `consumed` guard and stay a no-op.
		act(() => {
			for (const callback of lateFrameCallbacks) {
				callback(performance.now());
			}
			vi.advanceTimersByTime(0);
		});
		expect(displayedLog).toEqual(["ws-B"]);
		unsubscribe();
	});

	it("openStart cancels a pending displayed flip", () => {
		const { frameCallbacks, flushFrames } = installFlipTimingHarness();
		const queryClient = new QueryClient();
		seedWorkspaceCache(queryClient, "ws-A", [makeSession("ws-A-session-1")]);
		seedWorkspaceCache(queryClient, "ws-B", [makeSession("ws-B-session-1")]);

		const { result } = renderHook(
			() => useSelectionController(buildHookProps({ queryClient })),
			{ wrapper: routerWrapper },
		);

		act(() => {
			result.current.actions.selectWorkspace("ws-A");
		});

		act(() => {
			result.current.actions.selectWorkspace("ws-B");
		});
		expect(result.current.state.displayedWorkspaceId).toBe("ws-A");
		expect(frameCallbacks.size).toBe(1);

		act(() => {
			result.current.actions.openStart();
		});
		// The pending flip's frame was cancelled, and the display cleared
		// synchronously.
		expect(frameCallbacks.size).toBe(0);
		expect(result.current.state.displayedWorkspaceId).toBeNull();

		act(() => {
			flushFrames();
			vi.runOnlyPendingTimers();
		});
		// The cancelled flip never lands.
		expect(result.current.state.displayedWorkspaceId).toBeNull();
		expect(result.current.state.displayedSessionId).toBeNull();
	});

	it("flips synchronously when nothing is displayed yet (start/boot — no EmptyState frame)", () => {
		installFlipTimingHarness();
		const queryClient = new QueryClient();
		seedWorkspaceCache(queryClient, "ws-A", [
			makeSession("ws-A-session-1", { active: true }),
		]);
		const { result } = renderHook(
			() => useSelectionController(buildHookProps({ queryClient })),
			{ wrapper: routerWrapper },
		);

		// displayed* is null (start surface / boot): the flip must happen inside
		// the same task — no rAF/timer flushing here.
		act(() => {
			result.current.actions.selectWorkspace("ws-A");
		});
		expect(routerSelection().workspaceId).toBe("ws-A");
		expect(result.current.state.displayedWorkspaceId).toBe("ws-A");
		expect(result.current.state.displayedSessionId).toBe("ws-A-session-1");
	});

	it("flushes a pending workspace flip before a same-task selectSession (reopen-closed-session repro)", () => {
		const { flushFrames } = installFlipTimingHarness();
		const queryClient = new QueryClient();
		seedWorkspaceCache(queryClient, "ws-A", [
			makeSession("ws-A-session-1", { active: true }),
		]);
		// ws-B's active session is session-1 (the flip's guess); session-2 is
		// the explicit pick, seeded warm so selectSession takes its synchronous
		// setState branch.
		seedWorkspaceCache(queryClient, "ws-B", [
			makeSession("ws-B-session-1", { active: true }),
			makeSession("ws-B-session-2"),
		]);
		const { result } = renderHook(
			() => useSelectionController(buildHookProps({ queryClient })),
			{ wrapper: routerWrapper },
		);

		act(() => {
			result.current.actions.selectWorkspace("ws-A");
		});
		expect(result.current.state.displayedWorkspaceId).toBe("ws-A");

		const displayedLog: Array<{
			workspaceId: string | null;
			sessionId: string | null;
		}> = [];
		const unsubscribe = result.current.store.subscribe((s) => {
			displayedLog.push({
				workspaceId: s.displayedWorkspaceId,
				sessionId: s.displayedSessionId,
			});
		});

		// Mirror reopenClosedSession: workspace switch + explicit session pick
		// in the SAME task, where the pick differs from the flip's guess.
		act(() => {
			result.current.actions.selectWorkspace("ws-B");
			result.current.actions.selectSession("ws-B-session-2");
		});

		// The store never broadcast the cross-workspace mismatch pair (old
		// displayed workspace + new explicit session).
		expect(
			displayedLog.some(
				(entry) =>
					entry.workspaceId === "ws-A" && entry.sessionId === "ws-B-session-2",
			),
		).toBe(false);
		expect(result.current.state.displayedWorkspaceId).toBe("ws-B");
		expect(result.current.state.displayedSessionId).toBe("ws-B-session-2");

		// No deferred flip lands later with the stale session-1 guess.
		act(() => {
			flushFrames();
			vi.runOnlyPendingTimers();
		});
		expect(result.current.state.displayedWorkspaceId).toBe("ws-B");
		expect(result.current.state.displayedSessionId).toBe("ws-B-session-2");
		expect(routerSelection().workspaceId).toBe("ws-B");
		expect(routerSelection().sessionId).toBe("ws-B-session-2");
		unsubscribe();
	});

	it("prefers the router's explicit session over the captured guess when the flip runs", () => {
		const { flushFrames } = installFlipTimingHarness();
		const queryClient = new QueryClient();
		seedWorkspaceCache(queryClient, "ws-A", [
			makeSession("ws-A-session-1", { active: true }),
		]);
		seedWorkspaceCache(queryClient, "ws-B", [
			makeSession("ws-B-session-1", { active: true }),
			makeSession("ws-B-session-2"),
		]);
		const { result } = renderHook(
			() => useSelectionController(buildHookProps({ queryClient })),
			{ wrapper: routerWrapper },
		);

		act(() => {
			result.current.actions.selectWorkspace("ws-A");
		});

		act(() => {
			result.current.actions.selectWorkspace("ws-B");
			// Out-of-band intent commit inside the deferral window (any
			// navigation that doesn't go through selectSession): the flip must
			// live-read the router instead of replaying its captured guess.
			navigateSelection({
				viewMode: "conversation",
				workspaceId: "ws-B",
				sessionId: "ws-B-session-2",
			});
		});

		act(() => {
			flushFrames();
			vi.advanceTimersByTime(0);
		});
		expect(result.current.state.displayedWorkspaceId).toBe("ws-B");
		expect(result.current.state.displayedSessionId).toBe("ws-B-session-2");
		// The flip's URL refinement never rewrote the explicit session away.
		expect(routerSelection().sessionId).toBe("ws-B-session-2");
	});

	it("cold flip holds the previous pane until the prime resolves, then lands a single old→new commit", async () => {
		const { flushFrames } = installFlipTimingHarness();
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		seedWorkspaceCache(queryClient, "ws-A", [
			makeSession("ws-A-session-1", { active: true }),
		]);
		// ws-B is cold: nothing seeded; its prime resolves through deferreds.
		const detail = deferred<WorkspaceDetail | null>();
		const sessions = deferred<WorkspaceSessionSummary[]>();
		const thread = deferred<ThreadMessageLike[]>();
		vi.mocked(loadWorkspaceDetail).mockImplementation((workspaceId) =>
			workspaceId === "ws-B" ? detail.promise : new Promise(() => {}),
		);
		vi.mocked(loadWorkspaceSessions).mockImplementation((workspaceId) =>
			workspaceId === "ws-B" ? sessions.promise : new Promise(() => {}),
		);
		vi.mocked(loadSessionThreadMessages).mockImplementation((sessionId) =>
			sessionId === "ws-B-session-1" ? thread.promise : new Promise(() => {}),
		);

		const { result } = renderHook(
			() => useSelectionController(buildHookProps({ queryClient })),
			{ wrapper: routerWrapper },
		);

		act(() => {
			result.current.actions.selectWorkspace("ws-A");
		});

		const displayedLog: Array<{
			workspaceId: string | null;
			sessionId: string | null;
		}> = [];
		const unsubscribe = result.current.store.subscribe((s) => {
			displayedLog.push({
				workspaceId: s.displayedWorkspaceId,
				sessionId: s.displayedSessionId,
			});
		});

		act(() => {
			result.current.actions.selectWorkspace("ws-B");
		});
		// Old pane holds while the flip is pending.
		expect(result.current.state.displayedWorkspaceId).toBe("ws-A");

		act(() => {
			flushFrames();
			vi.advanceTimersByTime(0);
		});
		// The flip ran cold with a previous pane on screen: it kicked off the
		// prime but did NOT touch the paint track — the old pane keeps holding.
		expect(result.current.state.displayedWorkspaceId).toBe("ws-A");
		expect(result.current.state.displayedSessionId).toBe("ws-A-session-1");
		expect(displayedLog).toEqual([]);

		await act(async () => {
			detail.resolve(makeWorkspace("ws-B"));
			sessions.resolve([makeSession("ws-B-session-1", { active: true })]);
			thread.resolve([]);
		});
		await flushPrimeResolution();

		// A single old→new commit: no intermediate (target, guess) state ever
		// reached the store subscribers.
		expect(displayedLog).toEqual([
			{ workspaceId: "ws-B", sessionId: "ws-B-session-1" },
		]);
		expect(routerSelection().workspaceId).toBe("ws-B");
		expect(routerSelection().sessionId).toBe("ws-B-session-1");
		unsubscribe();
	});

	it("rapid cold switches hold the old pane and land only the final workspace", async () => {
		const { flushFrames } = installFlipTimingHarness();
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		seedWorkspaceCache(queryClient, "ws-A", [
			makeSession("ws-A-session-1", { active: true }),
		]);
		// Both targets cold, each with its own deferred prime.
		const detailB = deferred<WorkspaceDetail | null>();
		const sessionsB = deferred<WorkspaceSessionSummary[]>();
		const threadB = deferred<ThreadMessageLike[]>();
		const detailC = deferred<WorkspaceDetail | null>();
		const sessionsC = deferred<WorkspaceSessionSummary[]>();
		const threadC = deferred<ThreadMessageLike[]>();
		vi.mocked(loadWorkspaceDetail).mockImplementation((workspaceId) =>
			workspaceId === "ws-B"
				? detailB.promise
				: workspaceId === "ws-C"
					? detailC.promise
					: new Promise(() => {}),
		);
		vi.mocked(loadWorkspaceSessions).mockImplementation((workspaceId) =>
			workspaceId === "ws-B"
				? sessionsB.promise
				: workspaceId === "ws-C"
					? sessionsC.promise
					: new Promise(() => {}),
		);
		vi.mocked(loadSessionThreadMessages).mockImplementation((sessionId) =>
			sessionId === "ws-B-session-1"
				? threadB.promise
				: sessionId === "ws-C-session-1"
					? threadC.promise
					: new Promise(() => {}),
		);

		const { result } = renderHook(
			() => useSelectionController(buildHookProps({ queryClient })),
			{ wrapper: routerWrapper },
		);

		act(() => {
			result.current.actions.selectWorkspace("ws-A");
		});

		const displayedLog: Array<{
			workspaceId: string | null;
			sessionId: string | null;
		}> = [];
		const unsubscribe = result.current.store.subscribe((s) => {
			displayedLog.push({
				workspaceId: s.displayedWorkspaceId,
				sessionId: s.displayedSessionId,
			});
		});

		act(() => {
			result.current.actions.selectWorkspace("ws-B");
		});
		act(() => {
			flushFrames();
			vi.advanceTimersByTime(0);
		});
		act(() => {
			result.current.actions.selectWorkspace("ws-C");
		});
		act(() => {
			flushFrames();
			vi.advanceTimersByTime(0);
		});
		// Both cold flips ran; the old pane still holds through the whole burst.
		expect(result.current.state.displayedWorkspaceId).toBe("ws-A");

		// Stale B prime resolves first — discarded by the request-id guard.
		await act(async () => {
			detailB.resolve(makeWorkspace("ws-B"));
			sessionsB.resolve([makeSession("ws-B-session-1", { active: true })]);
			threadB.resolve([]);
		});
		await flushPrimeResolution();
		expect(result.current.state.displayedWorkspaceId).toBe("ws-A");
		expect(displayedLog).toEqual([]);

		await act(async () => {
			detailC.resolve(makeWorkspace("ws-C"));
			sessionsC.resolve([makeSession("ws-C-session-1", { active: true })]);
			threadC.resolve([]);
		});
		await flushPrimeResolution();

		expect(displayedLog).toEqual([
			{ workspaceId: "ws-C", sessionId: "ws-C-session-1" },
		]);
		expect(routerSelection().workspaceId).toBe("ws-C");
		expect(routerSelection().sessionId).toBe("ws-C-session-1");
		unsubscribe();
	});

	it("derives the cold flip's URL refinement from the live view mode, not the captured one", async () => {
		const { flushFrames } = installFlipTimingHarness();
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		seedWorkspaceCache(queryClient, "ws-A", [
			makeSession("ws-A-session-1", { active: true }),
		]);
		const detail = deferred<WorkspaceDetail | null>();
		const sessions = deferred<WorkspaceSessionSummary[]>();
		const thread = deferred<ThreadMessageLike[]>();
		vi.mocked(loadWorkspaceDetail).mockImplementation((workspaceId) =>
			workspaceId === "ws-B" ? detail.promise : new Promise(() => {}),
		);
		vi.mocked(loadWorkspaceSessions).mockImplementation((workspaceId) =>
			workspaceId === "ws-B" ? sessions.promise : new Promise(() => {}),
		);
		vi.mocked(loadSessionThreadMessages).mockImplementation((sessionId) =>
			sessionId === "ws-B-session-1" ? thread.promise : new Promise(() => {}),
		);

		const { result } = renderHook(
			() => useSelectionController(buildHookProps({ queryClient })),
			{ wrapper: routerWrapper },
		);

		act(() => {
			result.current.actions.selectWorkspace("ws-A");
		});
		act(() => {
			result.current.actions.selectWorkspace("ws-B");
			// View-mode change within the deferral window: the flip's later URL
			// refinement must not revert it to the captured "conversation".
			result.current.actions.setViewMode("editor");
		});

		act(() => {
			flushFrames();
			vi.advanceTimersByTime(0);
		});
		await act(async () => {
			detail.resolve(makeWorkspace("ws-B"));
			sessions.resolve([makeSession("ws-B-session-1", { active: true })]);
			thread.resolve([]);
		});
		await flushPrimeResolution();

		expect(result.current.state.displayedSessionId).toBe("ws-B-session-1");
		expect(routerSelection().sessionId).toBe("ws-B-session-1");
		expect(routerSelection().viewMode).toBe("editor");
	});

	it("discards a stale prime resolution when a second selectWorkspace lands mid-fetch", async () => {
		const { flushFrames } = installFlipTimingHarness();
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		seedWorkspaceCache(queryClient, "ws-A", [
			makeSession("ws-A-session-1", { active: true }),
		]);
		seedWorkspaceCache(queryClient, "ws-C", [
			makeSession("ws-C-session-1", { active: true }),
		]);
		const detail = deferred<WorkspaceDetail | null>();
		const sessions = deferred<WorkspaceSessionSummary[]>();
		const thread = deferred<ThreadMessageLike[]>();
		vi.mocked(loadWorkspaceDetail).mockImplementation((workspaceId) =>
			workspaceId === "ws-B" ? detail.promise : new Promise(() => {}),
		);
		vi.mocked(loadWorkspaceSessions).mockImplementation((workspaceId) =>
			workspaceId === "ws-B" ? sessions.promise : new Promise(() => {}),
		);
		vi.mocked(loadSessionThreadMessages).mockImplementation((sessionId) =>
			sessionId === "ws-B-session-1" ? thread.promise : new Promise(() => {}),
		);

		const { result } = renderHook(
			() => useSelectionController(buildHookProps({ queryClient })),
			{ wrapper: routerWrapper },
		);

		act(() => {
			result.current.actions.selectWorkspace("ws-A");
		});
		act(() => {
			result.current.actions.selectWorkspace("ws-B");
		});
		act(() => {
			flushFrames();
			vi.advanceTimersByTime(0);
		});
		// Cold flip ran: the old pane holds while ws-B's prime is in flight.
		expect(result.current.state.displayedWorkspaceId).toBe("ws-A");
		expect(result.current.state.displayedSessionId).toBe("ws-A-session-1");

		// Second switch while ws-B's prime is in flight.
		act(() => {
			result.current.actions.selectWorkspace("ws-C");
		});
		act(() => {
			flushFrames();
			vi.advanceTimersByTime(0);
		});
		expect(result.current.state.displayedWorkspaceId).toBe("ws-C");
		expect(result.current.state.displayedSessionId).toBe("ws-C-session-1");

		// The stale resolve must neither flip the display nor touch the URL.
		await act(async () => {
			detail.resolve(makeWorkspace("ws-B"));
			sessions.resolve([makeSession("ws-B-session-1", { active: true })]);
			thread.resolve([]);
		});
		await flushPrimeResolution();
		expect(result.current.state.displayedWorkspaceId).toBe("ws-C");
		expect(result.current.state.displayedSessionId).toBe("ws-C-session-1");
		expect(routerSelection().workspaceId).toBe("ws-C");
		expect(routerSelection().sessionId).toBe("ws-C-session-1");
	});

	it("lands (target, null) when the cold prime rejects", async () => {
		const { flushFrames } = installFlipTimingHarness();
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		seedWorkspaceCache(queryClient, "ws-A", [
			makeSession("ws-A-session-1", { active: true }),
		]);
		vi.mocked(loadWorkspaceDetail).mockImplementation((workspaceId) =>
			workspaceId === "ws-B"
				? Promise.reject(new Error("prime failed"))
				: new Promise(() => {}),
		);
		vi.mocked(loadWorkspaceSessions).mockImplementation((workspaceId) =>
			workspaceId === "ws-B"
				? Promise.reject(new Error("prime failed"))
				: new Promise(() => {}),
		);

		const { result } = renderHook(
			() => useSelectionController(buildHookProps({ queryClient })),
			{ wrapper: routerWrapper },
		);

		act(() => {
			result.current.actions.selectWorkspace("ws-A");
		});

		const displayedLog: Array<{
			workspaceId: string | null;
			sessionId: string | null;
		}> = [];
		const unsubscribe = result.current.store.subscribe((s) => {
			displayedLog.push({
				workspaceId: s.displayedWorkspaceId,
				sessionId: s.displayedSessionId,
			});
		});

		act(() => {
			result.current.actions.selectWorkspace("ws-B");
		});
		act(() => {
			flushFrames();
			vi.advanceTimersByTime(0);
		});
		// The cold flip holds the old pane while the prime is in flight.
		expect(result.current.state.displayedWorkspaceId).toBe("ws-A");

		await flushPrimeResolution();

		expect(result.current.state.displayedWorkspaceId).toBe("ws-B");
		expect(result.current.state.displayedSessionId).toBeNull();
		// The reject path is the hold's bounded fallback: a single
		// (target, null) commit — same shape as today's catch semantics.
		expect(displayedLog).toEqual([{ workspaceId: "ws-B", sessionId: null }]);
		unsubscribe();
	});

	it("an explicit selectSession during an in-flight cold hold wins at resolve in one displayed commit", async () => {
		const { flushFrames } = installFlipTimingHarness();
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		seedWorkspaceCache(queryClient, "ws-A", [
			makeSession("ws-A-session-1", { active: true }),
		]);
		// ws-B is cold; its prime resolves session-1 as the fallback. The
		// explicit pick (session-2) has a WARM thread so selectSession's
		// synchronous setState branch would fire without the divergence guard.
		const detail = deferred<WorkspaceDetail | null>();
		const sessions = deferred<WorkspaceSessionSummary[]>();
		const thread = deferred<ThreadMessageLike[]>();
		vi.mocked(loadWorkspaceDetail).mockImplementation((workspaceId) =>
			workspaceId === "ws-B" ? detail.promise : new Promise(() => {}),
		);
		vi.mocked(loadWorkspaceSessions).mockImplementation((workspaceId) =>
			workspaceId === "ws-B" ? sessions.promise : new Promise(() => {}),
		);
		vi.mocked(loadSessionThreadMessages).mockImplementation((sessionId) =>
			sessionId === "ws-B-session-1" ? thread.promise : new Promise(() => {}),
		);
		queryClient.setQueryData(
			[...helmorQueryKeys.sessionMessages("ws-B-session-2"), "thread"],
			[],
		);

		const { result } = renderHook(
			() => useSelectionController(buildHookProps({ queryClient })),
			{ wrapper: routerWrapper },
		);

		act(() => {
			result.current.actions.selectWorkspace("ws-A");
		});

		const displayedLog: Array<{
			workspaceId: string | null;
			sessionId: string | null;
		}> = [];
		const unsubscribe = result.current.store.subscribe((s) => {
			displayedLog.push({
				workspaceId: s.displayedWorkspaceId,
				sessionId: s.displayedSessionId,
			});
		});

		act(() => {
			result.current.actions.selectWorkspace("ws-B");
		});
		act(() => {
			flushFrames();
			vi.advanceTimersByTime(0);
		});
		// Hold window open: flip ran cold, prime in flight, old pane on screen.
		expect(result.current.state.displayedWorkspaceId).toBe("ws-A");

		act(() => {
			result.current.actions.selectSession("ws-B-session-2");
		});
		// During the divergence selectSession only updates the router intent —
		// no displayed write (the warm sync branch is skipped), so the store
		// never broadcasts the cross-workspace mismatch pair (ws-A + session-2).
		expect(routerSelection().workspaceId).toBe("ws-B");
		expect(routerSelection().sessionId).toBe("ws-B-session-2");
		expect(result.current.state.displayedWorkspaceId).toBe("ws-A");
		expect(result.current.state.displayedSessionId).toBe("ws-A-session-1");
		expect(displayedLog).toEqual([]);

		await act(async () => {
			detail.resolve(makeWorkspace("ws-B"));
			sessions.resolve([
				makeSession("ws-B-session-1", { active: true }),
				makeSession("ws-B-session-2"),
			]);
			thread.resolve([]);
		});
		await flushPrimeResolution();

		// Resolve-time live-read: the explicit session (a member of the fetched
		// workspace) beats the prime's fallback — one displayed commit total.
		expect(displayedLog).toEqual([
			{ workspaceId: "ws-B", sessionId: "ws-B-session-2" },
		]);
		expect(routerSelection().sessionId).toBe("ws-B-session-2");
		expect(result.current.actions.getSessionSelectionHistory("ws-B")).toContain(
			"ws-B-session-2",
		);
		unsubscribe();
	});

	it("an explicit session with an uncached thread keeps the hold until its thread is fetched, then commits once", async () => {
		const { flushFrames } = installFlipTimingHarness();
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		seedWorkspaceCache(queryClient, "ws-A", [
			makeSession("ws-A-session-1", { active: true }),
		]);
		// ws-B is cold. The explicit pick (session-2) is a member of the
		// resolved list but its thread is NOT cached — the prime only warms
		// the fallback's (session-1) thread.
		const detail = deferred<WorkspaceDetail | null>();
		const sessions = deferred<WorkspaceSessionSummary[]>();
		const fallbackThread = deferred<ThreadMessageLike[]>();
		const explicitThread = deferred<ThreadMessageLike[]>();
		vi.mocked(loadWorkspaceDetail).mockImplementation((workspaceId) =>
			workspaceId === "ws-B" ? detail.promise : new Promise(() => {}),
		);
		vi.mocked(loadWorkspaceSessions).mockImplementation((workspaceId) =>
			workspaceId === "ws-B" ? sessions.promise : new Promise(() => {}),
		);
		vi.mocked(loadSessionThreadMessages).mockImplementation((sessionId) =>
			sessionId === "ws-B-session-1"
				? fallbackThread.promise
				: sessionId === "ws-B-session-2"
					? explicitThread.promise
					: new Promise(() => {}),
		);

		const { result } = renderHook(
			() => useSelectionController(buildHookProps({ queryClient })),
			{ wrapper: routerWrapper },
		);

		act(() => {
			result.current.actions.selectWorkspace("ws-A");
		});

		const displayedLog: Array<{
			workspaceId: string | null;
			sessionId: string | null;
		}> = [];
		const unsubscribe = result.current.store.subscribe((s) => {
			displayedLog.push({
				workspaceId: s.displayedWorkspaceId,
				sessionId: s.displayedSessionId,
			});
		});

		act(() => {
			result.current.actions.selectWorkspace("ws-B");
		});
		act(() => {
			flushFrames();
			vi.advanceTimersByTime(0);
		});
		act(() => {
			result.current.actions.selectSession("ws-B-session-2");
		});
		expect(routerSelection().sessionId).toBe("ws-B-session-2");
		expect(result.current.state.displayedWorkspaceId).toBe("ws-A");

		await act(async () => {
			detail.resolve(makeWorkspace("ws-B"));
			sessions.resolve([
				makeSession("ws-B-session-1", { active: true }),
				makeSession("ws-B-session-2"),
			]);
			fallbackThread.resolve([]);
		});
		await flushPrimeResolution();

		// The explicit winner's thread is still in flight: committing now would
		// degrade the hold to old→loader→content. The old pane keeps holding
		// and the thread fetch was actually kicked off.
		expect(result.current.state.displayedWorkspaceId).toBe("ws-A");
		expect(result.current.state.displayedSessionId).toBe("ws-A-session-1");
		expect(displayedLog).toEqual([]);
		expect(loadSessionThreadMessages).toHaveBeenCalledWith("ws-B-session-2");

		await act(async () => {
			explicitThread.resolve([]);
		});
		await flushPrimeResolution();

		// Single displayed commit once the explicit thread exists.
		expect(displayedLog).toEqual([
			{ workspaceId: "ws-B", sessionId: "ws-B-session-2" },
		]);
		expect(routerSelection().sessionId).toBe("ws-B-session-2");
		unsubscribe();
	});

	it("a second explicit pick during the explicit thread fetch wins — no router/displayed tear", async () => {
		const { flushFrames } = installFlipTimingHarness();
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		seedWorkspaceCache(queryClient, "ws-A", [
			makeSession("ws-A-session-1", { active: true }),
		]);
		// ws-B is cold. The first explicit pick (session-2) has an uncached
		// thread, parking the resolve on its fetch; the second pick (session-3)
		// lands DURING that await and must win the displayed commit.
		const detail = deferred<WorkspaceDetail | null>();
		const sessions = deferred<WorkspaceSessionSummary[]>();
		const fallbackThread = deferred<ThreadMessageLike[]>();
		const firstPickThread = deferred<ThreadMessageLike[]>();
		const secondPickThread = deferred<ThreadMessageLike[]>();
		vi.mocked(loadWorkspaceDetail).mockImplementation((workspaceId) =>
			workspaceId === "ws-B" ? detail.promise : new Promise(() => {}),
		);
		vi.mocked(loadWorkspaceSessions).mockImplementation((workspaceId) =>
			workspaceId === "ws-B" ? sessions.promise : new Promise(() => {}),
		);
		vi.mocked(loadSessionThreadMessages).mockImplementation((sessionId) =>
			sessionId === "ws-B-session-1"
				? fallbackThread.promise
				: sessionId === "ws-B-session-2"
					? firstPickThread.promise
					: sessionId === "ws-B-session-3"
						? secondPickThread.promise
						: new Promise(() => {}),
		);

		const { result } = renderHook(
			() => useSelectionController(buildHookProps({ queryClient })),
			{ wrapper: routerWrapper },
		);

		act(() => {
			result.current.actions.selectWorkspace("ws-A");
		});

		const displayedLog: Array<{
			workspaceId: string | null;
			sessionId: string | null;
		}> = [];
		const unsubscribe = result.current.store.subscribe((s) => {
			displayedLog.push({
				workspaceId: s.displayedWorkspaceId,
				sessionId: s.displayedSessionId,
			});
		});

		act(() => {
			result.current.actions.selectWorkspace("ws-B");
		});
		act(() => {
			flushFrames();
			vi.advanceTimersByTime(0);
		});
		act(() => {
			result.current.actions.selectSession("ws-B-session-2");
		});

		await act(async () => {
			detail.resolve(makeWorkspace("ws-B"));
			sessions.resolve([
				makeSession("ws-B-session-1", { active: true }),
				makeSession("ws-B-session-2"),
				makeSession("ws-B-session-3"),
			]);
			fallbackThread.resolve([]);
		});
		await flushPrimeResolution();
		// Resolve is parked on session-2's thread fetch; pick session-3 now.
		expect(loadSessionThreadMessages).toHaveBeenCalledWith("ws-B-session-2");
		act(() => {
			result.current.actions.selectSession("ws-B-session-3");
		});
		expect(routerSelection().sessionId).toBe("ws-B-session-3");
		expect(result.current.state.displayedWorkspaceId).toBe("ws-A");

		await act(async () => {
			firstPickThread.resolve([]);
		});
		await flushPrimeResolution();
		// The post-await re-read adopts session-3; its thread is still in
		// flight, so the hold continues instead of committing the stale pick.
		expect(result.current.state.displayedWorkspaceId).toBe("ws-A");
		expect(loadSessionThreadMessages).toHaveBeenCalledWith("ws-B-session-3");

		await act(async () => {
			secondPickThread.resolve([]);
		});
		await flushPrimeResolution();

		// One displayed commit, landing on the LATEST pick — router untouched.
		expect(displayedLog).toEqual([
			{ workspaceId: "ws-B", sessionId: "ws-B-session-3" },
		]);
		expect(routerSelection().workspaceId).toBe("ws-B");
		expect(routerSelection().sessionId).toBe("ws-B-session-3");
		unsubscribe();
		// The two-await chain has a deeper async tail than the single-pick
		// tests; settle it under fake timers so no scheduled flip survives into
		// teardown (afterEach restores real timers).
		await flushPrimeResolution();
		act(() => {
			flushFrames();
			vi.advanceTimersByTime(100); // past the 80ms flip fallback
		});
	});

	it("a foreign-session selectSession during the hold resolves to the prime fallback without polluting history", async () => {
		const { flushFrames } = installFlipTimingHarness();
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		seedWorkspaceCache(queryClient, "ws-A", [
			makeSession("ws-A-session-1", { active: true }),
		]);
		const detail = deferred<WorkspaceDetail | null>();
		const sessions = deferred<WorkspaceSessionSummary[]>();
		const thread = deferred<ThreadMessageLike[]>();
		vi.mocked(loadWorkspaceDetail).mockImplementation((workspaceId) =>
			workspaceId === "ws-B" ? detail.promise : new Promise(() => {}),
		);
		vi.mocked(loadWorkspaceSessions).mockImplementation((workspaceId) =>
			workspaceId === "ws-B" ? sessions.promise : new Promise(() => {}),
		);
		vi.mocked(loadSessionThreadMessages).mockImplementation((sessionId) =>
			sessionId === "ws-B-session-1" ? thread.promise : new Promise(() => {}),
		);
		// The foreign session's thread is warm so only the divergence guard —
		// not a cold-cache accident — keeps the write out.
		queryClient.setQueryData(
			[...helmorQueryKeys.sessionMessages("ws-Z-session-9"), "thread"],
			[],
		);

		const { result } = renderHook(
			() => useSelectionController(buildHookProps({ queryClient })),
			{ wrapper: routerWrapper },
		);

		act(() => {
			result.current.actions.selectWorkspace("ws-A");
		});

		const displayedLog: Array<{
			workspaceId: string | null;
			sessionId: string | null;
		}> = [];
		const unsubscribe = result.current.store.subscribe((s) => {
			displayedLog.push({
				workspaceId: s.displayedWorkspaceId,
				sessionId: s.displayedSessionId,
			});
		});

		act(() => {
			result.current.actions.selectWorkspace("ws-B");
		});
		act(() => {
			flushFrames();
			vi.advanceTimersByTime(0);
		});
		act(() => {
			result.current.actions.selectSession("ws-Z-session-9");
		});
		// Displayed unaffected until the prime resolves.
		expect(result.current.state.displayedWorkspaceId).toBe("ws-A");
		expect(displayedLog).toEqual([]);

		await act(async () => {
			detail.resolve(makeWorkspace("ws-B"));
			sessions.resolve([makeSession("ws-B-session-1", { active: true })]);
			thread.resolve([]);
		});
		await flushPrimeResolution();

		// Membership check at resolve: the foreign session is not in ws-B's
		// list, so the prime's fallback wins and refines the URL.
		expect(displayedLog).toEqual([
			{ workspaceId: "ws-B", sessionId: "ws-B-session-1" },
		]);
		expect(routerSelection().sessionId).toBe("ws-B-session-1");
		expect(
			result.current.actions.getSessionSelectionHistory("ws-B"),
		).not.toContain("ws-Z-session-9");
		expect(result.current.actions.getSessionSelectionHistory("ws-B")).toContain(
			"ws-B-session-1",
		);
		unsubscribe();
	});

	it("repairs the router off the LIVE session when a foreign pick left it stale and the guess equals the resolved id", async () => {
		const { flushFrames } = installFlipTimingHarness();
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		// ws-A holds the screen; session-2 (warm via seeding) is the foreign
		// session the user clicks while ws-B's prime is in flight.
		seedWorkspaceCache(queryClient, "ws-A", [
			makeSession("ws-A-session-1", { active: true }),
			makeSession("ws-A-session-2"),
		]);
		const detail = deferred<WorkspaceDetail | null>();
		const sessions = deferred<WorkspaceSessionSummary[]>();
		const thread = deferred<ThreadMessageLike[]>();
		vi.mocked(loadWorkspaceDetail).mockImplementation((workspaceId) =>
			workspaceId === "ws-B" ? detail.promise : new Promise(() => {}),
		);
		vi.mocked(loadWorkspaceSessions).mockImplementation((workspaceId) =>
			workspaceId === "ws-B" ? sessions.promise : new Promise(() => {}),
		);
		vi.mocked(loadSessionThreadMessages).mockImplementation((sessionId) =>
			sessionId === "ws-B-session-1" ? thread.promise : new Promise(() => {}),
		);

		const { result } = renderHook(
			() => useSelectionController(buildHookProps({ queryClient })),
			{ wrapper: routerWrapper },
		);

		act(() => {
			result.current.actions.selectWorkspace("ws-A");
		});
		// Cold revisit: the flip's history guess coincides with what the prime
		// will resolve (makeWorkspace's activeSessionId is ws-B-session-1).
		act(() => {
			result.current.actions.rememberSessionSelection("ws-B", "ws-B-session-1");
		});

		const displayedLog: Array<{
			workspaceId: string | null;
			sessionId: string | null;
		}> = [];
		const unsubscribe = result.current.store.subscribe((s) => {
			displayedLog.push({
				workspaceId: s.displayedWorkspaceId,
				sessionId: s.displayedSessionId,
			});
		});

		act(() => {
			result.current.actions.selectWorkspace("ws-B");
		});
		expect(routerSelection().sessionId).toBe("ws-B-session-1");
		act(() => {
			flushFrames();
			vi.advanceTimersByTime(0);
		});
		// Hold window open: the user clicks a session of the HELD old
		// workspace — the divergence branch moves only the router.
		act(() => {
			result.current.actions.selectSession("ws-A-session-2");
		});
		expect(routerSelection().sessionId).toBe("ws-A-session-2");
		expect(result.current.state.displayedWorkspaceId).toBe("ws-A");
		expect(displayedLog).toEqual([]);

		await act(async () => {
			detail.resolve(makeWorkspace("ws-B"));
			sessions.resolve([makeSession("ws-B-session-1", { active: true })]);
			thread.resolve([]);
		});
		await flushPrimeResolution();

		// The repair must compare against the LIVE router (stuck on the
		// foreign session), not the captured guess (equal to the resolved id
		// here) — otherwise the URL stays foreign and selected ≠ displayed
		// forever.
		expect(routerSelection().workspaceId).toBe("ws-B");
		expect(routerSelection().sessionId).toBe("ws-B-session-1");
		expect(displayedLog).toEqual([
			{ workspaceId: "ws-B", sessionId: "ws-B-session-1" },
		]);
		expect(result.current.state.displayedWorkspaceId).toBe("ws-B");
		expect(result.current.state.displayedSessionId).toBe("ws-B-session-1");
		unsubscribe();
	});

	it("resolveDisplayedSession during a hold divergence leaves the paint track untouched", () => {
		const { flushFrames } = installFlipTimingHarness();
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		seedWorkspaceCache(queryClient, "ws-A", [
			makeSession("ws-A-session-1", { active: true }),
			makeSession("ws-A-session-2"),
		]);
		// ws-B stays cold forever (default never-resolving loaders): the hold
		// window stays open for the whole test.
		const { result } = renderHook(
			() => useSelectionController(buildHookProps({ queryClient })),
			{ wrapper: routerWrapper },
		);

		act(() => {
			result.current.actions.selectWorkspace("ws-A");
		});
		act(() => {
			result.current.actions.selectWorkspace("ws-B");
		});
		act(() => {
			flushFrames();
			vi.advanceTimersByTime(0);
		});
		expect(result.current.state.displayedWorkspaceId).toBe("ws-A");

		const displayedLog: Array<string | null> = [];
		const unsubscribe = result.current.store.subscribe((s) => {
			displayedLog.push(s.displayedSessionId);
		});

		// The panel's write-back is about the still-painted old pane; advancing
		// the paint track here would tear the held frame right before the flip
		// overwrites it wholesale.
		act(() => {
			result.current.actions.resolveDisplayedSession("ws-A-session-2");
		});

		expect(result.current.state.displayedWorkspaceId).toBe("ws-A");
		expect(result.current.state.displayedSessionId).toBe("ws-A-session-1");
		expect(displayedLog).toEqual([]);
		unsubscribe();
	});

	it("resolveDisplayedSession keys the session history on the displayed workspace during a flip divergence", () => {
		installFlipTimingHarness();
		const queryClient = new QueryClient();
		seedWorkspaceCache(queryClient, "ws-A", [
			makeSession("ws-A-session-1", { active: true }),
			makeSession("ws-A-session-2"),
		]);
		seedWorkspaceCache(queryClient, "ws-B", [
			makeSession("ws-B-session-1", { active: true }),
		]);
		const { result } = renderHook(
			() => useSelectionController(buildHookProps({ queryClient })),
			{ wrapper: routerWrapper },
		);

		act(() => {
			result.current.actions.selectWorkspace("ws-A");
		});
		act(() => {
			result.current.actions.selectWorkspace("ws-B");
		});
		// Divergence window: router → ws-B, paint track still ws-A. A panel
		// write-back about the still-painted old pane must land in ws-A's
		// history, not pollute ws-B's.
		act(() => {
			result.current.actions.resolveDisplayedSession("ws-A-session-2");
		});

		expect(
			result.current.actions.getSessionSelectionHistory("ws-B"),
		).not.toContain("ws-A-session-2");
		expect(result.current.actions.getSessionSelectionHistory("ws-A")).toContain(
			"ws-A-session-2",
		);
		// Paint-track function: the URL (selected intent) stays untouched.
		expect(routerSelection().workspaceId).toBe("ws-B");
		expect(routerSelection().sessionId).toBe("ws-B-session-1");
	});

	it("openStart wipes selection and switches viewMode; persist=true updates settings", async () => {
		const queryClient = new QueryClient();
		seedWorkspaceCache(queryClient, "ws-A", [makeSession("ws-A-session-1")]);
		const updateSettings = vi.fn();
		const onStartOpened = vi.fn();
		const { result } = renderHook(
			() =>
				useSelectionController(
					buildHookProps({ queryClient, updateSettings, onStartOpened }),
				),
			{ wrapper: routerWrapper },
		);

		act(() => {
			result.current.actions.selectWorkspace("ws-A");
		});
		// Persistence is now the single `onResolved` writer (async). Wait for the
		// ws-A persist to land before clearing so we measure the openStart write
		// in isolation.
		await waitFor(() =>
			expect(updateSettings).toHaveBeenCalledWith(
				expect.objectContaining({
					lastSurface: "workspace",
					lastWorkspaceId: "ws-A",
				}),
			),
		);
		updateSettings.mockClear();

		act(() => {
			result.current.actions.openStart();
		});

		// `selected*` cleared in the router (→ /start, no workspace); `viewMode`
		// reads as "start"; `displayed*` cleared in the store.
		expect(routerSelection().workspaceId).toBeNull();
		expect(result.current.state.displayedWorkspaceId).toBeNull();
		expect(routerSelection().viewMode).toBe("start");
		expect(onStartOpened).toHaveBeenCalledWith({ persist: true });
		await waitFor(() =>
			expect(updateSettings).toHaveBeenCalledWith({
				lastSurface: "workspace-start",
			}),
		);
	});

	it("openStart with persist=false skips the settings write but still fires onStartOpened", async () => {
		const updateSettings = vi.fn();
		const onStartOpened = vi.fn();
		const { result } = renderHook(
			() =>
				useSelectionController(
					buildHookProps({ updateSettings, onStartOpened }),
				),
			{ wrapper: routerWrapper },
		);

		act(() => {
			result.current.actions.openStart({ persist: false });
		});

		// `onStartOpened` fires synchronously; the `persist: false` one-shot
		// suppression keeps the `onResolved` writer from persisting `/start`.
		expect(onStartOpened).toHaveBeenCalledWith({ persist: false });
		// Give the async `onResolved` writer a chance to (wrongly) fire, then
		// assert it never wrote the start surface.
		await Promise.resolve();
		await Promise.resolve();
		expect(updateSettings).not.toHaveBeenCalledWith(
			expect.objectContaining({ lastSurface: "workspace-start" }),
		);
	});

	it("rememberSessionSelection caps history at the configured maximum", () => {
		const { result } = renderHook(
			() => useSelectionController(buildHookProps()),
			{ wrapper: routerWrapper },
		);

		for (let i = 0; i < 30; i += 1) {
			act(() => {
				result.current.actions.rememberSessionSelection("ws-A", `session-${i}`);
			});
		}

		const history = result.current.actions.getSessionSelectionHistory("ws-A");
		expect(history.length).toBeLessThanOrEqual(16);
		expect(history[history.length - 1]).toBe("session-29");
	});

	it("rememberSessionSelection moves an existing id to the tail (LRU semantics)", () => {
		const { result } = renderHook(
			() => useSelectionController(buildHookProps()),
			{ wrapper: routerWrapper },
		);

		act(() => {
			result.current.actions.rememberSessionSelection("ws-A", "session-1");
			result.current.actions.rememberSessionSelection("ws-A", "session-2");
			result.current.actions.rememberSessionSelection("ws-A", "session-1");
		});

		const history = result.current.actions.getSessionSelectionHistory("ws-A");
		expect(history).toEqual(["session-2", "session-1"]);
	});

	it("navigateWorkspaces uses the flattened sidebar order across groups + archived", () => {
		const queryClient = new QueryClient();
		seedWorkspaceCache(queryClient, "ws-A", [makeSession("ws-A-session-1")]);
		seedWorkspaceCache(queryClient, "ws-B", [makeSession("ws-B-session-1")]);
		seedWorkspaceCache(queryClient, "ws-C", [makeSession("ws-C-session-1")]);

		const workspaceGroups: WorkspaceGroup[] = [
			{
				tone: "progress",
				rows: [
					{ id: "ws-A" } as WorkspaceRow,
					{ id: "ws-B" } as WorkspaceRow,
					{ id: "ws-C" } as WorkspaceRow,
				],
			} as WorkspaceGroup,
		];

		const { result } = renderHook(
			() =>
				useSelectionController(
					buildHookProps({ queryClient, workspaceGroups }),
				),
			{ wrapper: routerWrapper },
		);

		act(() => {
			result.current.actions.selectWorkspace("ws-A");
		});
		act(() => {
			result.current.actions.navigateWorkspaces(1);
		});

		expect(routerSelection().workspaceId).toBe("ws-B");

		act(() => {
			result.current.actions.navigateWorkspaces(1);
		});
		expect(routerSelection().workspaceId).toBe("ws-C");

		act(() => {
			result.current.actions.navigateWorkspaces(1);
		});
		// At the end of the list, navigateWorkspaces is a no-op.
		expect(routerSelection().workspaceId).toBe("ws-C");
	});

	it("getSnapshot reflects the most recent selection synchronously inside actions", () => {
		const queryClient = new QueryClient();
		seedWorkspaceCache(queryClient, "ws-A", [makeSession("ws-A-session-1")]);
		seedWorkspaceCache(queryClient, "ws-B", [makeSession("ws-B-session-1")]);

		const { result } = renderHook(
			() => useSelectionController(buildHookProps({ queryClient })),
			{ wrapper: routerWrapper },
		);

		act(() => {
			result.current.actions.selectWorkspace("ws-A");
		});
		expect(result.current.actions.getSnapshot()).toEqual({
			workspaceId: "ws-A",
			sessionId: "ws-A-session-1",
			viewMode: "conversation",
		});

		act(() => {
			result.current.actions.selectWorkspace("ws-B");
		});
		expect(result.current.actions.getSnapshot().workspaceId).toBe("ws-B");
	});

	it("actions reference is stable across renders", () => {
		const { result, rerender } = renderHook(
			() => useSelectionController(buildHookProps()),
			{ wrapper: routerWrapper },
		);

		const initialActions = result.current.actions;
		rerender();
		expect(result.current.actions).toBe(initialActions);
	});
});
