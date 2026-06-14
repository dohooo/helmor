/// <reference types="@cloudflare/vitest-pool-workers/types" />
// CodexIdentity Durable Object unit suite — runs INSIDE workerd via
// @cloudflare/vitest-pool-workers, so it exercises the REAL DO storage and the
// REAL WebCrypto `crypto.subtle` AES-GCM (not mocks). The OAuth refresh
// endpoint is the only external dependency; we point the DO's
// CODEX_REFRESH_TOKEN_URL_OVERRIDE at a sentinel URL and intercept `fetch`
// (the DO runs in the same isolate as the test, so a global fetch stub applies
// to it — see the `cloudflare:test` SELF docs).
//
// Coverage maps to the review-finding test plan:
//   (a) AES-GCM encrypt -> decrypt round-trip; wrong-length key fails closed
//   (b) status().accessExp is SECONDS (guards finding #1)
//   (c) two concurrent mints vs a stale cache -> exactly ONE refresh fetch
//   (d) a storage.put failure on the rotated RT -> bricked + refresh_failed
//   (e) 5xx/network -> refresh_failed WITHOUT bricking; 4xx -> bricked
//   (f) status() never returns rt / access_token
// Plus finding #6 (absent account_id -> no_account_id) and #7 (slow-path
// re-checks bricked).

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexIdentity } from "../src/codex-identity";

declare global {
	namespace Cloudflare {
		interface Env {
			CODEX_IDENTITY: DurableObjectNamespace<CodexIdentity>;
			BROKER_ENC_KEY: string;
			CODEX_REFRESH_TOKEN_URL_OVERRIDE?: string;
		}
	}
}

// The sentinel the DO refreshes against in tests (matches the override we set
// per-instance below). Pointing it at example.com guarantees a real network
// call would fail — every test MUST stub fetch, so an unstubbed call surfaces.
const OAUTH_URL = "https://oauth.test.invalid/token";

// ── JWT helpers (base64url, unsigned — the DO decode-only-reads claims) ──────

function b64url(obj: unknown): string {
	const json = JSON.stringify(obj);
	const b64 = btoa(json);
	return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A minimal unsigned JWT carrying the given claims as its payload. */
function jwt(claims: Record<string, unknown>): string {
	return `${b64url({ alg: "none" })}.${b64url(claims)}.`;
}

/** id_token with a chatgpt_account_id claim (+ sub). */
function idToken(accountId: string, sub = "auth0|user-1"): string {
	return jwt({ chatgpt_account_id: accountId, sub });
}

/** access_token whose `exp` claim is `secondsFromNow` in the future (epoch s). */
function accessToken(secondsFromNow: number): string {
	return jwt({ exp: Math.floor(Date.now() / 1000) + secondsFromNow });
}

// ── DO handle helpers ────────────────────────────────────────────────────────

let seq = 0;
/** A fresh DO instance per call (unique name) so tests never share state, even
 *  with isolatedStorage. Sets the OAuth override on every instance. */
function freshStub(): DurableObjectStub<CodexIdentity> {
	seq += 1;
	const id = env.CODEX_IDENTITY.idFromName(`it-${seq}-${Math.random()}`);
	return env.CODEX_IDENTITY.get(id);
}

/** Run a method on the DO instance directly (RPC-style). Forwards both the
 *  instance and its `DurableObjectState` (for tests that seed/read storage). */
function onDo<R>(
	stub: DurableObjectStub<CodexIdentity>,
	fn: (instance: CodexIdentity, state: DurableObjectState) => R | Promise<R>,
): Promise<R> {
	// runInDurableObject can't infer O=CodexIdentity through DurableObjectStub<O>
	// (cloudflare:workers' DurableObject != the ambient workers-types DurableObject,
	// so they don't unify) — the instance arrives as the generic base; re-narrow for fn.
	return runInDurableObject(stub, (instance, state) =>
		fn(instance as unknown as CodexIdentity, state),
	);
}

// ── fetch stubbing ───────────────────────────────────────────────────────────

type FetchHandler = (
	url: string,
	init: RequestInit,
) => Response | Promise<Response>;

/** Install a fetch stub that only answers the OAuth override URL; anything
 *  else throws (so a stray call is loud). Returns a spy for call assertions. */
function stubOAuthFetch(handler: FetchHandler) {
	const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		if (url === OAUTH_URL) return handler(url, init ?? {});
		throw new Error(`unexpected fetch to ${url}`);
	});
	vi.stubGlobal("fetch", spy);
	return spy;
}

