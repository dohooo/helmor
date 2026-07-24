// Decision logic for provisioning the BROKER_ENC_KEY Worker secret — the
// AES-256-GCM key all three identity brokers (Codex / Claude / Forge Durable
// Objects) encrypt member credentials with. Pure functions: unit-tested in
// cloud/test/broker-key.test.ts, consumed by provision-team.ts.
//
// ⚠️ HARD SAFETY CONSTRAINT (round6 P1-1b): the key is written ONLY when it is
// confidently absent. Re-putting an existing key ROTATES it and bricks every
// already-stored identity (their ciphertexts become undecryptable). When the
// existence check is inconclusive, the provision run FAILS — it never
// blind-writes.

export type SecretListOutcome =
	| { kind: "ok"; names: string[] }
	| { kind: "error"; output: string };

export type BrokerKeyAction = "skip" | "put" | "fail";

/** wrangler's "worker doesn't exist yet" signal, observed live on wrangler
 *  4.100.0: `✘ [ERROR] Worker "helmor-team" not found.` (ANSI color codes wrap
 *  the line; the inner text is contiguous, so the regex matches raw output).
 *  A missing Worker means a FRESH deployment — no secret can exist on a Worker
 *  that doesn't — so writing the key is safe on this branch. */
const WORKER_NOT_FOUND = /worker "[^"]*" not found/i;

/** The four branches (in order): key present → skip; key absent → put; list
 *  failed because the Worker doesn't exist (fresh account) → put; list failed
 *  for ANY other reason (network, auth, unparseable output) → fail the whole
 *  provision rather than risk rotating an existing key. */
export function decideBrokerKeyAction(
	outcome: SecretListOutcome,
): BrokerKeyAction {
	if (outcome.kind === "ok") {
		return outcome.names.includes("BROKER_ENC_KEY") ? "skip" : "put";
	}
	return WORKER_NOT_FOUND.test(outcome.output) ? "put" : "fail";
}

/** Map a raw `wrangler secret list` result to a decision input. Success means
 *  exit 0 AND parseable stdout — an exit-0 run whose output we can't read is
 *  an error outcome (→ fail), never a guess. */
export function toSecretListOutcome(result: {
	code: number;
	stdout: string;
	stderr: string;
}): SecretListOutcome {
	if (result.code !== 0) {
		return { kind: "error", output: `${result.stdout}\n${result.stderr}` };
	}
	const names = parseSecretList(result.stdout);
	if (names === null) {
		return {
			kind: "error",
			output: `unparseable secret list output:\n${result.stdout}`,
		};
	}
	return { kind: "ok", names };
}

/** Parse `wrangler secret list` stdout — a JSON array of `{name, type}`
 *  entries (format observed live on wrangler 4.100.0). Tolerates banner noise
 *  before the array; returns null when no well-formed array is found. */
export function parseSecretList(stdout: string): string[] | null {
	const raw = stdout.trim();
	for (const candidate of [raw, raw.slice(raw.indexOf("["))]) {
		if (!candidate.startsWith("[")) continue;
		try {
			const parsed: unknown = JSON.parse(candidate);
			if (!Array.isArray(parsed)) return null;
			return parsed
				.map((entry) =>
					typeof (entry as { name?: unknown }).name === "string"
						? ((entry as { name: string }).name satisfies string)
						: "",
				)
				.filter(Boolean);
		} catch {
			// fall through to the sliced candidate
		}
	}
	return null;
}
