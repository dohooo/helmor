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
			return (
				<div data-focus-scope="chat">
					<div data-focus-scope="composer">
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

		// Shift+Tab (composer) fires.
		window.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Tab", code: "Tab", shiftKey: true }),
		);
		expect(togglePlanMode).toHaveBeenCalledTimes(1);
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
					<div data-focus-scope="composer">
						<input data-testid="composer-input" />
					</div>
				</div>
			);
		}

		const { getByTestId } = render(<Harness />);
		(getByTestId("inspector-input") as HTMLInputElement).focus();

		window.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Tab", code: "Tab", shiftKey: true }),
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
