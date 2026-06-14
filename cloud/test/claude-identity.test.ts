/// <reference types="@cloudflare/vitest-pool-workers/types" />
// ClaudeIdentity Durable Object unit suite — runs INSIDE workerd via
// @cloudflare/vitest-pool-workers, so it exercises the REAL DO storage and the
// REAL WebCrypto `crypto.subtle` AES-GCM (not mocks).
//
// The Claude broker is the structural twin of CodexIdentity but FAR simpler:
// the `setup-token` credential is a self-contained ~1-year token (no refresh,
// no serial lock, no account_id, no bricked state — see
// .agent-contexts/team-cloud-sandbox/claude-cloud-auth-VERIFIED.md). So there
// is NO network dependency to stub: `mintToken()` is a plain decrypt-and-return.
//
// Coverage:
//   (a) AES-GCM encrypt -> decrypt round-trip; at-rest value is ciphertext,
//       never the plaintext token; wrong-length key fails closed
//   (b) store/mintToken/status happy paths
//   (c) store() reports changed=false on first store, changed=true on re-store
//   (d) mintToken() -> { error: "no_identity" } before any store
//   (e) THE NO-LEAK INVARIANT: status() returns ONLY { hasToken } — never the
//       token (mirrors the Codex finding-f test)

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { ClaudeIdentity } from "../src/claude-identity";

declare global {
	namespace Cloudflare {
		interface Env {
			CLAUDE_IDENTITY: DurableObjectNamespace<ClaudeIdentity>;
			BROKER_ENC_KEY: string;
		}
	}
}

// A representative `claude setup-token` token (loose `sk-ant-` shape; the broker
// stores the value verbatim and never validates the prefix — VERIFIED §1.2).
const OAUTH_TOKEN = "sk-ant-oat01-роскошный-токен-🔐-abcDEF0123456789_-";

// ── DO handle helpers (mirror codex-identity.test.ts) ─────────────────────────

let seq = 0;
/** A fresh DO instance per call (unique name) so tests never share state, even
 *  with isolatedStorage. */
function freshStub(): DurableObjectStub<ClaudeIdentity> {
	seq += 1;
	const id = env.CLAUDE_IDENTITY.idFromName(`it-${seq}-${Math.random()}`);
	return env.CLAUDE_IDENTITY.get(id);
}

/** Run a method on the DO instance directly (RPC-style). Forwards both the
 *  instance and its `DurableObjectState` (for tests that read storage). */
function onDo<R>(
	stub: DurableObjectStub<ClaudeIdentity>,
	fn: (instance: ClaudeIdentity, state: DurableObjectState) => R | Promise<R>,
): Promise<R> {
	// runInDurableObject can't infer O=ClaudeIdentity through DurableObjectStub<O>
	// (cloudflare:workers' DurableObject != the ambient workers-types DurableObject,
	// so they don't unify) — the instance arrives as the generic base; re-narrow for fn.
	return runInDurableObject(stub, (instance, state) =>
		fn(instance as unknown as ClaudeIdentity, state),
	);
}

// ─────────────────────────────────────────────────────────────────────────────

