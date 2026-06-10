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
// The first commit of a session mounts the full 6x-viewport bottom tail (not a
// narrower slice): a row taller than the slice that sits just above it must be
// measured on frame one, or its under-estimated height stays in the container
// height until it mounts a frame later — that late correction re-pins the
// bottom AFTER paint and flashes.
//
// Fixture: 100 user-role messages (user messages render synchronously — no
// lazy streamdown), estimator mocked to 100px/row, offsetHeight pinned to
// 100px so MeasuredConversationRow's mount-time report matches the estimate
// and no measured-height churn perturbs the math. jsdom clientHeight is 0, so
// the viewport takes the 900px fallback path:
//   totalRowsHeight 10000, header 24, spacer 40 → bottom scrollTop 10064
//   tail = 6 x 900 = 5400 → tailTop 4600 → rows 45..99 (55 rows)
// ---------------------------------------------------------------------------

const TAIL_INDICES = range(45, 99);

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

	it("mounts the full 6x tail on the first frame, including after a session switch", () => {
		const { rerenderPane } = renderPane(makePane("s1", "m1", 100));
		// No expansion step — the first commit already mounts the 6x tail.
		expect(mountedIndices("m1")).toEqual(TAIL_INDICES);

		rerenderPane(makePane("s2", "m2", 100));
		expect(mountedIndices("m2")).toEqual(TAIL_INDICES);
	});

	it("mounts a row taller than the tail slice on the first frame so its measurement lands pre-paint", () => {
		// The flash this guards against: a row under-estimated by the layout
		// estimator (e.g. a multi-hundred-line pasted-code message) must mount
		// — and therefore measure — on frame one. Here m1-50 reports 4000px
		// (40x its 100px estimate); even so it sits within the 6x tail and
		// mounts immediately.
		const originalOffsetHeight = Object.getOwnPropertyDescriptor(
			HTMLElement.prototype,
			"offsetHeight",
		);
		Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
			configurable: true,
			get(this: HTMLElement) {
				return this.textContent?.startsWith("m1:50") ? 4000 : 100;
			},
		});
		try {
			renderPane(makePane("s1", "m1", 100));
			// The tall row (index 50) is mounted on the first frame.
			expect(mountedIndices("m1")).toContain(50);
		} finally {
			if (originalOffsetHeight) {
				Object.defineProperty(
					HTMLElement.prototype,
					"offsetHeight",
					originalOffsetHeight,
				);
			}
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
