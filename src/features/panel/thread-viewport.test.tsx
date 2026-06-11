import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadMessageLike } from "@/lib/api";
import { createHelmorQueryClient } from "@/lib/query-client";
import {
	ActiveThreadViewport,
	type PresentedSessionPane,
} from "./thread-viewport";

vi.mock("streamdown", () => ({
	Streamdown: ({ children }: { children?: React.ReactNode }) => (
		<div>{children}</div>
	),
	defaultRehypePlugins: { raw: () => {}, harden: () => {} },
}));

vi.mock("@/components/streamdown-components", () => ({
	streamdownComponents: {},
}));

// Deterministic row heights for the tail-window tests: every message
// estimates to exactly 100px so the window math is integer-exact in jsdom.
// (The content-visibility test below doesn't assert heights.)
vi.mock("@/lib/message-layout-estimator", () => ({
	estimateThreadRowHeights: (data: unknown[]) => data.map(() => 100),
}));

function message(id: string, streaming = false): ThreadMessageLike {
	return {
		id,
		role: "assistant",
		createdAt: new Date(0).toISOString(),
		streaming,
		content: [{ type: "text", text: `message ${id}` }],
	};
}

describe("ActiveThreadViewport", () => {
	afterEach(() => cleanup());

	it("keeps content-visibility disabled for conversation rows", async () => {
		const messages = Array.from({ length: 13 }, (_, index) =>
			message(`history-${index}`),
		);
		messages.push(message("streaming-tail", true));

		const pane: PresentedSessionPane = {
			sessionId: "session-1",
			messages,
			sending: true,
			hasLoaded: true,
			presentationState: "presented",
		};

		render(
			<QueryClientProvider client={createHelmorQueryClient()}>
				<ActiveThreadViewport hasSession pane={pane} />
			</QueryClientProvider>,
		);

		const historyRow = await screen.findByText("message history-0");
		const streamingRow = await screen.findByText("message streaming-tail");

		expect(historyRow.closest(".flow-root")).not.toHaveStyle({
			contentVisibility: "auto",
		});
		expect(streamingRow.closest(".flow-root")).not.toHaveStyle({
			contentVisibility: "auto",
		});
	});
});

// ---------------------------------------------------------------------------
// First-frame tail window
//
// Near the bottom, visibleRows mounts a small bottom tail (1.5x viewport)
// UNIONED with the regular scroll window — NOT a 6x full slice. A row taller
// than the window that sits above it stays unmounted: its under-estimated
// height stays in the container, and the correction is absorbed by the
// deferred upward-scroll adjustment if it later mounts. No flash at switch
// (nothing mounts/corrects there) and no visible jump on scroll-up.
//
// Fixture: 100 user-role messages (user messages render synchronously — no
// lazy streamdown), estimator mocked to 100px/row, offsetHeight pinned to
// 100px so MeasuredConversationRow's mount-time report matches the estimate
// and no measured-height churn perturbs the math. jsdom clientHeight is 0, so
// the viewport takes the 900px fallback path. After the initial-scroll effect
// pins the bottom:
//   totalRowsHeight 10000, header 24, spacer 40 → scrollTop 10064
//   effectiveScrollTop 10040, buffer 900 → windowTop 9140
//   tail = 1.5 x 900 = 1350 → tailTop 8650; union min(8650, 9140) = 8650
//   → rows 86..99 (14 rows). At the bottom windowTop > tailTop so the pure
//     tail binds; the scroll-window union only widens the mount upward once
//     scrolled up (windowTop < tailTop) — see the scroll-up union test.
// ---------------------------------------------------------------------------

function range(first: number, last: number): number[] {
	return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}

function userMessage(id: string, text: string): ThreadMessageLike {
	return {
		id,
		role: "user",
		createdAt: new Date(0).toISOString(),
		content: [{ type: "text", text }],
	} as ThreadMessageLike;
}

