import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	_resetQuickSwitchActiveForTesting,
	beginQuickSwitch,
	endQuickSwitch,
} from "@/features/quick-switch/active-state";
import { _resetActiveScopeForTesting } from "./focus-scope";
import {
	beginShortcutRecording,
	endShortcutRecording,
} from "./recording-state";
import { useAppShortcuts } from "./use-app-shortcuts";

function ShortcutHarness({ onTrigger }: { onTrigger: () => void }) {
	useAppShortcuts({
		overrides: {},
		handlers: [{ id: "theme.toggle", callback: onTrigger }],
	});
	return null;
}

function fireModT() {
	window.dispatchEvent(
		new KeyboardEvent("keydown", {
			key: "t",
			code: "KeyT",
			metaKey: true,
		}),
	);
}

describe("useAppShortcuts", () => {
	beforeEach(() => {
		_resetActiveScopeForTesting();
		_resetQuickSwitchActiveForTesting();
	});
	afterEach(() => {
		endShortcutRecording();
		document.body.innerHTML = "";
	});

	it("does not trigger app shortcuts while shortcut recording is active", () => {
		const onTrigger = vi.fn();
		render(<ShortcutHarness onTrigger={onTrigger} />);

		beginShortcutRecording();
		window.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "t",
				code: "KeyT",
				metaKey: true,
				altKey: true,
			}),
		);

		expect(onTrigger).not.toHaveBeenCalled();
		endShortcutRecording();

		window.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "t",
				code: "KeyT",
				metaKey: true,
				altKey: true,
			}),
		);

		expect(onTrigger).toHaveBeenCalledTimes(1);
	});

	it("routes Mod+T to the chat handler when chat scope is active", () => {
		const sessionNew = vi.fn();
		const terminalNew = vi.fn();

		function Harness() {
			useAppShortcuts({
				overrides: {},
				handlers: [
					{ id: "session.new", callback: sessionNew },
					{ id: "terminal.new", callback: terminalNew },
				],
			});
			return (
				<div data-focus-scope="chat">
					<input data-testid="chat-input" />
				</div>
			);
		}

		const { getByTestId } = render(<Harness />);
		(getByTestId("chat-input") as HTMLInputElement).focus();

		fireModT();

		expect(sessionNew).toHaveBeenCalledTimes(1);
		expect(terminalNew).not.toHaveBeenCalled();
	});

	it("routes Mod+T to the terminal handler when terminal scope is active", () => {
		const sessionNew = vi.fn();
		const terminalNew = vi.fn();

		function Harness() {
			useAppShortcuts({
				overrides: {},
				handlers: [
					{ id: "session.new", callback: sessionNew },
					{ id: "terminal.new", callback: terminalNew },
				],
			});
			return (
				<div data-focus-scope="terminal">
					<input data-testid="terminal-input" />
				</div>
			);
		}

		const { getByTestId } = render(<Harness />);
		(getByTestId("terminal-input") as HTMLInputElement).focus();

		fireModT();

		expect(terminalNew).toHaveBeenCalledTimes(1);
		expect(sessionNew).not.toHaveBeenCalled();
	});

	it("routes both chat- and composer-bound shortcuts when typing in nested composer scope", () => {
		const sessionNew = vi.fn();
		const togglePlanMode = vi.fn();

		function Harness() {
			useAppShortcuts({
				overrides: {},
				handlers: [
					{ id: "session.new", callback: sessionNew },
					{ id: "composer.togglePlanMode", callback: togglePlanMode },
				],
			});
			// Plan-mode toggle now lives on the narrower `workspace-composer`
			// leaf; it inherits `composer` (and transitively `chat`) so generic
			// chat shortcuts keep working alongside it.
			return (
				<div data-focus-scope="chat">
					<div data-focus-scope="workspace-composer">
						<input data-testid="composer-input" />
					</div>
				</div>
			);
		}

		const { getByTestId } = render(<Harness />);
		(getByTestId("composer-input") as HTMLInputElement).focus();

		// Cmd+T (chat) still works while typing in composer.
		fireModT();
		expect(sessionNew).toHaveBeenCalledTimes(1);

		// Cmd+Shift+P (workspace composer) fires.
		window.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "p",
				code: "KeyP",
				metaKey: true,
				shiftKey: true,
			}),
		);
		expect(togglePlanMode).toHaveBeenCalledTimes(1);
	});

	it("routes start Shift+Tab and workspace plan shortcuts independently", () => {
		const togglePlanMode = vi.fn();
		const cycleRepository = vi.fn();

		function Harness() {
			useAppShortcuts({
				overrides: {},
				handlers: [
					{ id: "composer.togglePlanMode", callback: togglePlanMode },
					{
						id: "startSurface.cycleRepository",
						callback: cycleRepository,
					},
				],
			});
			return (
				<div data-focus-scope="chat">
					<div data-focus-scope="start-composer">
						<input data-testid="start-input" />
					</div>
					<div data-focus-scope="workspace-composer">
						<input data-testid="workspace-input" />
					</div>
				</div>
			);
		}

		const { getByTestId } = render(<Harness />);

		(getByTestId("start-input") as HTMLInputElement).focus();
		window.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Tab", code: "Tab", shiftKey: true }),
		);
		expect(cycleRepository).toHaveBeenCalledTimes(1);
		expect(togglePlanMode).not.toHaveBeenCalled();

		(getByTestId("workspace-input") as HTMLInputElement).focus();
		window.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "p",
				code: "KeyP",
				metaKey: true,
				shiftKey: true,
			}),
		);
		expect(togglePlanMode).toHaveBeenCalledTimes(1);
		// Cycling stays put — the workspace surface doesn't claim Shift+Tab.
		expect(cycleRepository).toHaveBeenCalledTimes(1);
	});

	it("fires cycleRepository on Shift+Tab when focus is on a start-surface button (not the composer itself)", () => {
		const cycleRepository = vi.fn();

		function Harness() {
			useAppShortcuts({
				overrides: {},
				handlers: [
					{
						id: "startSurface.cycleRepository",
						callback: cycleRepository,
					},
				],
			});
			return (
				<div data-focus-scope="chat">
					<div data-focus-scope="start-composer">
						<button type="button" data-testid="repo-button">
							Repo
						</button>
						<div data-focus-scope="start-composer">
							<input data-testid="composer-input" />
						</div>
					</div>
				</div>
			);
		}

		const { getByTestId } = render(<Harness />);
		(getByTestId("repo-button") as HTMLButtonElement).focus();

		window.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Tab", code: "Tab", shiftKey: true }),
		);
		expect(cycleRepository).toHaveBeenCalledTimes(1);
	});

	it("does not fire composer-only shortcuts when chat focus is outside composer", () => {
		const togglePlanMode = vi.fn();

		function Harness() {
			useAppShortcuts({
				overrides: {},
				handlers: [{ id: "composer.togglePlanMode", callback: togglePlanMode }],
			});
			return (
				<div data-focus-scope="chat">
					<input data-testid="inspector-input" />
					<div data-focus-scope="workspace-composer">
						<input data-testid="composer-input" />
					</div>
				</div>
			);
		}

		const { getByTestId } = render(<Harness />);
		(getByTestId("inspector-input") as HTMLInputElement).focus();

		window.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "p",
				code: "KeyP",
				metaKey: true,
				shiftKey: true,
			}),
		);
		expect(togglePlanMode).not.toHaveBeenCalled();
	});

	it("mutes ALL global shortcuts while quick-switch is active", () => {
		// Why "all" — even the quick-switch hotkey itself must not callback
		// through `useAppShortcuts` while active. Otherwise a repeat
		// Ctrl+Tab while holding Ctrl would cycle twice: once via this
		// dispatcher and once via the overlay's own capture-phase listener
		// (they're both registered on window, capture phase, and the
		// dispatcher only does `stopPropagation`, not
		// `stopImmediatePropagation`). The overlay's listener is the
		// single source of truth while engaged.
		const themeToggle = vi.fn();
		const quickSwitchNext = vi.fn();

		function Harness() {
			useAppShortcuts({
				overrides: {},
				handlers: [
					{ id: "theme.toggle", callback: themeToggle },
					{ id: "workspace.quickSwitchNext", callback: quickSwitchNext },
				],
			});
			return null;
		}

		render(<Harness />);
		beginQuickSwitch();

		// theme.toggle (Mod+Alt+T) muted.
		window.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "t",
				code: "KeyT",
				metaKey: true,
				altKey: true,
			}),
		);
		expect(themeToggle).not.toHaveBeenCalled();

		// quick-switch's own hotkey is ALSO muted at this layer — the
		// overlay's capture-phase listener handles repeats directly.
		window.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "Tab",
				code: "Tab",
				ctrlKey: true,
			}),
		);
		expect(quickSwitchNext).not.toHaveBeenCalled();

		endQuickSwitch();

		// Once inactive, everything works again.
		window.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "t",
				code: "KeyT",
				metaKey: true,
				altKey: true,
			}),
		);
		expect(themeToggle).toHaveBeenCalledTimes(1);
		window.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "Tab",
				code: "Tab",
				ctrlKey: true,
			}),
		);
		expect(quickSwitchNext).toHaveBeenCalledTimes(1);
	});

	it("fires app-scope shortcuts regardless of focus scope", () => {
		const themeToggle = vi.fn();

		function Harness() {
			useAppShortcuts({
				overrides: {},
				handlers: [{ id: "theme.toggle", callback: themeToggle }],
			});
			return (
				<div data-focus-scope="terminal">
					<input data-testid="terminal-input" />
				</div>
			);
		}

		const { getByTestId } = render(<Harness />);
		(getByTestId("terminal-input") as HTMLInputElement).focus();

		// Mod+Alt+T is the theme.toggle default and is in scope "app".
		window.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "t",
				code: "KeyT",
				metaKey: true,
				altKey: true,
			}),
		);

		expect(themeToggle).toHaveBeenCalledTimes(1);
	});
});

