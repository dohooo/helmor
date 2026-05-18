import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	_resetActiveScopeForTesting,
	DEFAULT_FOCUS_SCOPE,
	getActiveScopes,
} from "./focus-scope";

beforeEach(() => {
	_resetActiveScopeForTesting();
	document.body.innerHTML = "";
});

afterEach(() => {
	document.body.innerHTML = "";
});

describe("getActiveScopes", () => {
	it("returns the default when nothing is focused", () => {
		expect(getActiveScopes()).toEqual([DEFAULT_FOCUS_SCOPE]);
	});

	it("walks up to the [data-focus-scope] ancestor", () => {
		document.body.innerHTML = `
			<div data-focus-scope="terminal">
				<div>
					<input id="probe" />
				</div>
			</div>
		`;
		const probe = document.getElementById("probe") as HTMLInputElement;
		probe.focus();
		// Pure terminal scope — chat-bound shortcuts (Cmd+T) must NOT fire,
		// so chat is deliberately absent.
		expect(getActiveScopes()).toEqual(["terminal"]);
	});

	it("falls back to default for unknown scope values", () => {
		document.body.innerHTML = `
			<div data-focus-scope="bogus">
				<input id="probe" />
			</div>
		`;
		(document.getElementById("probe") as HTMLInputElement).focus();
		expect(getActiveScopes()).toEqual([DEFAULT_FOCUS_SCOPE]);
	});

	it("collects nested scopes leaf-first", () => {
		document.body.innerHTML = `
			<div data-focus-scope="chat">
				<div data-focus-scope="composer">
					<input id="probe" />
				</div>
			</div>
		`;
		(document.getElementById("probe") as HTMLInputElement).focus();
		// Composer is nested inside chat — both scopes are active so
		// chat-bound shortcuts (Cmd+T) AND composer-bound shortcuts
		// (Shift+Tab) fire while typing in the composer.
		expect(getActiveScopes()).toEqual(["composer", "chat"]);
	});

	it("inherits chat from composer even when DOM-sibling (not nested)", () => {
		// Real layout: composer is rendered as a sibling of the chat panel,
		// not a descendant. SCOPE_PARENTS still pulls in chat so session-
		// navigation (chat-only) shortcuts work while typing.
		document.body.innerHTML = `
			<div data-focus-scope="chat">
				<input id="msg" />
			</div>
			<div data-focus-scope="composer">
				<input id="probe" />
			</div>
		`;
		(document.getElementById("probe") as HTMLInputElement).focus();
		expect(getActiveScopes()).toEqual(["composer", "chat"]);
	});

	it("keeps sticky scope when focused element is removed but container still exists", () => {
		// Two terminal panels (e.g. two open terminals); the focused one
		// gets unmounted but the sibling panel remains.
		document.body.innerHTML = `
			<div data-focus-scope="terminal" id="t1">
				<input id="probe" />
			</div>
			<div data-focus-scope="terminal" id="t2">
				<input id="alive" />
			</div>
		`;
		const probe = document.getElementById("probe") as HTMLInputElement;
		probe.focus();
		expect(getActiveScopes()).toEqual(["terminal"]);

		document.getElementById("t1")?.remove();
		expect(document.activeElement).toBe(document.body);

		// One terminal container still exists — sticky should hold so the
		// next shortcut routes to the panel the user just engaged with.
		expect(getActiveScopes()).toEqual(["terminal"]);
	});

	it("drops sticky when the engaged scope is no longer in the DOM", () => {
		// Single terminal panel — close it and there's nowhere left for
		// terminal-scoped shortcuts to land. Sticky must self-heal back to
		// the default so chat shortcuts fire as expected.
		document.body.innerHTML = `
			<div data-focus-scope="terminal" id="t1">
				<input id="probe" />
			</div>
		`;
		const probe = document.getElementById("probe") as HTMLInputElement;
		probe.focus();
		expect(getActiveScopes()).toEqual(["terminal"]);

		document.getElementById("t1")?.remove();
		expect(getActiveScopes()).toEqual([DEFAULT_FOCUS_SCOPE]);
	});

	it("updates sticky when user explicitly focuses a different scope", () => {
		document.body.innerHTML = `
			<div data-focus-scope="terminal">
				<input id="t" />
			</div>
			<div data-focus-scope="chat">
				<input id="c" />
			</div>
		`;
		(document.getElementById("t") as HTMLInputElement).focus();
		expect(getActiveScopes()).toEqual(["terminal"]);

		(document.getElementById("c") as HTMLInputElement).focus();
		expect(getActiveScopes()).toEqual(["chat"]);
	});

	it("treats explicit focus on an unscoped surface as a return to default", () => {
		document.body.innerHTML = `
			<div data-focus-scope="terminal">
				<input id="t" />
			</div>
			<input id="sidebar" />
		`;
		(document.getElementById("t") as HTMLInputElement).focus();
		expect(getActiveScopes()).toEqual(["terminal"]);

		(document.getElementById("sidebar") as HTMLInputElement).focus();
		expect(getActiveScopes()).toEqual([DEFAULT_FOCUS_SCOPE]);
	});

	it("prefers a clicked scope over a stale focus owner (xterm-textarea case)", () => {
		// xterm keeps its hidden textarea focused after a click on chat —
		// pointer engagement must override stale focus.
		document.body.innerHTML = `
			<div data-focus-scope="terminal">
				<input id="terminal-textarea" />
			</div>
			<div data-focus-scope="chat">
				<div id="chat-messages">streamed text...</div>
			</div>
		`;
		(document.getElementById("terminal-textarea") as HTMLInputElement).focus();
		expect(getActiveScopes()).toEqual(["terminal"]);

		const messages = document.getElementById("chat-messages") as HTMLDivElement;
		messages.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
		// Focus is still on the terminal textarea, but the user clicked chat.
		expect(document.activeElement?.id).toBe("terminal-textarea");
		expect(getActiveScopes()).toEqual(["chat"]);
	});

	it("keeps composer + chat active when clicking inside chat without moving focus", () => {
		// Focus in composer, click in chat: chat is reachable via
		// SCOPE_PARENTS so the focus chain wins (composer shortcuts stay).
		document.body.innerHTML = `
			<div data-focus-scope="chat">
				<div id="chat-messages">streamed text...</div>
			</div>
			<div data-focus-scope="composer">
				<input id="composer-input" />
			</div>
		`;
		(document.getElementById("composer-input") as HTMLInputElement).focus();
		expect(getActiveScopes()).toEqual(["composer", "chat"]);

		document
			.getElementById("chat-messages")
			?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
		expect(getActiveScopes()).toEqual(["composer", "chat"]);
	});
});
