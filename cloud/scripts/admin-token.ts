// Companion/admin token decision for provision-team.ts (round6 P1-4b).
// Extracted as a pure function (same pattern as broker-key.ts /
// verify-live.ts) so the reuse-or-generate rule is unit-testable in
// cloud/test/admin-token.test.ts.

export type AdminTokenDecision = {
	/** The token `secret put` writes and `emitDeployed` returns. */
	token: string;
	/** True when the desktop's existing token was reused (no rotation). */
	reused: boolean;
};

/**
 * Reuse-or-generate (P1-4b): the desktop passes its currently-held companion
 * token via `HELMOR_EXISTING_COMPANION_TOKEN` on a re-provision; when present,
 * provision REUSES it instead of rotating.
 *
 * WHY this kills the lockout (F-B): the desktop only learns a token from the
 * terminal `deployed` line, so under rotate-first any mid-run failure left the
 * Worker on a new token the desktop never received. With reuse, `secret put`
 * writes the value the desktop ALREADY holds — after that point every failure
 * row of the matrix has desktop == Worker (and a pre-existing mismatch
 * self-heals, because the put forces the Worker back to the desktop's value).
 * Rotation is deliberately preserved on the FRESH path (nothing held →
 * nothing to lock out) and remains reachable for an existing team via
 * Leave team → Create team, which clears the stored admin token.
 */
export function resolveAdminToken(
	existingRaw: string | undefined,
	generate: () => string,
): AdminTokenDecision {
	const existing = (existingRaw ?? "").trim();
	if (existing) return { token: existing, reused: true };
	return { token: generate(), reused: false };
}
