import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetActiveScopeForTesting } from "@/features/shortcuts/focus-scope";
import { useAppShortcuts } from "@/features/shortcuts/use-app-shortcuts";
import {
	_resetQuickSwitchActiveForTesting,
	isQuickSwitchActive,
} from "./active-state";
import {
	QUICK_SWITCH_WARMING_MS,
	type QuickSwitchControls,
	type QuickSwitchSnapshot,
	useQuickSwitch,
} from "./use-quick-switch";

type HarnessProps = {
	snapshot: QuickSwitchSnapshot | null;
	onCommit: (id: string) => void;
	controlsRef: { current: QuickSwitchControls | null };
};

function Harness({ snapshot, onCommit, controlsRef }: HarnessProps) {
	const controls = useQuickSwitch({
		buildSnapshot: () => snapshot,
		onCommit,
	});
	controlsRef.current = controls;
	return null;
}

function makeControlsRef() {
	return { current: null as QuickSwitchControls | null };
}

function dispatchKey(
	type: "keydown" | "keyup",
	init: KeyboardEventInit & { key: string },
) {
	window.dispatchEvent(new KeyboardEvent(type, init));
}

function advanceWarming() {
	act(() => {
		vi.advanceTimersByTime(QUICK_SWITCH_WARMING_MS);
	});
}

