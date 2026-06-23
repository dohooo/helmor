import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceRow } from "@/lib/api";
import { useWorkspaceDnd } from "./use-workspace-dnd";

const ROW = {
	id: "w1",
	state: "active",
	repoId: "r1",
} as unknown as WorkspaceRow;
const POLICY = { canDragRow: () => true, canDropIntoGroup: () => true };

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

// Build a fully controlled pointer event — jsdom's PointerEvent ignores some
// init fields, and the handlers only read pointerId/buttons/clientX/clientY.
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
	const onMoveWorkspace = vi.fn();
	const view = renderHook(() =>
		useWorkspaceDnd({ onMoveWorkspace, policy: POLICY }),
	);
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
			view.result.current.startDragGesture({
				event,
				row: ROW,
				groupId: "review",
				title: "t",
			});
		});
	}
	return { ...view, onMoveWorkspace, pressDown };
}

beforeEach(() => {
	document.elementsFromPoint = (() => []) as typeof document.elementsFromPoint;
	if (typeof globalThis.CSS === "undefined") {
		// biome-ignore lint/suspicious/noExplicitAny: jsdom lacks CSS.escape
		(globalThis as any).CSS = { escape: (value: string) => value };
	}
});

afterEach(() => {
	cleanup();
	document.body.innerHTML = "";
	vi.restoreAllMocks();
});

describe("useWorkspaceDnd", () => {
	it("activates a drag after a press-and-move past the threshold", () => {
		const { result, pressDown } = mount();
		pressDown();
		expect(result.current.dragState).toBeNull();
		windowPointer("pointermove", { clientY: 25, buttons: 1 });
		expect(result.current.dragState).not.toBeNull();
	});

	it("does not activate on a tap (move reports no button held)", () => {
		const { result, pressDown, onMoveWorkspace } = mount();
		pressDown();
		windowPointer("pointermove", { clientY: 25, buttons: 0 });
		expect(result.current.dragState).toBeNull();
		windowPointer("pointerup", { clientY: 25, buttons: 0 });
		expect(onMoveWorkspace).not.toHaveBeenCalled();
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

	it("commits the move on pointerup over a different group", () => {
		const group = document.createElement("div");
		group.dataset.workspaceDropGroupId = "done";
		document.body.appendChild(group);
		const otherRow = document.createElement("div");
		otherRow.dataset.workspaceDndRow = "true";
		otherRow.dataset.workspaceDndGroupId = "done";
		otherRow.dataset.workspaceDndRowId = "w2";
		otherRow.getBoundingClientRect = () => rect({ top: 100, height: 40 });
		document.body.appendChild(otherRow);
		document.elementsFromPoint = (() => [
			group,
		]) as typeof document.elementsFromPoint;

		const { result, pressDown, onMoveWorkspace } = mount();
		pressDown({ clientX: 50, clientY: 15 });
		windowPointer("pointermove", { clientX: 50, clientY: 20, buttons: 1 });
		expect(result.current.dragState).not.toBeNull();
		windowPointer("pointerup", { clientX: 50, clientY: 20, buttons: 0 });
		expect(onMoveWorkspace).toHaveBeenCalledWith("w1", "done", "w2");
		expect(result.current.dragState).toBeNull();
	});
});
