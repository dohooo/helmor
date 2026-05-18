import { describe, expect, it } from "vitest";
import {
	findShortcutConflict,
	getShortcut,
	getShortcutConflicts,
	SHORTCUT_DEFINITIONS,
	scopesOverlap,
	updateShortcutOverride,
} from "./registry";
import type { ShortcutId } from "./types";

describe("shortcut registry", () => {
	it("ships with no internal shortcut conflicts", () => {
		expect(getShortcutConflicts({}).disabledIds.size).toBe(0);
	});

	it("resolves defaults, overrides, and disabled shortcuts", () => {
		expect(getShortcut({}, "workspace.previous")).toBe("Mod+Alt+ArrowUp");
		expect(getShortcut({}, "global.hotkey")).toBeNull();
		expect(
			getShortcut({ "workspace.previous": "Mod+A" }, "workspace.previous"),
		).toBe("Mod+A");
		expect(
			getShortcut({ "workspace.previous": null }, "workspace.previous"),
		).toBeNull();
	});

	it("drops redundant overrides that match the default", () => {
		expect(
			updateShortcutOverride(
				{ "workspace.previous": "Mod+A" },
				"workspace.previous",
				"Mod+Alt+ArrowUp",
			),
		).not.toHaveProperty("workspace.previous");
	});

	it("ignores null shortcuts and self matches when finding conflicts", () => {
		expect(
			findShortcutConflict(
				{ "workspace.previous": "Mod+A" },
				"workspace.previous",
				"Mod+A",
			),
		).toBeNull();
		expect(
			findShortcutConflict(
				{ "workspace.previous": null },
				"session.previous",
				"Mod+Alt+ArrowLeft",
			),
		).toBeNull();
	});

	it("marks duplicated shortcuts in overlapping scopes as conflicts", () => {
		// Both are scope=["chat"] — overlap → conflict.
		const conflicts = getShortcutConflicts({
			"workspace.previous": "Mod+A",
			"session.previous": "Mod+A",
		});

		expect(conflicts.disabledIds.has("workspace.previous")).toBe(true);
		expect(conflicts.disabledIds.has("session.previous")).toBe(true);
		expect(conflicts.conflictById["workspace.previous"]?.[0]?.id).toBe(
			"session.previous",
		);
		expect(conflicts.conflictById["session.previous"]?.[0]?.id).toBe(
			"workspace.previous",
		);
	});

	it("allows the same hotkey across non-overlapping scopes", () => {
		// session.new ("chat") and terminal.new ("terminal") both default to Mod+T —
		// they must coexist, not be flagged as conflicts.
		const conflicts = getShortcutConflicts({});
		expect(conflicts.disabledIds.has("session.new")).toBe(false);
		expect(conflicts.disabledIds.has("terminal.new")).toBe(false);
		expect(conflicts.conflictById["session.new"]).toBeUndefined();
		expect(conflicts.conflictById["terminal.new"]).toBeUndefined();
	});

	it("treats 'app' scope as overlapping with every other scope", () => {
		expect(scopesOverlap(["app"], ["chat"])).toBe(true);
		expect(scopesOverlap(["app"], ["terminal"])).toBe(true);
		expect(scopesOverlap(["chat"], ["app"])).toBe(true);
		expect(scopesOverlap(["chat"], ["terminal"])).toBe(false);
		expect(scopesOverlap(["chat"], ["chat", "editor"])).toBe(true);
	});

	it("findShortcutConflict respects scope overlap", () => {
		// Rebinding terminal.close to Mod+W (its current default) against
		// session.close (also Mod+W, in chat scope) must NOT report a conflict.
		expect(findShortcutConflict({}, "terminal.close", "Mod+W")).toBeNull();
		// Pointing a terminal-scoped shortcut at a chat-only hotkey is fine:
		// composer.togglePlanMode is "chat", terminal.close is "terminal" — no
		// overlap. (Mod+L is now app-scoped via composer.focus, so it would
		// conflict with terminal.close — tested separately below.)
		expect(findShortcutConflict({}, "terminal.close", "Shift+Tab")).toBeNull();
		// App-scoped shortcuts overlap with every scope, so binding a
		// terminal-scoped shortcut to an app-scoped hotkey IS a conflict.
		expect(findShortcutConflict({}, "terminal.close", "Mod+L")?.id).toBe(
			"composer.focus",
		);
		// Two chat-scoped shortcuts pointed at the same hotkey: conflict.
		expect(
			findShortcutConflict(
				{ "session.previous": "Mod+G" },
				"workspace.previous",
				"Mod+G",
			)?.id,
		).toBe("session.previous");
	});

	it("keeps every shortcut id unique", () => {
		const ids = SHORTCUT_DEFINITIONS.map((definition) => definition.id);
		expect(new Set<ShortcutId>(ids).size).toBe(ids.length);
	});
});
