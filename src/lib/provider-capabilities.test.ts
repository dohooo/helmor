import { describe, expect, it } from "vitest";
import {
	DEFAULT_PROVIDER_CAPABILITIES,
	findProviderCapabilities,
	type ProviderCapabilities,
} from "./api";
import { providerCapabilitiesQueryOptions } from "./query-client";

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
	supportsPlanMode: true,
	supportsActiveGoal: false,
	supportsContextUsage: false,
	supportsSteer: false,
	supportsSlashCommands: true,
	requiresApiKey: true,
	permissionModes: ["default", "plan"],
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

// Cold-start regression gate. Before the capability table is hydrated
// from the persisted cache / `list_provider_capabilities` IPC, consumers
// read the query's `initialData`. If that fell back to an empty table
// (or `undefined`), `findProviderCapabilities(..., "codex")` would return
// null and Codex would read `supportsActiveGoal === false` — silently
// disabling `/goal pause|clear` interception in the composer and the
// goal-pause-before-abort in `handleStopStream`. These tests pin the
// local default table to the Rust source-of-truth values so that window
// never reopens.
describe("DEFAULT_PROVIDER_CAPABILITIES (cold-start initialData)", () => {
	it("covers exactly the shipping providers", () => {
		expect(DEFAULT_PROVIDER_CAPABILITIES.map((caps) => caps.provider)).toEqual([
			"claude",
			"codex",
			"cursor",
			"opencode",
		]);
	});

	it("keeps Codex active-goal support on before hydration", () => {
		expect(
			findProviderCapabilities(DEFAULT_PROVIDER_CAPABILITIES, "codex")
				?.supportsActiveGoal,
		).toBe(true);
		expect(
			findProviderCapabilities(DEFAULT_PROVIDER_CAPABILITIES, "claude")
				?.supportsActiveGoal,
		).toBe(false);
		expect(
			findProviderCapabilities(DEFAULT_PROVIDER_CAPABILITIES, "cursor")
				?.supportsActiveGoal,
		).toBe(false);
	});

	it("mirrors the Rust default rows for display name + key flags", () => {
		const codex = findProviderCapabilities(
			DEFAULT_PROVIDER_CAPABILITIES,
			"codex",
		);
		expect(codex?.displayName).toBe("Codex");
		expect(codex?.permissionModes).toEqual(["default", "bypassPermissions"]);
		const cursor = findProviderCapabilities(
			DEFAULT_PROVIDER_CAPABILITIES,
			"cursor",
		);
		expect(cursor?.displayName).toBe("Cursor");
		expect(cursor?.requiresApiKey).toBe(true);
		// OpenCode must resolve to itself, not fall back to "Claude".
		const opencode = findProviderCapabilities(
			DEFAULT_PROVIDER_CAPABILITIES,
			"opencode",
		);
		expect(opencode?.displayName).toBe("OpenCode");
		expect(opencode?.supportsContextUsage).toBe(true);
		expect(opencode?.supportsActiveGoal).toBe(false);
		expect(opencode?.requiresApiKey).toBe(false);
	});

	it("is wired as the query's initialData so the cold-start window is closed", () => {
		// `toBe` ties the wiring to the constant whose Codex active-goal
		// flag is pinned by the test above — so the query hands consumers a
		// table with `supportsActiveGoal === true` before any hydration.
		expect(providerCapabilitiesQueryOptions().initialData).toBe(
			DEFAULT_PROVIDER_CAPABILITIES,
		);
	});
});