describe("ClaudeIdentity DO", () => {
	// (a) AES-GCM round-trip + at-rest ciphertext + fail-closed on a bad key.
	describe("at-rest crypto (AES-GCM)", () => {
		it("encrypts then decrypts the token (round-trip), never storing plaintext", async () => {
			const stub = freshStub();
			await onDo(stub, (doi) => doi.store(OAUTH_TOKEN));

			// mintToken decrypts the stored ciphertext back to the exact plaintext.
			const mint = await onDo(stub, (doi) => doi.mintToken());
			if (!("token" in mint)) throw new Error("expected token");
			expect(mint.token).toBe(OAUTH_TOKEN);

			// And the at-rest value is ciphertext, not the plaintext token.
			const stored = await onDo(stub, (_doi, state) =>
				state.storage.get<{ ct: string; iv: string }>("enc:oauth_token"),
			);
			expect(stored).toBeTruthy();
			expect(JSON.stringify(stored)).not.toContain(OAUTH_TOKEN);
			// The token never lands under a plaintext storage key either.
			const raw = await onDo(stub, (_doi, state) => state.storage.list());
			expect(JSON.stringify([...raw.values()])).not.toContain(OAUTH_TOKEN);
		});

		it("fails closed (throws, no plaintext) when BROKER_ENC_KEY is the wrong length", async () => {
			const stub = env.CLAUDE_IDENTITY.get(
				env.CLAUDE_IDENTITY.idFromName(`badkey-${Math.random()}`),
			);
			await expect(
				onDo(stub, async (doi, state) => {
					// The DO reads this.env.BROKER_ENC_KEY; monkeypatch it on the
					// instance env to a non-16/24/32-byte value so importKey rejects.
					const realKey = (
						doi as unknown as { env: { BROKER_ENC_KEY: string } }
					).env.BROKER_ENC_KEY;
					(
						doi as unknown as { env: { BROKER_ENC_KEY: string } }
					).env.BROKER_ENC_KEY = btoa("0123456789"); // 10 bytes — invalid AES key length
					try {
						// store() encrypts -> importKey rejects a 10-byte key.
						await doi.store("tok-should-not-persist");
					} finally {
						(
							doi as unknown as { env: { BROKER_ENC_KEY: string } }
						).env.BROKER_ENC_KEY = realKey;
					}
					// If we reached here the encrypt did NOT throw — surface as a
					// failure by returning the stored value (should be absent).
					return state.storage.get("enc:oauth_token");
				}),
			).rejects.toThrow();
		});
	});

	// (b) store / mintToken / status happy paths.
	describe("store + mintToken + status", () => {
		it("stores a token then mints it back", async () => {
			const stub = freshStub();
			const put = await onDo(stub, (doi) => doi.store(OAUTH_TOKEN));
			expect(put).toEqual({ changed: false });

			const status = await onDo(stub, (doi) => doi.status());
			expect(status).toEqual({ hasToken: true });

			const mint = await onDo(stub, (doi) => doi.mintToken());
			expect(mint).toEqual({ token: OAUTH_TOKEN });
		});

		it("re-store replaces the token and reports changed=true", async () => {
			const stub = freshStub();
			await onDo(stub, (doi) => doi.store("sk-ant-oat01-first"));
			const second = await onDo(stub, (doi) =>
				doi.store("sk-ant-oat01-second"),
			);
			expect(second).toEqual({ changed: true });

			const mint = await onDo(stub, (doi) => doi.mintToken());
			expect(mint).toEqual({ token: "sk-ant-oat01-second" });
		});
	});

	// (c) empty states.
	describe("empty states", () => {
		it("mintToken returns no_identity before any store", async () => {
			const stub = freshStub();
			expect(await onDo(stub, (doi) => doi.mintToken())).toEqual({
				error: "no_identity",
			});
		});

		it("status reports hasToken=false before any store", async () => {
			const stub = freshStub();
			expect(await onDo(stub, (doi) => doi.status())).toEqual({
				hasToken: false,
			});
		});
	});

	// (e) THE NO-LEAK INVARIANT — status() never returns the token.
	describe("status() never leaks the token", () => {
		it("returns ONLY { hasToken }, never the token material", async () => {
			const stub = freshStub();
			await onDo(stub, (doi) => doi.store(OAUTH_TOKEN));

			const status = (await onDo(stub, (doi) =>
				doi.status(),
			)) as unknown as Record<string, unknown>;
			expect(Object.keys(status).sort()).toEqual(["hasToken"]);
			const blob = JSON.stringify(status);
			expect(blob).not.toContain(OAUTH_TOKEN);
			expect(blob).not.toContain("sk-ant-");
			expect(status).not.toHaveProperty("token");
			expect(status).not.toHaveProperty("oauthToken");
			expect(status).not.toHaveProperty("oauth_token");
		});
	});
});