describe("useQuickSwitch", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		_resetQuickSwitchActiveForTesting();
	});
	afterEach(() => {
		// Unmount the rendered tree so the global keydown/keyup/blur listeners
		// from previous tests don't leak forward and double-handle events.
		cleanup();
		document.body.innerHTML = "";
		_resetQuickSwitchActiveForTesting();
		vi.useRealTimers();
	});

	it("does not open when fewer than two ids are available", () => {
		const ref = makeControlsRef();
		render(
			<Harness
				snapshot={{ ids: ["a"], initialIndex: 0 }}
				onCommit={vi.fn()}
				controlsRef={ref}
			/>,
		);
		act(() => ref.current?.open("next"));
		expect(ref.current?.state.phase).toBe("idle");
		expect(isQuickSwitchActive()).toBe(false);
	});

	it("a fast tap-and-release commits without ever entering the open phase", () => {
		const onCommit = vi.fn();
		const ref = makeControlsRef();
		// Track every state.phase transition so we can assert the overlay
		// (phase === "open") never appeared during the fast path.
		const phaseHistory: string[] = [];
		function HarnessWithHistory(props: HarnessProps) {
			const { state, ...rest } = useQuickSwitch({
				buildSnapshot: () => props.snapshot,
				onCommit: props.onCommit,
			});
			phaseHistory.push(state.phase);
			props.controlsRef.current = { state, ...rest };
			return null;
		}
		render(
			<HarnessWithHistory
				snapshot={{ ids: ["current", "previous"], initialIndex: 1 }}
				onCommit={onCommit}
				controlsRef={ref}
			/>,
		);
		// Tap.
		act(() => ref.current?.open("next"));
		expect(ref.current?.state).toMatchObject({ phase: "warming", index: 1 });
		expect(isQuickSwitchActive()).toBe(true);
		// Release before the warming threshold elapses — overlay never shows.
		act(() => dispatchKey("keyup", { key: "Control" }));
		expect(onCommit).toHaveBeenCalledWith("previous");
		expect(ref.current?.state.phase).toBe("idle");
		expect(isQuickSwitchActive()).toBe(false);
		// Phase should have gone idle -> warming -> idle, never touching "open".
		expect(phaseHistory).not.toContain("open");
	});

	it("holding past the warming threshold promotes to open (overlay appears)", () => {
		const ref = makeControlsRef();
		render(
			<Harness
				snapshot={{ ids: ["a", "b", "c"], initialIndex: 1 }}
				onCommit={vi.fn()}
				controlsRef={ref}
			/>,
		);
		act(() => ref.current?.open("next"));
		expect(ref.current?.state.phase).toBe("warming");
		advanceWarming();
		expect(ref.current?.state).toMatchObject({ phase: "open", index: 1 });
	});

	it("open(previous) starts at the last index", () => {
		const onCommit = vi.fn();
		const ref = makeControlsRef();
		render(
			<Harness
				snapshot={{ ids: ["a", "b", "c"], initialIndex: 2 }}
				onCommit={onCommit}
				controlsRef={ref}
			/>,
		);
		act(() => ref.current?.open("previous"));
		expect(ref.current?.state).toMatchObject({ phase: "warming", index: 2 });

		act(() => dispatchKey("keyup", { key: "Control" }));
		expect(onCommit).toHaveBeenCalledWith("c");
	});

	it("Tab cycles forward, Shift+Tab cycles backward, with wrap-around", () => {
		const onCommit = vi.fn();
		const ref = makeControlsRef();
		render(
			<Harness
				snapshot={{ ids: ["a", "b", "c"], initialIndex: 1 }}
				onCommit={onCommit}
				controlsRef={ref}
			/>,
		);
		act(() => ref.current?.open("next"));
		// Tab during warming: cycle AND promote to open.
		act(() => dispatchKey("keydown", { key: "Tab" }));
		expect(ref.current?.state).toMatchObject({ phase: "open", index: 2 });
		// Tab: 2 -> 0 (wrap)
		act(() => dispatchKey("keydown", { key: "Tab" }));
		expect(ref.current?.state).toMatchObject({ phase: "open", index: 0 });
		// Shift+Tab: 0 -> 2 (wrap)
		act(() => dispatchKey("keydown", { key: "Tab", shiftKey: true }));
		expect(ref.current?.state).toMatchObject({ phase: "open", index: 2 });
		// commit
		act(() => dispatchKey("keyup", { key: "Control" }));
		expect(onCommit).toHaveBeenCalledWith("c");
	});

	it("ArrowLeft / ArrowRight cycle like Shift+Tab / Tab", () => {
		const ref = makeControlsRef();
		render(
			<Harness
				snapshot={{ ids: ["a", "b", "c"], initialIndex: 1 }}
				onCommit={vi.fn()}
				controlsRef={ref}
			/>,
		);
		act(() => ref.current?.open("next"));
		act(() => dispatchKey("keydown", { key: "ArrowRight" }));
		expect(ref.current?.state).toMatchObject({ phase: "open", index: 2 });
		act(() => dispatchKey("keydown", { key: "ArrowLeft" }));
		expect(ref.current?.state).toMatchObject({ phase: "open", index: 1 });
	});

	it("Escape cancels without firing onCommit", () => {
		const onCommit = vi.fn();
		const ref = makeControlsRef();
		render(
			<Harness
				snapshot={{ ids: ["a", "b"], initialIndex: 1 }}
				onCommit={onCommit}
				controlsRef={ref}
			/>,
		);
		act(() => ref.current?.open("next"));
		act(() => dispatchKey("keydown", { key: "Escape" }));
		expect(onCommit).not.toHaveBeenCalled();
		expect(ref.current?.state.phase).toBe("idle");
		expect(isQuickSwitchActive()).toBe(false);
	});

	it("re-pressing open while engaged cycles instead of re-snapshotting", () => {
		const ref = makeControlsRef();
		render(
			<Harness
				snapshot={{ ids: ["a", "b", "c"], initialIndex: 1 }}
				onCommit={vi.fn()}
				controlsRef={ref}
			/>,
		);
		act(() => ref.current?.open("next"));
		act(() => ref.current?.open("next"));
		act(() => ref.current?.open("next"));
		// 1 -> 2 -> 0 (wrap); cycling promotes warming -> open.
		expect(ref.current?.state).toMatchObject({ phase: "open", index: 0 });

		act(() => ref.current?.open("previous"));
		// 0 -> 2 (wrap)
		expect(ref.current?.state).toMatchObject({ phase: "open", index: 2 });
	});

	it("window blur cancels and does not commit", () => {
		const onCommit = vi.fn();
		const ref = makeControlsRef();
		render(
			<Harness
				snapshot={{ ids: ["a", "b"], initialIndex: 1 }}
				onCommit={onCommit}
				controlsRef={ref}
			/>,
		);
		act(() => ref.current?.open("next"));
		act(() => window.dispatchEvent(new Event("blur")));
		expect(onCommit).not.toHaveBeenCalled();
		expect(ref.current?.state.phase).toBe("idle");
		expect(isQuickSwitchActive()).toBe(false);
	});

	it("clicking a card via selectIndex + commit fires onCommit with that id", () => {
		const onCommit = vi.fn();
		const ref = makeControlsRef();
		render(
			<Harness
				snapshot={{ ids: ["a", "b", "c"], initialIndex: 1 }}
				onCommit={onCommit}
				controlsRef={ref}
			/>,
		);
		act(() => ref.current?.open("next"));
		// selectIndex only fires from the overlay, which only renders when
		// the phase is "open" — wait past warming first.
		advanceWarming();
		act(() => ref.current?.selectIndex(2));
		act(() => ref.current?.commit());
		expect(onCommit).toHaveBeenCalledWith("c");
	});

	it("ignores keydown when isComposing (IME)", () => {
		const ref = makeControlsRef();
		render(
			<Harness
				snapshot={{ ids: ["a", "b", "c"], initialIndex: 1 }}
				onCommit={vi.fn()}
				controlsRef={ref}
			/>,
		);
		act(() => ref.current?.open("next"));
		act(() =>
			window.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Tab", isComposing: true }),
			),
		);
		// Still in warming with the original index — Tab was not consumed.
		expect(ref.current?.state).toMatchObject({ phase: "warming", index: 1 });
	});

	it("repeating Ctrl+Tab with useAppShortcuts mounted alongside cycles by exactly 1", () => {
		// Regression: useAppShortcuts and the overlay's own keydown listener
		// both live on window in capture phase. Earlier, useAppShortcuts
		// kept firing the quickSwitchNext callback while engaged, so each
		// Tab cycled twice (once via the callback, once via the overlay
		// listener) and the selection ricocheted between two workspaces.
		_resetActiveScopeForTesting();
		const onCommit = vi.fn();
		const ref = makeControlsRef();
		function CombinedHarness() {
			const controls = useQuickSwitch({
				buildSnapshot: () => ({ ids: ["a", "b", "c", "d"], initialIndex: 1 }),
				onCommit,
			});
			ref.current = controls;
			useAppShortcuts({
				overrides: {},
				handlers: [
					{
						id: "workspace.quickSwitchNext",
						callback: () => controls.open("next"),
					},
					{
						id: "workspace.quickSwitchPrevious",
						callback: () => controls.open("previous"),
					},
				],
			});
			return null;
		}
		render(<CombinedHarness />);
		// First press goes through useAppShortcuts → controls.open(),
		// landing on MRU[1].
		act(() =>
			dispatchKey("keydown", {
				key: "Tab",
				code: "Tab",
				ctrlKey: true,
			}),
		);
		expect(ref.current?.state).toMatchObject({ index: 1 });
		// Second press while engaged: useAppShortcuts must short-circuit;
		// only the overlay's listener should advance the index.
		act(() =>
			dispatchKey("keydown", {
				key: "Tab",
				code: "Tab",
				ctrlKey: true,
			}),
		);
		expect(ref.current?.state).toMatchObject({ index: 2 });
		// Third press — same expectation, no double-step.
		act(() =>
			dispatchKey("keydown", {
				key: "Tab",
				code: "Tab",
				ctrlKey: true,
			}),
		);
		expect(ref.current?.state).toMatchObject({ index: 3 });
		// Ctrl+Shift+Tab walks back, again by exactly one.
		act(() =>
			dispatchKey("keydown", {
				key: "Tab",
				code: "Tab",
				ctrlKey: true,
				shiftKey: true,
			}),
		);
		expect(ref.current?.state).toMatchObject({ index: 2 });
		// Release commits MRU[2] = "c".
		act(() => dispatchKey("keyup", { key: "Control" }));
		expect(onCommit).toHaveBeenCalledWith("c");
	});

	it("releases the active flag if unmounted while engaged", () => {
		const ref = makeControlsRef();
		const { unmount } = render(
			<Harness
				snapshot={{ ids: ["a", "b"], initialIndex: 1 }}
				onCommit={vi.fn()}
				controlsRef={ref}
			/>,
		);
		act(() => ref.current?.open("next"));
		expect(isQuickSwitchActive()).toBe(true);
		unmount();
		expect(isQuickSwitchActive()).toBe(false);
	});
});
