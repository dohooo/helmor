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
// First-frame tail window (B2)
//
// Fixture: 100 user-role messages (user messages render synchronously — no
// lazy streamdown), estimator mocked to 100px/row, offsetHeight pinned to
// 100px so MeasuredConversationRow's mount-time report matches the estimate
// and no measured-height churn perturbs the math. jsdom clientHeight is 0, so
// the viewport takes the 900px fallback path:
//   totalRowsHeight 10000, header 24, spacer 40 → bottom scrollTop 10064
//   expanded tail  = 6 x 900 = 5400 → tailTop 4600 → rows 45..99 (55 rows)
//   narrow tail    = 1.5 x 900 = 1350 → tailTop 8650 → rows 86..99 (14 rows)
// On a SESSION SWITCH between equal-height threads the initial-scroll effect
// doesn't re-run (deps unchanged), so the first frame keeps the synthetic
// bottom anchor: effScrollTop 9100 → regular windowTop 8200 < narrow tailTop
// 8650 → the 1.5x∪regular union mounts rows 81..99 (19 rows).
// The EXPANDED set below was captured from the component's behavior BEFORE
// the tailExpanded change (first/last/count: m:45 / m:99 / 55).
// ---------------------------------------------------------------------------

const CAPTURED_EXPANDED_TAIL_INDICES = range(45, 99);
const NARROW_TAIL_INDICES = range(86, 99);
const NARROW_UNION_AT_SYNTHETIC_ANCHOR_INDICES = range(81, 99);

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

	it("mounts only the 1.5x tail on the first frame after a session switch, then expands to the captured 6x set", () => {
		const { rerenderPane } = renderPane(makePane("s1", "m1", 100));
		// Let the first session expand (48ms fallback path).
		act(() => {
			vi.advanceTimersByTime(48);
		});
		expect(mountedIndices("m1")).toEqual(CAPTURED_EXPANDED_TAIL_INDICES);

		rerenderPane(makePane("s2", "m2", 100));
		// First frame for the new session: exactly the 1.5x∪regular union —
		// far below the 55-row expanded set, but never less than the regular
		// scroll window around the synthetic bottom anchor.
		expect(mountedIndices("m2")).toEqual(
			NARROW_UNION_AT_SYNTHETIC_ANCHOR_INDICES,
		);

		// After the expansion schedule flushes, the mounted set equals the
		// pre-change 6x behavior captured above.
		act(() => {
			vi.advanceTimersByTime(48);
		});
		expect(mountedIndices("m2")).toEqual(CAPTURED_EXPANDED_TAIL_INDICES);
	});

	it("expands exactly once via the rAF path too", () => {
		renderPane(makePane("s1", "m1", 100));
		expect(mountedIndices("m1")).toEqual(NARROW_TAIL_INDICES);

		// rAF wins the race; the 48ms timer must then be a no-op.
		act(() => {
			for (const [id, callback] of [...frameCallbacks]) {
				frameCallbacks.delete(id);
				callback(performance.now());
			}
		});
		expect(mountedIndices("m1")).toEqual(CAPTURED_EXPANDED_TAIL_INDICES);
		act(() => {
			vi.advanceTimersByTime(48);
		});
		expect(mountedIndices("m1")).toEqual(CAPTURED_EXPANDED_TAIL_INDICES);
	});

	it("keeps visible rows mounted when the user scrolls up before the expansion lands", () => {
		renderPane(makePane("s1", "m1", 100));
		expect(mountedIndices("m1")).toEqual(NARROW_TAIL_INDICES);

		const scrollParent = document.querySelector(
			".conversation-scroll-viewport",
		) as HTMLElement;
		expect(scrollParent).toBeTruthy();

		// Scroll up 2x viewport (10064 → 8264) before the expansion fires.
		// Flush ONLY the scroll-commit rAF (registered by the scroll listener
		// after this snapshot), keeping the expansion's rAF pending.
		const framesBeforeScroll = new Set(frameCallbacks.keys());
		scrollParent.scrollTop = 8264;
		act(() => {
			scrollParent.dispatchEvent(new Event("scroll"));
		});
		act(() => {
			for (const [id, callback] of [...frameCallbacks]) {
				if (framesBeforeScroll.has(id)) continue;
				frameCallbacks.delete(id);
				callback(performance.now());
			}
		});

		// Union protection: the still-narrow tail window unions with the
		// regular scroll window (windowTop 7340 < narrow tailTop 8650), so
		// every visible row (82..91) stays mounted — no blank region.
		const mounted = new Set(mountedIndices("m1"));
		for (let index = 82; index <= 91; index += 1) {
			expect(mounted.has(index)).toBe(true);
		}
		expect(mounted.has(73)).toBe(true); // union window lower bound
		expect(mounted.has(72)).toBe(false); // still narrow — not the full 6x
		expect(mounted.has(99)).toBe(true); // tail stays mounted

		// Expansion still lands afterwards and widens to the full 6x window.
		act(() => {
			vi.advanceTimersByTime(48);
		});
		const expanded = new Set(mountedIndices("m1"));
		expect(expanded.has(45)).toBe(true);
		expect(expanded.has(44)).toBe(false);
		for (let index = 82; index <= 91; index += 1) {
			expect(expanded.has(index)).toBe(true);
		}
	});

	it("leaves the plain (<=12 message) path untouched across a session switch", () => {
		const { rerenderPane } = renderPane(makePane("p1", "n1", 10));
		expect(mountedIndices("n1")).toEqual(range(0, 9));

		rerenderPane(makePane("p2", "n2", 10));
		// Plain list: every row mounts synchronously — no tail window at all.
		expect(mountedIndices("n2")).toEqual(range(0, 9));
	});

	it("keeps the true bottom pinned through the expansion wave during the initial settle", () => {
		// Regression lock for the post-switch region flashing: the expansion
		// (and any measurement wave) grows the scroll height in its own
		// commit; during the initial settle the viewport must re-pin the true
		// bottom in the same commit's layout pass, before paint.
		const { rerenderPane } = renderPane(makePane("s1", "m1", 100));
		act(() => {
			vi.advanceTimersByTime(48);
		});

		rerenderPane(makePane("s2", "m2", 100));
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

		// Expansion commit lands (48ms fallback) — the settle pin must put the
		// scroller at the true bottom within the same flush.
		act(() => {
			vi.advanceTimersByTime(48);
		});
		expect(scroller.scrollTop).toBe(9164);
	});
});
