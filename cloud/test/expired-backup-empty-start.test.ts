import type { Sandbox } from "@cloudflare/sandbox";
import { describe, expect, it } from "vitest";
import {
	backupGone,
	ContainerRestoreError,
	type Env,
	ensureServe,
} from "../src/index";

// P1-3a: a team idle >3 days outlives its backup TTL (CF deletes the
// archive) but the D1 backup_handle lives forever. restoreBackup then fails
// every wake and R3-D's (correct for OOM) loud-503 turned that into a
// permanent wedge — for data that was ALREADY gone at expiry, the right
// behavior is: clear the stale handle and cold-start empty, like a brand-new
// team. Expiry is decided by a DETERMINISTIC pre-check against the SDK's own
// R2 metadata (backups/<id>/meta.json, same createdAt+ttl arithmetic) — we
// never interpret a restore FAILURE as expiry, so OOM/timeout/corruption all
// still hit the loud ContainerRestoreError 503 (R3-D preserved).

const HANDLE = JSON.stringify({
	id: "backup-1",
	dir: "/home/helmor",
	localBucket: true,
});

const TTL_SECONDS = 259200; // 3 days — what both backup paths set

function isoDaysAgo(days: number): string {
	return new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
}

function identityNamespace() {
	return {
		idFromName: (name: string) => name,
		get: () => ({}),
	} as unknown as Env["CODEX_IDENTITY"];
}

/** Env with a stored handle, a mockable meta.json in R2, and a recorder for
 *  D1 writes (so tests can assert the stale handle actually got cleared). */
function makeEnv(options: {
	meta: { createdAt: string; ttl: number } | null | "throw";
}): Env & { d1Writes: string[] } {
	const d1Writes: string[] = [];
	const env = {
		DB: {
			prepare: (sql: string) => ({
				bind: () => ({
					first: async () => ({ backup_handle: HANDLE }),
					run: async () => {
						d1Writes.push(sql);
					},
				}),
			}),
		},
		BACKUP_BUCKET: {
			get: async (key: string) => {
				expect(key).toBe("backups/backup-1/meta.json");
				if (options.meta === "throw") throw new Error("r2 transient");
				if (options.meta === null) return null;
				const meta = options.meta;
				return { json: async () => meta };
			},
		},
		HELMOR_SANDBOX_ID: "sandbox-test",
		HELMOR_COMPANION_PORT: "8080",
		HELMOR_COMPANION_TOKEN: "companion-token",
		CODEX_IDENTITY: identityNamespace(),
		CLAUDE_IDENTITY: identityNamespace(),
		BROKER_ENC_KEY: "test",
		Sandbox: {} as Env["Sandbox"],
		d1Writes,
	} as unknown as Env & { d1Writes: string[] };
	return env;
}

function makeSandbox(state: { restoreCalls: number; startCalls: number }) {
	return {
		containerFetch: async () => {
			if (state.startCalls > 0) {
				return new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response(JSON.stringify({}), { status: 503 });
		},
		restoreBackup: async () => {
			state.restoreCalls += 1;
			// What an expired/deleted archive looks like from the Worker: the
			// SDK's typed BackupExpiredError does NOT reliably survive the DO
			// RPC boundary, which is exactly why classification must not
			// depend on it.
			throw new Error("Backup backup-1 has expired. Create a new backup.");
		},
		startProcess: async () => {
			state.startCalls += 1;
		},
	} as unknown as Sandbox;
}

const TIMEOUTS = {
	healthCheckTimeoutMs: 5,
	restoreBackupTimeoutMs: 50,
	startProcessTimeoutMs: 20,
	identityMintTimeoutMs: 5,
	readyTimeoutMs: 200,
	pollIntervalMs: 5,
};

describe("P1-3a expired backup → clean empty start", () => {
	it("EXPIRED meta: skips restore, clears the D1 handle, cold-starts empty", async () => {
		const state = { restoreCalls: 0, startCalls: 0 };
		const env = makeEnv({
			meta: { createdAt: isoDaysAgo(4), ttl: TTL_SECONDS },
		});

		const result = await ensureServe(makeSandbox(state), env, 8080, TIMEOUTS);

		expect(result.coldStarted).toBe(true);
		expect(state.restoreCalls).toBe(0);
		expect(state.startCalls).toBe(1);
		expect(
			env.d1Writes.some((sql) => /backup_handle\s*=\s*NULL/i.test(sql)),
			`stale handle must be cleared, D1 writes: ${JSON.stringify(env.d1Writes)}`,
		).toBe(true);
	});

	it("MISSING meta (archive deleted): same clean empty start + handle clear", async () => {
		const state = { restoreCalls: 0, startCalls: 0 };
		const env = makeEnv({ meta: null });

		const result = await ensureServe(makeSandbox(state), env, 8080, TIMEOUTS);

		expect(result.coldStarted).toBe(true);
		expect(state.restoreCalls).toBe(0);
		expect(
			env.d1Writes.some((sql) => /backup_handle\s*=\s*NULL/i.test(sql)),
		).toBe(true);
	});

	it("VALID meta + failing restore stays LOUD (R3-D regression guard)", async () => {
		const state = { restoreCalls: 0, startCalls: 0 };
		const env = makeEnv({
			meta: { createdAt: isoDaysAgo(0), ttl: TTL_SECONDS },
		});

		await expect(
			ensureServe(makeSandbox(state), env, 8080, TIMEOUTS),
		).rejects.toBeInstanceOf(ContainerRestoreError);
		expect(state.restoreCalls).toBe(1);
		// A live-but-unrestorable backup must NOT be thrown away.
		expect(
			env.d1Writes.some((sql) => /backup_handle\s*=\s*NULL/i.test(sql)),
		).toBe(false);
	});

	it("pre-check mirrors the SDK's 60s expiry buffer exactly", async () => {
		const handle = { id: "backup-1", dir: "/home/helmor", localBucket: true };
		const envAgedSeconds = (age: number) =>
			makeEnv({
				meta: {
					createdAt: new Date(Date.now() - age * 1000).toISOString(),
					ttl: TTL_SECONDS,
				},
			});
		// 2 minutes before nominal expiry: inside the buffer window → the SDK
		// would still restore this, and so must we (null = proceed).
		expect(await backupGone(envAgedSeconds(TTL_SECONDS - 120), handle)).toBe(
			null,
		);
		// 30s before nominal expiry: the SDK's `now + 60s > expiresAt` check
		// would refuse it — the pre-check must agree, not hand it to the loud
		// path.
		expect(await backupGone(envAgedSeconds(TTL_SECONDS - 30), handle)).toBe(
			"expired",
		);
		// Malformed metadata: can't tell → restore decides (loud on failure).
		expect(
			await backupGone(
				makeEnv({
					meta: { createdAt: "not-a-date", ttl: TTL_SECONDS },
				}),
				handle,
			),
		).toBe(null);
	});

	it("R2 pre-check failure is conservative: proceeds to restore (loud on failure)", async () => {
		const state = { restoreCalls: 0, startCalls: 0 };
		const env = makeEnv({ meta: "throw" });

		await expect(
			ensureServe(makeSandbox(state), env, 8080, TIMEOUTS),
		).rejects.toBeInstanceOf(ContainerRestoreError);
		expect(state.restoreCalls).toBe(1);
	});
});