function okRefresh(body: {
	access_token?: string;
	id_token?: string;
	refresh_token?: string;
}): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────

describe("CodexIdentity DO", () => {
	// (a) AES-GCM round-trip + fail-closed on a wrong-length key.
	describe("at-rest crypto (AES-GCM)", () => {
		it("encrypts then decrypts the refresh_token (round-trip), never storing plaintext", async () => {
			const stub = freshStub();
			const RT = "rt-roundtrip-секрет-🔐";
			// Round-trip through the DO's own private crypto via a mint flow: put
			// the RT (encrypts at rest), then drive a refresh that decrypts it and
			// echoes it back to the OAuth stub, where we assert the plaintext.
			let seenRt: string | null = null;
			stubOAuthFetch(async (_url, init) => {
				const parsed = JSON.parse(String(init.body)) as {
					refresh_token: string;
				};
				seenRt = parsed.refresh_token;
				return okRefresh({
					access_token: accessToken(240 * 3600),
					id_token: idToken("acct-x"),
					refresh_token: RT, // no rotation
				});
			});

			await onDo(stub, (doi) => doi.putRefreshToken(RT, idToken("acct-x")));
			const mint = await onDo(stub, (doi) => doi.mintAuthJson());
			expect("authJson" in mint).toBe(true);
			// The DO decrypted the stored ciphertext back to the exact plaintext.
			expect(seenRt).toBe(RT);

			// And the at-rest value is ciphertext, not the plaintext RT.
			const stored = await onDo(stub, (_doi, state) =>
				state.storage.get<{ ct: string; iv: string }>("enc:rt"),
			);
			expect(stored).toBeTruthy();
			expect(JSON.stringify(stored)).not.toContain(RT);
		});

		it("fails closed (throws, no plaintext) when BROKER_ENC_KEY is the wrong length", async () => {
			// A 16-byte key (AES-128 raw) is rejected by importKey for AES-256-GCM
			// usage as configured? AES-GCM accepts 128/256, so instead use a
			// non-32/24/16 byte key to force importKey to reject. 10 bytes:
			const stub = env.CODEX_IDENTITY.get(
				env.CODEX_IDENTITY.idFromName(`badkey-${Math.random()}`),
			);
			await expect(
				onDo(stub, async (doi, state) => {
					// Override the key for THIS instance's env via a wrapper: the DO
					// reads this.env.BROKER_ENC_KEY, so monkeypatch it on the instance
					// env. (env is the per-isolate object; mutate then restore.)
					const realKey = (
						doi as unknown as { env: { BROKER_ENC_KEY: string } }
					).env.BROKER_ENC_KEY;
					(
						doi as unknown as { env: { BROKER_ENC_KEY: string } }
					).env.BROKER_ENC_KEY = btoa("0123456789"); // 10 bytes — invalid AES key length
					try {
						// putRefreshToken encrypts -> importKey rejects a 10-byte key.
						await doi.putRefreshToken("rt-should-not-persist", idToken("a"));
					} finally {
						(
							doi as unknown as { env: { BROKER_ENC_KEY: string } }
						).env.BROKER_ENC_KEY = realKey;
					}
					// If we reached here the encrypt did NOT throw — surface as a
					// failure by returning the stored value (should be absent).
					return state.storage.get("enc:rt");
				}),
			).rejects.toThrow();
		});
	});

	// (b) status().accessExp is SECONDS (guards finding #1) + (f) no secrets.
	describe("status()", () => {
		it("returns accessExp in SECONDS, not milliseconds (finding #1)", async () => {
			const stub = freshStub();
			const expSeconds = Math.floor(Date.now() / 1000) + 240 * 3600;
			stubOAuthFetch(async () =>
				okRefresh({
					access_token: jwt({ exp: expSeconds }),
					id_token: idToken("acct-secs"),
				}),
			);
			await onDo(stub, (doi) =>
				doi.putRefreshToken("rt-1", idToken("acct-secs")),
			);
			await onDo(stub, (doi) => doi.mintAuthJson()); // populates the cache

			const status = await onDo(stub, (doi) => doi.status());
			expect(status.accessExp).toBe(expSeconds);
			// Must be seconds, i.e. within a sane epoch-seconds range (≈2025-2030),
			// NOT the ~1e12 a milliseconds value would be.
			expect(status.accessExp).toBeLessThan(5_000_000_000);
			expect(status.accessExp).toBeGreaterThan(1_000_000_000);
		});

		it("never returns the refresh_token or access_token (finding f)", async () => {
			const stub = freshStub();
			stubOAuthFetch(async () =>
				okRefresh({
					access_token: accessToken(240 * 3600),
					id_token: idToken("acct-f"),
				}),
			);
			await onDo(stub, (doi) =>
				doi.putRefreshToken("rt-super-secret", idToken("acct-f")),
			);
			await onDo(stub, (doi) => doi.mintAuthJson());

			const status = (await onDo(stub, (doi) =>
				doi.status(),
			)) as unknown as Record<string, unknown>;
			expect(Object.keys(status).sort()).toEqual([
				"accessExp",
				"accountId",
				"bricked",
				"hasToken",
			]);
			const blob = JSON.stringify(status);
			expect(blob).not.toContain("rt-super-secret");
			// The access_token JWT material must not appear either.
			expect(status).not.toHaveProperty("access_token");
			expect(status).not.toHaveProperty("accessToken");
			expect(status).not.toHaveProperty("refresh_token");
		});
	});

	// (c) two concurrent mints vs a stale cache -> exactly ONE refresh fetch.
	describe("serial lock", () => {
		it("coalesces two concurrent mints to a single refresh (RT rotated once)", async () => {
			const stub = freshStub();
			let rotations = 0;
			const spy = stubOAuthFetch(async (_url, init) => {
				const parsed = JSON.parse(String(init.body)) as {
					refresh_token: string;
				};
				// Each successful refresh rotates the RT to a new value.
				rotations += 1;
				return okRefresh({
					access_token: accessToken(240 * 3600),
					id_token: idToken("acct-c"),
					refresh_token: `rotated-${rotations}-from-${parsed.refresh_token}`,
				});
			});

			await onDo(stub, (doi) =>
				doi.putRefreshToken("rt-initial", idToken("acct-c")),
			);

			// Fire two mints concurrently INSIDE one DO turn so they share the
			// serial lock / promise chain. The second must reuse the freshly
			// cached token rather than POST again.
			const [a, b] = await onDo(stub, (doi) =>
				Promise.all([doi.mintAuthJson(), doi.mintAuthJson()]),
			);

			expect("authJson" in a).toBe(true);
			expect("authJson" in b).toBe(true);
			expect(spy).toHaveBeenCalledTimes(1);
			expect(rotations).toBe(1);
		});
	});

	// (d) storage.put failure on the rotated RT -> bricked + refresh_failed.
	describe("crash-safe persistence", () => {
		it("bricks (and reports refresh_failed) when persisting the rotated RT fails", async () => {
			const stub = freshStub();
			stubOAuthFetch(async () =>
				okRefresh({
					access_token: accessToken(240 * 3600),
					id_token: idToken("acct-d"),
					refresh_token: "rotated-rt-d", // rotation -> triggers the put
				}),
			);
			await onDo(stub, (doi) => doi.putRefreshToken("rt-d", idToken("acct-d")));

			const mint = await onDo(stub, async (doi, state) => {
				// Make the rotated-RT persist throw. The DO writes the new RT via
				// `state.storage.put("enc:rt", ...)`; intercept that single key.
				const realPut = state.storage.put.bind(state.storage);
				vi.spyOn(state.storage, "put").mockImplementation((async (
					k: unknown,
					v?: unknown,
				) => {
					if (k === "enc:rt") throw new Error("disk full");
					return realPut(k as never, v as never);
				}) as typeof state.storage.put);
				return doi.mintAuthJson();
			});

			expect(mint).toEqual({ error: "refresh_failed" });
			const status = await onDo(stub, (doi) => doi.status());
			expect(status.bricked).toBe(true);
		});
	});

	// (e) 5xx / network -> refresh_failed WITHOUT bricking; 4xx -> bricked.
	describe("refresh failure classification", () => {
		it("a 5xx is retryable: refresh_failed, NOT bricked (RT reusable next mint)", async () => {
			const stub = freshStub();
			let calls = 0;
			stubOAuthFetch(async () => {
				calls += 1;
				if (calls === 1) return new Response("upstream boom", { status: 503 });
				// Second mint succeeds with the SAME (un-spent) RT.
				return okRefresh({
					access_token: accessToken(240 * 3600),
					id_token: idToken("acct-e5"),
				});
			});
			await onDo(stub, (doi) =>
				doi.putRefreshToken("rt-e5", idToken("acct-e5")),
			);

			const first = await onDo(stub, (doi) => doi.mintAuthJson());
			expect(first).toEqual({ error: "refresh_failed" });
			const afterFirst = await onDo(stub, (doi) => doi.status());
			expect(afterFirst.bricked).toBe(false); // NOT bricked

			// The RT is reusable: a second mint goes through.
			const second = await onDo(stub, (doi) => doi.mintAuthJson());
			expect("authJson" in second).toBe(true);
		});

		it("a thrown network error is retryable: refresh_failed, NOT bricked", async () => {
			const stub = freshStub();
			let calls = 0;
			stubOAuthFetch(async () => {
				calls += 1;
				if (calls === 1) throw new Error("ECONNRESET");
				return okRefresh({
					access_token: accessToken(240 * 3600),
					id_token: idToken("acct-en"),
				});
			});
			await onDo(stub, (doi) =>
				doi.putRefreshToken("rt-en", idToken("acct-en")),
			);

			const first = await onDo(stub, (doi) => doi.mintAuthJson());
			expect(first).toEqual({ error: "refresh_failed" });
			expect((await onDo(stub, (doi) => doi.status())).bricked).toBe(false);
			const second = await onDo(stub, (doi) => doi.mintAuthJson());
			expect("authJson" in second).toBe(true);
		});

		it("a 4xx bricks the identity (RT rejected: reused/invalidated/revoked)", async () => {
			const stub = freshStub();
			const spy = stubOAuthFetch(
				async () =>
					new Response(JSON.stringify({ error: "refresh_token_reused" }), {
						status: 400,
						headers: { "content-type": "application/json" },
					}),
			);
			await onDo(stub, (doi) =>
				doi.putRefreshToken("rt-e4", idToken("acct-e4")),
			);

			const mint = await onDo(stub, (doi) => doi.mintAuthJson());
			expect(mint).toEqual({ error: "refresh_failed" });
			expect((await onDo(stub, (doi) => doi.status())).bricked).toBe(true);

			// A subsequent mint short-circuits on bricked WITHOUT another POST.
			const again = await onDo(stub, (doi) => doi.mintAuthJson());
			expect(again).toEqual({ error: "bricked" });
			expect(spy).toHaveBeenCalledTimes(1);
		});

		it("never reads the error body (no token echo) on a 4xx", async () => {
			const stub = freshStub();
			// A body that WOULD echo a token if the DO read it.
			let bodyConsumed = false;
			stubOAuthFetch(async () => {
				const res = new Response("LEAKED-RT-IN-BODY", { status: 401 });
				// Track whether the DO consumed the body stream.
				const orig = res.text.bind(res);
				res.text = async () => {
					bodyConsumed = true;
					return orig();
				};
				return res;
			});
			await onDo(stub, (doi) =>
				doi.putRefreshToken("rt-leak", idToken("acct-leak")),
			);
			await onDo(stub, (doi) => doi.mintAuthJson());
			expect(bodyConsumed).toBe(false);
		});
	});

	// Finding #6: absent account_id -> no_account_id (never emit account_id:"").
	describe("account_id requirement (finding #6)", () => {
		it("returns no_account_id when the id_token carries no account claim", async () => {
			const stub = freshStub();
			// Refresh returns an id_token WITHOUT any account_id claim.
			stubOAuthFetch(async () =>
				okRefresh({
					access_token: accessToken(240 * 3600),
					id_token: jwt({ sub: "auth0|no-acct" }), // no chatgpt_account_id
				}),
			);
			// Seed with an id_token that ALSO has no account id, so there's no
			// cached non-empty accountId to fall back on.
			await onDo(stub, (doi) =>
				doi.putRefreshToken("rt-na", jwt({ sub: "auth0|no-acct" })),
			);

			const mint = await onDo(stub, (doi) => doi.mintAuthJson());
			expect(mint).toEqual({ error: "no_account_id" });

			// Must NOT have cached/emitted an empty-account identity.
			const status = await onDo(stub, (doi) => doi.status());
			expect(status.accountId).toBeNull();
		});

		it("does not brick on no_account_id (recoverable via re-auth)", async () => {
			const stub = freshStub();
			stubOAuthFetch(async () =>
				okRefresh({
					access_token: accessToken(240 * 3600),
					id_token: jwt({ sub: "s" }),
				}),
			);
			await onDo(stub, (doi) =>
				doi.putRefreshToken("rt-na2", jwt({ sub: "s" })),
			);
			await onDo(stub, (doi) => doi.mintAuthJson());
			expect((await onDo(stub, (doi) => doi.status())).bricked).toBe(false);
		});
	});

	// Finding #7: the slow path re-checks bricked after acquiring the lock.
	describe("slow path re-checks bricked (finding #7)", () => {
		it("short-circuits to {error:'bricked'} if bricked while queued", async () => {
			const stub = freshStub();
			const spy = stubOAuthFetch(async () =>
				okRefresh({
					access_token: accessToken(240 * 3600),
					id_token: idToken("acct-brk"),
				}),
			);
			await onDo(stub, (doi) =>
				doi.putRefreshToken("rt-brk", idToken("acct-brk")),
			);

			// Mark bricked AFTER the RT is stored but BEFORE the mint refreshes:
			// the slow path must re-read the flag and refuse to POST.
			const mint = await onDo(stub, async (doi, state) => {
				await state.storage.put("bricked", true);
				return doi.mintAuthJson();
			});
			expect(mint).toEqual({ error: "bricked" });
			expect(spy).not.toHaveBeenCalled();
		});
	});

	// putRefreshToken: account-change detection + bricked-clear on re-auth.
	describe("putRefreshToken", () => {
		it("decodes account_id and reports changed=false on first store", async () => {
			const stub = freshStub();
			const res = await onDo(stub, (doi) =>
				doi.putRefreshToken("rt-p", idToken("acct-p")),
			);
			expect(res.accountId).toBe("acct-p");
			expect(res.changed).toBe(false);
		});

		it("reports changed=true when the bound account_id differs", async () => {
			const stub = freshStub();
			await onDo(stub, (doi) =>
				doi.putRefreshToken("rt-1", idToken("acct-old")),
			);
			const res = await onDo(stub, (doi) =>
				doi.putRefreshToken("rt-2", idToken("acct-new")),
			);
			expect(res.changed).toBe(true);
			expect(res.accountId).toBe("acct-new");
		});

		it("clears bricked on re-authorization", async () => {
			const stub = freshStub();
			await onDo(stub, (doi) => doi.putRefreshToken("rt-x", idToken("acct-x")));
			await onDo(stub, (_doi, state) => state.storage.put("bricked", true));
			await onDo(stub, (doi) =>
				doi.putRefreshToken("rt-x2", idToken("acct-x")),
			);
			expect((await onDo(stub, (doi) => doi.status())).bricked).toBe(false);
		});
	});

	describe("mintAuthJson empty states", () => {
		it("returns no_identity before any putRefreshToken", async () => {
			const stub = freshStub();
			expect(await onDo(stub, (doi) => doi.mintAuthJson())).toEqual({
				error: "no_identity",
			});
		});

		it("reuses a cached access_token without a second fetch (fast path)", async () => {
			const stub = freshStub();
			const spy = stubOAuthFetch(async () =>
				okRefresh({
					access_token: accessToken(240 * 3600),
					id_token: idToken("acct-fp"),
				}),
			);
			await onDo(stub, (doi) =>
				doi.putRefreshToken("rt-fp", idToken("acct-fp")),
			);
			await onDo(stub, (doi) => doi.mintAuthJson()); // first: refreshes
			await onDo(stub, (doi) => doi.mintAuthJson()); // second: cache reuse
			expect(spy).toHaveBeenCalledTimes(1);
		});

		it("builds an empty-RT ChatgptAuthTokens auth.json", async () => {
			const stub = freshStub();
			stubOAuthFetch(async () =>
				okRefresh({
					access_token: accessToken(240 * 3600),
					id_token: idToken("acct-shape"),
				}),
			);
			await onDo(stub, (doi) =>
				doi.putRefreshToken("rt-shape", idToken("acct-shape")),
			);
			const mint = await onDo(stub, (doi) => doi.mintAuthJson());
			if (!("authJson" in mint)) throw new Error("expected authJson");
			expect(mint.authJson.auth_mode).toBe("chatgptauthtokens");
			expect(mint.authJson.tokens.refresh_token).toBe(""); // EMPTY RT
			expect(mint.authJson.tokens.account_id).toBe("acct-shape");
			expect(mint.accountId).toBe("acct-shape");
		});
	});
});