function makePane(
	sessionId: string,
	prefix: string,
	count: number,
): PresentedSessionPane {
	return {
		sessionId,
		messages: Array.from({ length: count }, (_, index) =>
			userMessage(`${prefix}-${index}`, `${prefix}:${index}`),
		),
		sending: false,
		hasLoaded: true,
		presentationState: "presented",
	};
}

function mountedIndices(prefix: string): number[] {
	return Array.from(document.querySelectorAll("p"))
		.map((node) => node.textContent ?? "")
		.filter((text) => text.startsWith(`${prefix}:`))
		.map((text) => Number(text.slice(prefix.length + 1)))
		.sort((a, b) => a - b);
}

// The Stage 2 invariant: the first-frame mount is a SMALL window pinned to the
// bottom — not the old 6x slice (55 rows, 45..99). The exact top row shifts a
// few indices with the union / initial-scroll timing (synthetic vs applied
// bottom: 86..99 once the initial-scroll effect runs, 81..99 on the synthetic
// switch anchor), so assert the shape, not an exact array.
function assertSmallBottomTail(mounted: number[]) {
	expect(mounted).toContain(99); // bottom pinned
	expect(mounted.length).toBeGreaterThanOrEqual(12);
	expect(mounted.length).toBeLessThanOrEqual(22);
	expect(Math.min(...mounted)).toBeGreaterThanOrEqual(78);
	for (let i = 1; i < mounted.length; i += 1) {
		expect(mounted[i]).toBe(mounted[i - 1]! + 1); // contiguous to the bottom
	}
}

function renderPane(pane: PresentedSessionPane) {
	const queryClient = createHelmorQueryClient();
	const rendered = render(
		<QueryClientProvider client={queryClient}>
			<ActiveThreadViewport hasSession pane={pane} />
		</QueryClientProvider>,
	);
	const rerenderPane = (nextPane: PresentedSessionPane) => {
		rendered.rerender(
			<QueryClientProvider client={queryClient}>
				<ActiveThreadViewport hasSession pane={nextPane} />
			</QueryClientProvider>,
		);
	};
	return { rerenderPane };
}

