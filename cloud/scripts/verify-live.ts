// Health-poll loop for provision's live verify (stage (a) of verifyLive in
// provision-team.ts). Extracted as a dependency-injected function (probe /
// clock / sleep) so the retry semantics are unit-testable in
// cloud/test/verify-live.test.ts — same pattern as broker-key.ts.

/** How long a 401/403 from the freshly-rotated admin token is treated as a
 *  Cloudflare secret-propagation lag instead of a real mismatch. Measured live
 *  (round6 F-C): `wrangler secret put` + `deploy` → an immediate probe with
 *  the NEW token returns 401, the same probe succeeds ~3-10s later. 60s is the
 *  value the acceptance run verified green (well under VERIFY_TIMEOUT_MS's
 *  180s total deadline, which still caps the whole poll). */
export const AUTH_PROPAGATION_GRACE_MS = 60_000;

/** Poll cadence between probes. */
export const HEALTH_POLL_INTERVAL_MS = 3_000;

/** Shape of one probe result — mirrors probeVerify in provision-team.ts. */
export type HealthProbeResult = {
	ok: boolean;
	status?: number;
	permanent?: boolean;
	message?: string;
};

/** Poll `probe` until healthy. Returns null on success, or a human error
 *  naming the failing stage. Rules:
 *   - `permanent` fails IMMEDIATELY (no grace — the Worker itself reported an
 *     unrecoverable container error);
 *   - 401/403 keeps polling within `graceMs` (secret propagation, see
 *     AUTH_PROPAGATION_GRACE_MS), then fails with a named auth error;
 *   - anything else (cold start, network) keeps polling until `timeoutMs`. */
export async function pollHealth(opts: {
	probe: () => Promise<HealthProbeResult>;
	timeoutMs: number;
	graceMs?: number;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}): Promise<string | null> {
	const now = opts.now ?? Date.now;
	const sleep =
		opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const graceMs = opts.graceMs ?? AUTH_PROPAGATION_GRACE_MS;
	const start = now();
	const deadline = start + opts.timeoutMs;
	for (;;) {
		const health = await opts.probe();
		if (health.ok) return null;
		if (health.permanent) {
			return `Container start: ${health.message ?? "permanent error"}`;
		}
		if (
			(health.status === 401 || health.status === 403) &&
			now() - start >= graceMs
		) {
			return (
				`Worker auth: the admin token was still rejected after ` +
				`${Math.round(graceMs / 1000)}s (HTTP ${health.status}) — the token ` +
				`the desktop holds doesn't match the Worker secret.`
			);
		}
		if (now() >= deadline) {
			return "Container start: the sandbox didn't finish starting in time.";
		}
		await sleep(HEALTH_POLL_INTERVAL_MS);
	}
}
