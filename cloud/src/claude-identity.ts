// Helmor Team Cloud Sandbox — Claude subscription token broker.
//
// A per-member Durable Object that EXCLUSIVELY holds one Claude subscription
// OAuth token (`sk-ant-oat01…`, from `claude setup-token`) and hands it back at
// container cold start to inject as the `CLAUDE_CODE_OAUTH_TOKEN` env var.
//
// Structural twin of `codex-identity.ts` with FAR simpler organs. The Claude
// `setup-token` credential is a self-contained, ~1-year, inference-only access
// token (see .agent-contexts/team-cloud-sandbox/claude-cloud-auth-VERIFIED.md
// §1.2/§1.3): inject-and-forget. There is therefore NO refresh endpoint, NO
// serial-lock / crash-safe rotation, NO `account_id` / JWT decode, and NO
// `bricked` state — all of which the Codex broker needs and this one drops.
//
// SECURITY INVARIANTS (the whole point of this module — mirror Codex exactly):
//   - The OAuth token is encrypted at rest (AES-GCM, key derived from
//     BROKER_ENC_KEY, REUSING the same secret as the Codex broker). Plaintext
//     lives only transiently in DO memory during a `store`/`mintToken`.
//   - The token is NEVER logged, NEVER returned to the frontend, NEVER written
//     to the container or D1 in plaintext. `status()` returns metadata only
//     (`{ hasToken }`) — never the token.
//   - The env-var NAME (`CLAUDE_CODE_OAUTH_TOKEN`) is the entire contract on the
//     injection side; the value is consumed verbatim by claude-code (VERIFIED
//     §1.1) — there is NO auth_mode/format discriminator to mis-case (the trap
//     that broke the Codex `chatgptAuthTokens` path).

import { DurableObject } from "cloudflare:workers";

/** Storage keys. The token is stored ONLY in encrypted form (`enc:oauth_token`). */
const KEY_ENC_TOKEN = "enc:oauth_token"; // { ct: base64, iv: base64 } — AES-GCM
const KEY_UPDATED_AT = "updated_at"; // ISO string

/** The minimal env this DO needs. The orchestrator merges these fields into the
 *  Worker's `Env` (see ./index Env); typed locally to keep this module
 *  self-contained and decoupled from the shared `./index` Env surface. */
export interface ClaudeIdentityEnv {
	/** Base64-encoded 32-byte AES-GCM key. Worker secret. SHARED with the Codex
	 *  broker. NEVER enters the container / D1 / frontend. */
	BROKER_ENC_KEY: string;
}

/** Encrypted-at-rest envelope for the OAuth token. */
interface EncEnvelope {
	ct: string; // base64 ciphertext
	iv: string; // base64 12-byte GCM nonce
}

export type PutResult = { changed: boolean };

export type MintResult = { token: string } | { error: "no_identity" };

export interface StatusResult {
	hasToken: boolean;
}

export class ClaudeIdentity extends DurableObject<ClaudeIdentityEnv> {
	/**
	 * Store the member's Claude subscription OAuth token, encrypted at rest.
	 * Reports `changed=true` when a token was already stored (identity hygiene
	 * only — never blocks). Atomically replaces any prior token.
	 *
	 * Unlike the Codex `putRefreshToken`, there is NO id_token to decode, NO
	 * `account_id`/`sub` to derive, and NO `bricked` flag to clear (the token is
	 * self-contained and inference-only — VERIFIED §1.2/§1.7).
	 *
	 * SECURITY: `oauthToken` is NEVER logged here or anywhere.
	 */
	async store(oauthToken: string): Promise<PutResult> {
		const prev = await this.ctx.storage.get<EncEnvelope>(KEY_ENC_TOKEN);
		const changed = Boolean(prev);

		const enc = await this.encryptToken(oauthToken);
		await this.ctx.storage.put({
			[KEY_ENC_TOKEN]: enc,
			[KEY_UPDATED_AT]: new Date().toISOString(),
		});

		return { changed };
	}

	/**
	 * Mint the OAuth token for container cold-start injection as
	 * `CLAUDE_CODE_OAUTH_TOKEN`. Decrypts and returns the stored token verbatim.
	 *
	 * NO fetch, NO `runSerial` lock, NO crash-safe rotation, NO cache/exp (the
	 * token is self-contained and good ~1 year — VERIFIED §1.3): a plain
	 * decrypt-and-return. The DO is single-threaded and there is no awaited
	 * network call between read and use, so there is no concurrency hazard even
	 * without an explicit lock.
	 *
	 *   - no token stored -> { error: 'no_identity' }
	 *   - else            -> { token } (the decrypted token)
	 */
	async mintToken(): Promise<MintResult> {
		const enc = await this.ctx.storage.get<EncEnvelope>(KEY_ENC_TOKEN);
		if (!enc) return { error: "no_identity" };
		return { token: await this.decryptToken(enc) };
	}

	/**
	 * Return identity metadata for the settings panel. NEVER returns the OAuth
	 * token. Metadata only: `{ hasToken }`.
	 */
	async status(): Promise<StatusResult> {
		const enc = await this.ctx.storage.get<EncEnvelope>(KEY_ENC_TOKEN);
		return { hasToken: Boolean(enc) };
	}

	// ── crypto (AES-GCM, key from env.BROKER_ENC_KEY) ────────────────────────
	// Copied verbatim from codex-identity.ts (same primitive, same shared key).

	private async importKey(): Promise<CryptoKey> {
		// Fresh-deployment guard (round6 P1-1b) — same as codex-identity.ts.
		if (!this.env.BROKER_ENC_KEY) {
			throw new Error(
				"BROKER_ENC_KEY is not configured on this Worker — re-run team setup (provisioning generates it), then authorize again.",
			);
		}
		const raw = base64ToBytes(this.env.BROKER_ENC_KEY);
		return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
			"encrypt",
			"decrypt",
		]);
	}

	private async encryptToken(oauthToken: string): Promise<EncEnvelope> {
		const key = await this.importKey();
		const iv = crypto.getRandomValues(new Uint8Array(12));
		const ct = await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv },
			key,
			new TextEncoder().encode(oauthToken),
		);
		return { ct: bytesToBase64(new Uint8Array(ct)), iv: bytesToBase64(iv) };
	}

	private async decryptToken(enc: EncEnvelope): Promise<string> {
		const key = await this.importKey();
		const plain = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: base64ToBytes(enc.iv) },
			key,
			base64ToBytes(enc.ct),
		);
		return new TextDecoder().decode(plain);
	}
}

// ── pure helpers (copied verbatim from codex-identity.ts) ─────────────────────

function base64ToBytes(b64: string): Uint8Array {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i++)
		binary += String.fromCharCode(bytes[i]);
	return btoa(binary);
}
