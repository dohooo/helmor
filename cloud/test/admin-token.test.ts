// Round6 P1-4b: re-provision must not rotate the live companion token.
//
// The lockout (F-B, live-verified in class1): provision rotated
// HELMOR_COMPANION_TOKEN via `secret put` BEFORE deploy/verify, and the
// desktop only receives the token on the terminal `deployed` line — so any
// mid-run failure left the Worker on a NEW token the desktop never saw.
// The fix: when the desktop already holds a companion token (an EXISTING
// team re-provisioning), reuse it — `secret put` then writes the value the
// desktop already has, so no step failure can create a desktop≠Worker
// mismatch (and a pre-existing F-B mismatch self-heals: the put forces the
// Worker back to the desktop's value). A fresh team (no token held) keeps
// the rotate-on-provision semantics — with nothing held, there is nothing
// to lock out.

import { describe, expect, it } from "vitest";
import { resolveAdminToken } from "../scripts/admin-token";

const generate = () => "hlm_fresh_generated";

describe("resolveAdminToken (P1-4b reuse-or-generate)", () => {
	it("REUSES the desktop's existing token verbatim (no rotation)", () => {
		const decision = resolveAdminToken("hlm_desktop_held", generate);
		expect(decision).toEqual({ token: "hlm_desktop_held", reused: true });
	});

	it("trims whitespace around a reused token", () => {
		const decision = resolveAdminToken("  hlm_desktop_held\n", generate);
		expect(decision).toEqual({ token: "hlm_desktop_held", reused: true });
	});

	it("generates a fresh token when none is provided (fresh team → rotate)", () => {
		expect(resolveAdminToken(undefined, generate)).toEqual({
			token: "hlm_fresh_generated",
			reused: false,
		});
	});

	it("treats an empty/whitespace-only value as absent", () => {
		expect(resolveAdminToken("", generate).reused).toBe(false);
		expect(resolveAdminToken("   \n", generate).reused).toBe(false);
	});
});