describe("first-frame tail window", () => {
	const originalOffsetHeight = Object.getOwnPropertyDescriptor(
		HTMLElement.prototype,
		"offsetHeight",
	);
	const originalRequestAnimationFrame = window.requestAnimationFrame;
	const originalCancelAnimationFrame = window.cancelAnimationFrame;
	let frameCallbacks: Map<number, FrameRequestCallback>;

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
			configurable: true,
			get() {
				return 100;
			},
		});
		// Manual-flush rAF stub (same pattern as the selection-controller
		// harness) so the expansion schedule only fires under test control.
		frameCallbacks = new Map();
		let nextFrameId = 1;
		Object.defineProperty(window, "requestAnimationFrame", {
			configurable: true,
			writable: true,
			value: (callback: FrameRequestCallback) => {
				const id = nextFrameId;
				nextFrameId += 1;
				frameCallbacks.set(id, callback);
				return id;
			},
		});
		Object.defineProperty(window, "cancelAnimationFrame", {
			configurable: true,
			writable: true,
			value: (id: number) => {
				frameCallbacks.delete(id);
			},
		});
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		if (originalOffsetHeight) {
			Object.defineProperty(
				HTMLElement.prototype,
				"offsetHeight",
				originalOffsetHeight,
			);
		}
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
	});

	it("mounts a small bottom tail on the first frame (not a 6x slice), including after a session switch", () => {
		const { rerenderPane } = renderPane(makePane("s1", "m1", 100));
		// The first commit mounts a small bottom window — not the old 6x slice,
		// and no narrow-then-expand step.
		assertSmallBottomTail(mountedIndices("m1"));

		rerenderPane(makePane("s2", "m2", 100));
		assertSmallBottomTail(mountedIndices("m2"));
	});

	it("does NOT eagerly mount a giant row above the tail window (cheap switch)", () => {
		// The inverse of the old 6x behavior. A row far above the bottom
		// window — e.g. a multi-hundred-line pasted-code message — must NOT
		// mount on the switch frame: mounting it would rebuild thousands of
		// off-screen DOM nodes per switch (the bulk of the old switch jank).
		// Leaving it unmounted is safe because nothing mounts/corrects at the
		// bottom on switch (no flash), and a later scroll-up mounts it under
		// the deferred upward-scroll correction (no visible jump — verified in
		// the live app). m1:50 estimates to 100px at content [5000,5100], far
		// above the tail top (8650), so it stays unmounted while the bottom
		// rows 86..99 mount.
		renderPane(makePane("s1", "m1", 100));
		const mounted = mountedIndices("m1");
		expect(mounted).not.toContain(50);
		assertSmallBottomTail(mounted);
	});

	it("widens the mount upward via the scroll-window union on scroll-up (no blank gap)", () => {
		// Locks the union in resolveStableBottomTailHeight's caller: at the
		// bottom the small tail binds, but scrolling up drops windowTop below
		// tailTop, so the mount must extend from windowTop down to the bottom —
		// otherwise the visible region (now above the pure tail) is unmounted
		// and paints blank. (scrollHeight is left unstubbed = 0 so the settle
		// pin's `scrollHeight > 0` guard keeps it inert and our scrollTop holds.)
		renderPane(makePane("s1", "m1", 100));
		assertSmallBottomTail(mountedIndices("m1"));

		const scroller = document.querySelector(
			".conversation-scroll-viewport",
		) as HTMLElement;
		Object.defineProperty(scroller, "clientHeight", {
			configurable: true,
			get: () => 900,
		});

		// Scroll up ~3000px from the synthetic bottom. windowTop = 6976 - 900 =
		// 6076 < tailTop 8650, so the union mounts rows 60..99.
		act(() => {
			scroller.scrollTop = 7000;
			scroller.dispatchEvent(new Event("scroll"));
			for (const [id, callback] of [...frameCallbacks]) {
				frameCallbacks.delete(id);
				callback(performance.now());
			}
		});

		const scrolledUp = mountedIndices("m1");
		// Union widened the mount above the pure-tail floor (86)…
		expect(Math.min(...scrolledUp)).toBeLessThan(80);
		// …and the bottom stayed mounted, contiguous — no blank gap anywhere.
		expect(scrolledUp).toContain(99);
		for (let i = 1; i < scrolledUp.length; i += 1) {
			expect(scrolledUp[i]).toBe(scrolledUp[i - 1]! + 1);
		}
	});

	it("leaves the plain (<=12 message) path untouched across a session switch", () => {
		const { rerenderPane } = renderPane(makePane("p1", "n1", 10));
		expect(mountedIndices("n1")).toEqual(range(0, 9));

		rerenderPane(makePane("p2", "n2", 10));
		// Plain list: every row mounts synchronously — no tail window at all.
		expect(mountedIndices("n2")).toEqual(range(0, 9));
	});

	it("keeps the true bottom pinned through a measurement wave during the initial settle", () => {
		// Regression lock for the post-switch region flashing: a late
		// measurement wave grows the scroll height in its own commit; during
		// the initial settle the viewport must re-pin the true bottom in the
		// same commit's layout pass, before paint.
		const { rerenderPane } = renderPane(makePane("s2", "m2", 100));
		const scroller = document.querySelector(
			".conversation-scroll-viewport",
		) as HTMLElement;
		expect(scroller).not.toBeNull();
		// jsdom has no layout: stub the geometry the pin reads.
		Object.defineProperty(scroller, "scrollHeight", {
			configurable: true,
			get: () => 10064,
		});
		Object.defineProperty(scroller, "clientHeight", {
			configurable: true,
			get: () => 900,
		});
		scroller.scrollTop = 0;

		// Re-render the SAME session with fresh message refs: the rows memo
		// recomputes → visibleRows changes → the settle pin re-runs (no user
		// scroll, so the initial-settle regime is still active) and lands the
		// scroller at the true measured bottom.
		act(() => {
			rerenderPane(makePane("s2", "m2", 100));
		});
		expect(scroller.scrollTop).toBe(9164);
	});
});
