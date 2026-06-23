import { QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
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
// USER_MESSAGE_CLAMP_LINES is re-exported because ChatUserMessage reads the
// shared clamp gate from this module; the fixture's one-line messages never
// reach it.
vi.mock("@/lib/message-layout-estimator", () => ({
	estimateThreadRowHeights: (data: unknown[]) => data.map(() => 100),
	USER_MESSAGE_CLAMP_LINES: 20,
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

	it("compensates an anchored expand exactly once (toggle anchor + viewport must not double-apply)", () => {
		// Controllable RO so the test can fire the toggled row's height change
		// the way the browser would after the expand reflow.
		const observed = new Map<Element, ResizeObserverCallback>();
		class ControlledResizeObserver {
			private readonly callback: ResizeObserverCallback;
			constructor(callback: ResizeObserverCallback) {
				this.callback = callback;
			}
			observe(element: Element) {
				observed.set(element, this.callback);
			}
			unobserve(element: Element) {
				observed.delete(element);
			}
			disconnect() {}
		}
		const originalResizeObserver = window.ResizeObserver;
		window.ResizeObserver =
			ControlledResizeObserver as unknown as typeof ResizeObserver;
		globalThis.ResizeObserver = window.ResizeObserver;
		// Truncation-probe geometry: clamped bodies report cut-off content so
		// every user message renders its Show more control.
		Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
			configurable: true,
			get() {
				return 980;
			},
		});
		Object.defineProperty(HTMLElement.prototype, "clientHeight", {
			configurable: true,
			get(this: HTMLElement) {
				const clamped = this.style?.webkitLineClamp !== "";
				return clamped ? 560 : 980;
			},
		});

		try {
			renderPane(makePane("s1", "m1", 100));
			const scroller = document.querySelector(
				".conversation-scroll-viewport",
			) as HTMLElement;
			// Instance stubs shadow the prototype ones: scrollHeight 0 keeps the
			// settle pin inert (same trick as the scroll-up union test).
			Object.defineProperty(scroller, "scrollHeight", {
				configurable: true,
				get: () => 0,
			});
			Object.defineProperty(scroller, "clientHeight", {
				configurable: true,
				get: () => 900,
			});

			// Scrollbar-drag to mid-thread: a plain scroll event, no wheel —
			// hasUserScrolledRef stays false, so pending adjustments DO apply.
			act(() => {
				scroller.scrollTop = 7000;
				scroller.dispatchEvent(new Event("scroll"));
				for (const [id, callback] of [...frameCallbacks]) {
					frameCallbacks.delete(id);
					callback(performance.now());
				}
			});

			// Row 65 (top 6500) starts above the viewport top — the row whose
			// growth the viewport would normally compensate for.
			const control = document.querySelector(
				'[data-message-id="m1-65"] button[aria-expanded]',
			) as HTMLElement;
			expect(control).not.toBeNull();
			fireEvent.click(control);

			const messageText = screen.getByText("m1:65");
			const rowEl = [...observed.keys()].find(
				(el) =>
					(el as HTMLElement).style.position === "absolute" &&
					el.contains(messageText),
			);
			expect(rowEl).toBeDefined();
			const fireRowResize = (height: number) => {
				const callback = observed.get(rowEl as Element);
				act(() => {
					callback?.(
						[
							{
								borderBoxSize: [{ blockSize: height, inlineSize: 600 }],
								contentRect: { height },
							} as unknown as ResizeObserverEntry,
						],
						{} as ResizeObserver,
					);
				});
			};

			// The toggle's own reflow (100 → 600): the click anchor already
			// offset the scroller, so the viewport must NOT add the delta again.
			fireRowResize(600);
			expect(scroller.scrollTop).toBe(7000);

			// A later non-toggle growth of the same above-viewport row still
			// compensates — the legit path is unregressed.
			fireRowResize(700);
			expect(scroller.scrollTop).toBe(7100);
		} finally {
			window.ResizeObserver = originalResizeObserver;
			globalThis.ResizeObserver = originalResizeObserver;
			delete (HTMLElement.prototype as { scrollHeight?: unknown }).scrollHeight;
			delete (HTMLElement.prototype as { clientHeight?: unknown }).clientHeight;
		}
	});

	it("compensates deferred height corrections after a wheel scroll-up settles (no drift)", () => {
		// Regression lock for the scroll-up drift: while the user actively scrolls
		// up (hasUserScrolledRef=true via wheel, isUserScrollingRef=true), the rows
		// that mount above the viewport report their measured height through the
		// DEFERRED path, and that correction is flushed 120ms AFTER the scroll
		// settles. The flush must compensate scrollTop for the above-viewport
		// height delta — otherwise every row below shifts and the reading position
		// drifts the moment the scroll ends.
		const observed = new Map<Element, ResizeObserverCallback>();
		class ControlledResizeObserver {
			private readonly callback: ResizeObserverCallback;
			constructor(callback: ResizeObserverCallback) {
				this.callback = callback;
			}
			observe(element: Element) {
				observed.set(element, this.callback);
			}
			unobserve(element: Element) {
				observed.delete(element);
			}
			disconnect() {}
		}
		const originalResizeObserver = window.ResizeObserver;
		window.ResizeObserver =
			ControlledResizeObserver as unknown as typeof ResizeObserver;
		globalThis.ResizeObserver = window.ResizeObserver;

		try {
			renderPane(makePane("s1", "m1", 100));
			const scroller = document.querySelector(
				".conversation-scroll-viewport",
			) as HTMLElement;
			// scrollHeight 0 keeps the settle pin inert; clientHeight 900 drives the
			// window math (same trick as the scroll-up union test).
			Object.defineProperty(scroller, "scrollHeight", {
				configurable: true,
				get: () => 0,
			});
			Object.defineProperty(scroller, "clientHeight", {
				configurable: true,
				get: () => 900,
			});

			// Wheel scroll-up to mid-thread: the wheel escapes the bottom lock
			// (hasUserScrolledRef=true) and the scroll event marks the viewport as
			// actively scrolling (isUserScrollingRef=true), so the next height
			// report is DEFERRED rather than applied inline.
			act(() => {
				scroller.dispatchEvent(
					new WheelEvent("wheel", { bubbles: true, deltaY: -200 }),
				);
				scroller.scrollTop = 7000;
				scroller.dispatchEvent(new Event("scroll"));
				for (const [id, callback] of [...frameCallbacks]) {
					frameCallbacks.delete(id);
					callback(performance.now());
				}
			});

			// Row 65 (top 6500) sits above the viewport top (7000) and mounts under
			// the scroll-up union. Its real height (300) is taller than its 100px
			// estimate — the exact estimate→measured gap that shifts the rows below.
			const messageText = screen.getByText("m1:65");
			const rowEl = [...observed.keys()].find(
				(el) =>
					(el as HTMLElement).style.position === "absolute" &&
					el.contains(messageText),
			);
			expect(rowEl).toBeDefined();
			const fireRowResize = (height: number) => {
				const callback = observed.get(rowEl as Element);
				act(() => {
					callback?.(
						[
							{
								borderBoxSize: [{ blockSize: height, inlineSize: 600 }],
								contentRect: { height },
							} as unknown as ResizeObserverEntry,
						],
						{} as ResizeObserver,
					);
				});
			};

			// Deferred while actively scrolling: the correction must NOT apply yet.
			fireRowResize(300);
			expect(scroller.scrollTop).toBe(7000);

			// Scroll settles: the 120ms idle timer flushes the deferred height. The
			// above-viewport row grew by 200px, so scrollTop must grow by 200 to
			// hold the reading position — otherwise the content drifts down 200px.
			act(() => {
				vi.advanceTimersByTime(120);
			});
			expect(scroller.scrollTop).toBe(7200);
		} finally {
			window.ResizeObserver = originalResizeObserver;
			globalThis.ResizeObserver = originalResizeObserver;
		}
	});

	it("commits an in-view height correction within the scroll frame, not at the post-stop idle", () => {
		// First-principles "no shake" lock: a row's measured height must commit
		// WHILE the scroll is still moving (like react-virtuoso / TanStack Virtual
		// measuring synchronously), so by the time the scroll STOPS there is
		// nothing left to reflow. The old behavior deferred every correction to a
		// 120ms post-stop idle flush — which is exactly the visible "pop".
		const observed = new Map<Element, ResizeObserverCallback>();
		class ControlledResizeObserver {
			private readonly callback: ResizeObserverCallback;
			constructor(callback: ResizeObserverCallback) {
				this.callback = callback;
			}
			observe(element: Element) {
				observed.set(element, this.callback);
			}
			unobserve(element: Element) {
				observed.delete(element);
			}
			disconnect() {}
		}
		const originalResizeObserver = window.ResizeObserver;
		window.ResizeObserver =
			ControlledResizeObserver as unknown as typeof ResizeObserver;
		globalThis.ResizeObserver = window.ResizeObserver;

		try {
			renderPane(makePane("s1", "m1", 100));
			const scroller = document.querySelector(
				".conversation-scroll-viewport",
			) as HTMLElement;
			Object.defineProperty(scroller, "scrollHeight", {
				configurable: true,
				get: () => 0,
			});
			Object.defineProperty(scroller, "clientHeight", {
				configurable: true,
				get: () => 900,
			});

			const commitScrollFrame = () => {
				act(() => {
					scroller.dispatchEvent(
						new WheelEvent("wheel", { bubbles: true, deltaY: -200 }),
					);
					scroller.scrollTop = 7000;
					scroller.dispatchEvent(new Event("scroll"));
					for (const [id, callback] of [...frameCallbacks]) {
						frameCallbacks.delete(id);
						callback(performance.now());
					}
				});
			};

			commitScrollFrame();

			const absRowFor = (id: string) =>
				[...observed.keys()].find(
					(el) =>
						(el as HTMLElement).style.position === "absolute" &&
						el.contains(screen.getByText(id)),
				) as HTMLElement | undefined;

			const reference = absRowFor("m1:78");
			expect(reference).toBeDefined();
			const refScreenTop = () =>
				parseFloat((reference as HTMLElement).style.top) - scroller.scrollTop;

			// Row m1:73 (above the reference, in view) measures taller than estimate.
			const correctingRow = absRowFor("m1:73");
			expect(correctingRow).toBeDefined();
			act(() => {
				observed.get(correctingRow as Element)?.(
					[
						{
							borderBoxSize: [{ blockSize: 280, inlineSize: 600 }],
							contentRect: { height: 280 },
						} as unknown as ResizeObserverEntry,
					],
					{} as ResizeObserver,
				);
			});

			// Another scroll frame fires while still moving: the correction must
			// commit HERE so the reference row reaches its final place mid-motion.
			commitScrollFrame();
			const duringScroll = refScreenTop();

			// The scroll stops: the idle flush must have nothing left to apply, so
			// the reference row does NOT move after the motion ends.
			act(() => {
				vi.advanceTimersByTime(120);
			});
			const afterStop = refScreenTop();

			expect(afterStop).toBe(duringScroll);
		} finally {
			window.ResizeObserver = originalResizeObserver;
			globalThis.ResizeObserver = originalResizeObserver;
		}
	});

	it("compensates an above-viewport correction within the scroll frame (no drift, no post-stop pop)", () => {
		// Characterization lock for the whole "no shake" contract in one test:
		// during a scroll-up, an above-viewport row measuring taller must (1) commit
		// WITHIN the scroll frame, (2) compensate scrollTop by exactly its delta so a
		// visible reference row does NOT move, and (3) leave nothing to flush at the
		// post-stop idle. If a refactor regresses any of these, this fails.
		const observed = new Map<Element, ResizeObserverCallback>();
		class ControlledResizeObserver {
			private readonly callback: ResizeObserverCallback;
			constructor(callback: ResizeObserverCallback) {
				this.callback = callback;
			}
			observe(element: Element) {
				observed.set(element, this.callback);
			}
			unobserve(element: Element) {
				observed.delete(element);
			}
			disconnect() {}
		}
		const originalResizeObserver = window.ResizeObserver;
		window.ResizeObserver =
			ControlledResizeObserver as unknown as typeof ResizeObserver;
		globalThis.ResizeObserver = window.ResizeObserver;

		try {
			renderPane(makePane("s1", "m1", 100));
			const scroller = document.querySelector(
				".conversation-scroll-viewport",
			) as HTMLElement;
			Object.defineProperty(scroller, "scrollHeight", {
				configurable: true,
				get: () => 0,
			});
			Object.defineProperty(scroller, "clientHeight", {
				configurable: true,
				get: () => 900,
			});

			const commitScrollFrame = () => {
				act(() => {
					scroller.dispatchEvent(
						new WheelEvent("wheel", { bubbles: true, deltaY: -200 }),
					);
					scroller.scrollTop = 7000;
					scroller.dispatchEvent(new Event("scroll"));
					for (const [id, callback] of [...frameCallbacks]) {
						frameCallbacks.delete(id);
						callback(performance.now());
					}
				});
			};

			commitScrollFrame();

			const absRowFor = (id: string) =>
				[...observed.keys()].find(
					(el) =>
						(el as HTMLElement).style.position === "absolute" &&
						el.contains(screen.getByText(id)),
				) as HTMLElement | undefined;

			const reference = absRowFor("m1:78");
			expect(reference).toBeDefined();
			const refScreenTop = () =>
				parseFloat((reference as HTMLElement).style.top) - scroller.scrollTop;
			const before = refScreenTop();

			// m1:65 (top 6500) sits ABOVE the viewport top (7000) but is mounted.
			const aboveRow = absRowFor("m1:65");
			expect(aboveRow).toBeDefined();
			act(() => {
				observed.get(aboveRow as Element)?.(
					[
						{
							borderBoxSize: [{ blockSize: 300, inlineSize: 600 }],
							contentRect: { height: 300 },
						} as unknown as ResizeObserverEntry,
					],
					{} as ResizeObserver,
				);
			});

			commitScrollFrame();
			// Compensated within the frame: scrollTop grew by the +200 delta and the
			// visible reference row held its screen position.
			expect(scroller.scrollTop).toBe(7200);
			expect(refScreenTop()).toBe(before);

			// Scroll stops: nothing left to flush, so nothing moves.
			act(() => {
				vi.advanceTimersByTime(120);
			});
			expect(scroller.scrollTop).toBe(7200);
			expect(refScreenTop()).toBe(before);
		} finally {
			window.ResizeObserver = originalResizeObserver;
			globalThis.ResizeObserver = originalResizeObserver;
		}
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
