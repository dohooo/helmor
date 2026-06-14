import type { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";
import { createTuiWheelHandler } from "./terminal-wheel";

type FakeOpts = {
	tracking?: "none" | "vt200";
	bufferType?: "normal" | "alternate";
};

function fakeTerminal({
	tracking = "none",
	bufferType = "normal",
}: FakeOpts = {}): Terminal {
	return {
		rows: 40,
		element: null, // cell height falls back to 16px
		options: { fastScrollSensitivity: 5 },
		modes: { mouseTrackingMode: tracking },
		buffer: { active: { type: bufferType } },
	} as unknown as Terminal;
}

function setup(opts?: FakeOpts) {
	const handler = createTuiWheelHandler(fakeTerminal(opts));
	const el = document.createElement("div");
	// Mirrors xterm: handler true → xterm processes the event itself.
	const processed: WheelEvent[] = [];
	const swallowed: WheelEvent[] = [];
	el.addEventListener("wheel", (ev) => {
		(handler(ev) ? processed : swallowed).push(ev);
	});
	const wheel = (deltaY: number, init?: WheelEventInit) =>
		el.dispatchEvent(
			new WheelEvent("wheel", {
				deltaY,
				bubbles: true,
				cancelable: true,
				...init,
			}),
		);
	return { wheel, processed, swallowed };
}

describe("createTuiWheelHandler", () => {
	it("passes events through when no TUI handles scrolling", () => {
		const t = setup();
		t.wheel(160);
		expect(t.processed).toHaveLength(1);
		expect(t.swallowed).toHaveLength(0);
	});

	it("re-emits one single-line event per scrolled line in the alt screen", () => {
		const t = setup({ bufferType: "alternate" });
		t.wheel(160); // 10 lines at 16px cells
		expect(t.swallowed).toHaveLength(1);
		expect(t.processed).toHaveLength(10);
		for (const ev of t.processed) expect(ev.deltaY).toBe(120);
	});

	it("intercepts when mouse tracking is active in the normal buffer", () => {
		const t = setup({ tracking: "vt200" });
		t.wheel(-32);
		expect(t.processed).toHaveLength(2);
		for (const ev of t.processed) expect(ev.deltaY).toBe(-120);
	});

	it("accumulates fractional deltas across events", () => {
		const t = setup({ bufferType: "alternate" });
		t.wheel(8);
		expect(t.processed).toHaveLength(0);
		t.wheel(8);
		expect(t.processed).toHaveLength(1);
	});

	it("drops the remainder on direction flip", () => {
		const t = setup({ bufferType: "alternate" });
		t.wheel(15); // remainder 0.9375
		t.wheel(-16); // without reset this would only reach -0.0625
		expect(t.processed).toHaveLength(1);
		expect(t.processed[0].deltaY).toBe(-120);
	});

	it("applies fast-scroll multiplier with alt held", () => {
		const t = setup({ bufferType: "alternate" });
		t.wheel(16, { altKey: true });
		expect(t.processed).toHaveLength(5);
	});

	it("leaves shift+wheel to xterm", () => {
		const t = setup({ bufferType: "alternate" });
		t.wheel(160, { shiftKey: true });
		expect(t.processed).toHaveLength(1);
		expect(t.swallowed).toHaveLength(0);
	});
});
