import { describe, expect, it } from "vitest";
import { findProviderCapabilities, type ProviderCapabilities } from "./api";

const claudeCaps: ProviderCapabilities = {
	provider: "claude",
	displayName: "Claude",
	supportsPlanMode: true,
	supportsActiveGoal: false,
	supportsContextUsage: true,
	supportsSteer: true,
	supportsSlashCommands: true,
	requiresApiKey: false,
	permissionModes: ["default", "acceptEdits", "plan", "bypassPermissions"],
};

const codexCaps: ProviderCapabilities = {
	provider: "codex",
	displayName: "Codex",
	supportsPlanMode: true,
	supportsActiveGoal: true,
	supportsContextUsage: true,
	supportsSteer: true,
	supportsSlashCommands: true,
	requiresApiKey: false,
	permissionModes: ["default", "bypassPermissions"],
};

const cursorCaps: ProviderCapabilities = {
	provider: "cursor",
	displayName: "Cursor",
	supportsPlanMode: false,
	supportsActiveGoal: false,
	supportsContextUsage: false,
	supportsSteer: false,
	supportsSlashCommands: true,
	requiresApiKey: true,
	permissionModes: ["default"],
};

const table: ProviderCapabilities[] = [claudeCaps, codexCaps, cursorCaps];

describe("findProviderCapabilities", () => {
	it.each([
		["claude", claudeCaps],
		["codex", codexCaps],
		["cursor", cursorCaps],
	])("returns the row for %s", (provider, expected) => {
		expect(findProviderCapabilities(table, provider)).toBe(expected);
	});

	it("returns null for an unknown provider id", () => {
		// Forward-compat: callers receiving null are expected to fall
		// back to safe defaults. This mirrors the Rust helper's
		// behaviour (Claude defaults) at the data-access boundary.
		expect(findProviderCapabilities(table, "copilot")).toBeNull();
	});

	it("returns null on an empty table", () => {
		expect(findProviderCapabilities([], "claude")).toBeNull();
	});

	it("distinguishes Codex active-goal support from Claude / Cursor", () => {
		// Regression gate for the composer's `/goal` interception
		// switching from `provider === "codex"` to a capability check.
		// If a future provider ever needs `supportsActiveGoal`, the
		// composer's special-case path needs to be reviewed alongside.
		expect(findProviderCapabilities(table, "codex")?.supportsActiveGoal).toBe(
			true,
		);
		expect(findProviderCapabilities(table, "claude")?.supportsActiveGoal).toBe(
			false,
		);
		expect(findProviderCapabilities(table, "cursor")?.supportsActiveGoal).toBe(
			false,
		);
	});

	it("surfaces Cursor's requires-api-key flag", () => {
		// Regression gate: a future refactor of the onboarding/login
		// step would lose the in-app API-key path if this flag flipped
		// silently. Keep the assertion explicit per-provider.
		expect(findProviderCapabilities(table, "cursor")?.requiresApiKey).toBe(
			true,
		);
		expect(findProviderCapabilities(table, "claude")?.requiresApiKey).toBe(
			false,
		);
		expect(findProviderCapabilities(table, "codex")?.requiresApiKey).toBe(
			false,
		);
	});
});