describe("useAppShortcuts held-key auto-repeat", () => {
	// `workspace.next` (Mod+Alt+ArrowDown, scope "app") is a repeatable nav
	// shortcut, so it exercises the rAF held-key path regardless of focus.
	function fireNavDown(options?: { repeat?: boolean }) {
		window.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "ArrowDown",
				code: "ArrowDown",
				metaKey: true,
				altKey: true,
				repeat: options?.repeat ?? false,
			}),
		);
	}

	function fireNavDownKeyUp() {
		window.dispatchEvent(
			new KeyboardEvent("keyup", {
				key: "ArrowDown",
				code: "ArrowDown",
				metaKey: true,
				altKey: true,
			}),
		);
	}

	function RepeatHarness({ onStep }: { onStep: () => void }) {
		useAppShortcuts({
			overrides: {},
			handlers: [{ id: "workspace.next", callback: onStep, repeatable: true }],
		});
		return null;
	}

	beforeEach(() => {
		_resetActiveScopeForTesting();
		_resetQuickSwitchActiveForTesting();
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.runOnlyPendingTimers();
		vi.useRealTimers();
		document.body.innerHTML = "";
	});

	it("steps exactly once on a single (non-repeat) press and starts no rAF loop", () => {
		const onStep = vi.fn();
		render(<RepeatHarness onStep={onStep} />);

		fireNavDown();
		expect(onStep).toHaveBeenCalledTimes(1);

		// No auto-repeat occurred, so advancing frames must not step again — a
		// single tap is identical to every other one-shot shortcut.
		vi.advanceTimersToNextFrame();
		vi.advanceTimersToNextFrame();
		vi.advanceTimersToNextFrame();
		vi.advanceTimersToNextFrame();
		expect(onStep).toHaveBeenCalledTimes(1);
	});

	it("drives further steps from the rAF loop once OS auto-repeat begins", () => {
		const onStep = vi.fn();
		render(<RepeatHarness onStep={onStep} />);

		fireNavDown();
		expect(onStep).toHaveBeenCalledTimes(1);

		// First OS auto-repeat starts the loop but does NOT itself step — the
		// backlog of repeat keydowns is dropped.
		fireNavDown({ repeat: true });
		fireNavDown({ repeat: true });
		fireNavDown({ repeat: true });
		expect(onStep).toHaveBeenCalledTimes(1);

		// The loop steps once every other frame (HELD_REPEAT_FRAME_INTERVAL = 2).
		vi.advanceTimersToNextFrame();
		expect(onStep).toHaveBeenCalledTimes(1);
		vi.advanceTimersToNextFrame();
		expect(onStep).toHaveBeenCalledTimes(2);
		vi.advanceTimersToNextFrame();
		vi.advanceTimersToNextFrame();
		expect(onStep).toHaveBeenCalledTimes(3);
	});

	it("stops immediately on keyup with no further queued steps", () => {
		const onStep = vi.fn();
		render(<RepeatHarness onStep={onStep} />);

		fireNavDown();
		fireNavDown({ repeat: true });
		vi.advanceTimersToNextFrame();
		vi.advanceTimersToNextFrame();
		expect(onStep).toHaveBeenCalledTimes(2);

		fireNavDownKeyUp();
		// After release, no frame may step again — release stops the loop on the
		// spot, leaving nothing to drain.
		vi.advanceTimersToNextFrame();
		vi.advanceTimersToNextFrame();
		vi.advanceTimersToNextFrame();
		vi.advanceTimersToNextFrame();
		expect(onStep).toHaveBeenCalledTimes(2);
	});

	it("cancels the rAF loop on unmount (no leak)", () => {
		const onStep = vi.fn();
		const { unmount } = render(<RepeatHarness onStep={onStep} />);

		fireNavDown();
		fireNavDown({ repeat: true });
		vi.advanceTimersToNextFrame();
		vi.advanceTimersToNextFrame();
		expect(onStep).toHaveBeenCalledTimes(2);

		unmount();
		vi.advanceTimersToNextFrame();
		vi.advanceTimersToNextFrame();
		vi.advanceTimersToNextFrame();
		expect(onStep).toHaveBeenCalledTimes(2);
	});
});
