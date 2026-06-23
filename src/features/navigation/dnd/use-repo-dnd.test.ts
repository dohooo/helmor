import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRepoDnd } from "./use-repo-dnd";

function rect(p: Partial<DOMRect>): DOMRect {
	return {
		x: 0,
		y: 0,
		top: 0,
		left: 0,
		right: 0,
		bottom: 0,
		width: 0,
		height: 0,
		...p,
		toJSON: () => ({}),
	} as DOMRect;
}

function windowPointer(
	type: "pointermove" | "pointerup" | "pointercancel",
	{ clientX = 50, clientY = 15, buttons = 1, pointerId = 1 } = {},
) {
	const event = new Event(type, { bubbles: true, cancelable: true });
	Object.defineProperties(event, {
		clientX: { value: clientX },
		clientY: { value: clientY },
		buttons: { value: buttons },
		pointerId: { value: pointerId },
	});
	act(() => {
		window.dispatchEvent(event);
	});
}

function mount() {
	const onMoveRepo = vi.fn();
	const view = renderHook(() => useRepoDnd({ onMoveRepo }));
	function pressDown({ clientX = 50, clientY = 15, pointerId = 1 } = {}) {
		// biome-ignore lint/suspicious/noExplicitAny: minimal synthetic React event
		const event: any = {
			button: 0,
			pointerId,
			clientX,
			clientY,
			currentTarget: {
				getBoundingClientRect: () => rect({ width: 100, height: 30 }),
			},
		};
		act(() => {
			view.result.current.startRepoDragGesture({
				event,
				repoId: "r1",
				label: "R",
			});
		});
	}
	return { ...view, onMoveRepo, pressDown };
}

afterEach(() => {
	cleanup();
	document.body.innerHTML = "";
	vi.restoreAllMocks();
});

describe("useRepoDnd", () => {
	it("activates a drag after a press-and-move past the threshold", () => {
		const { result, pressDown } = mount();
		pressDown();
		expect(result.current.dragState).toBeNull();
		windowPointer("pointermove", { clientY: 25, buttons: 1 });
		expect(result.current.dragState).not.toBeNull();
	});

	it("does not activate on a tap (move reports no button held)", () => {
		const { result, pressDown, onMoveRepo } = mount();
		pressDown();
		windowPointer("pointermove", { clientY: 25, buttons: 0 });
		expect(result.current.dragState).toBeNull();
		windowPointer("pointerup", { clientY: 25, buttons: 0 });
		expect(onMoveRepo).not.toHaveBeenCalled();
	});

	it("ends a stranded drag on the next move with no button held", () => {
		const { result, pressDown } = mount();
		pressDown();
		windowPointer("pointermove", { clientY: 25, buttons: 1 });
		expect(result.current.dragState).not.toBeNull();
		windowPointer("pointermove", { clientY: 40, buttons: 0 });
		expect(result.current.dragState).toBeNull();
	});

	it("ends the drag on pointerup even if the pointerId does not match", () => {
		const { result, pressDown } = mount();
		pressDown({ pointerId: 1 });
		windowPointer("pointermove", { clientY: 25, buttons: 1, pointerId: 1 });
		expect(result.current.dragState).not.toBeNull();
		windowPointer("pointerup", { clientY: 25, buttons: 0, pointerId: 2 });
		expect(result.current.dragState).toBeNull();
	});

	it("clears a stranded drag when a new gesture starts", () => {
		const { result, pressDown } = mount();
		pressDown();
		windowPointer("pointermove", { clientY: 25, buttons: 1 });
		expect(result.current.dragState).not.toBeNull();
		pressDown();
		expect(result.current.dragState).toBeNull();
	});

	it("commits the reorder on pointerup over another repo handle", () => {
		const handle = document.createElement("div");
		handle.dataset.repoDndHandle = "true";
		handle.dataset.repoDndId = "r2";
		handle.getBoundingClientRect = () => rect({ top: 100, height: 40 });
		document.body.appendChild(handle);

		const { result, pressDown, onMoveRepo } = mount();
		pressDown({ clientY: 15 });
		windowPointer("pointermove", { clientY: 20, buttons: 1 });
		expect(result.current.dragState).not.toBeNull();
		windowPointer("pointerup", { clientY: 20, buttons: 0 });
		expect(onMoveRepo).toHaveBeenCalledWith("r1", "r2");
		expect(result.current.dragState).toBeNull();
	});
});
