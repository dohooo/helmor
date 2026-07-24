// Helmor Team Cloud Sandbox — per-member forge (gh/glab) credential broker.
//
// A per-member Durable Object that holds ONE member's forge credentials (a gh
// OAuth/PAT and/or a glab config.yml) encrypted at rest, and hands them back at
// container cold start so the serve host can authenticate git/gh/glab AS THAT
// MEMBER (true per-member: A's push uses A's token). Keyed by the member's
// GitHub numeric id (`idFromName(memberId)`), exactly like the Claude/Codex
// brokers.
//
// SECURITY INVARIANTS (mirror claude-identity.ts):
//   - Credentials encrypted at rest (AES-GCM, key from BROKER_ENC_KEY, SHARED
//     with the Codex/Claude brokers). Plaintext lives only transiently in DO
//     memory during a store/mint.
//   - Tokens are NEVER logged, NEVER returned to the frontend. `status()`
//     returns metadata only (`{ hasGithub, glabHosts }`) — never a token.
//   - The glab host list in `status()` is non-secret (host names only), parsed
//     from the config so the settings panel can show what's connected.

import { DurableObject } from "cloudflare:workers";
import {
	type ForgeIdentityInput,
	type ForgeIdentityStatus,
	forgeStatusFromInput,
} from "./forge-config";

/** Storage keys. The credentials live ONLY in encrypted form (`enc:payload`);
 *  `meta` holds the non-secret status surface. */
const KEY_ENC_PAYLOAD = "enc:payload"; // { ct, iv } — AES-GCM of JSON(ForgeIdentityInput)
const KEY_META = "meta"; // ForgeIdentityStatus (non-secret)
const KEY_UPDATED_AT = "updated_at"; // ISO string

export interface ForgeIdentityEnv {
	/** Base64-encoded 32-byte AES-GCM key. Worker secret. SHARED with the
	 *  Codex/Claude brokers. NEVER enters the container / D1 / frontend. */
	BROKER_ENC_KEY: string;
}

interface EncEnvelope {
	ct: string; // base64 ciphertext
	iv: string; // base64 12-byte GCM nonce
}

export type PutResult = { changed: boolean };

export type MintResult = ForgeIdentityInput | { error: "no_identity" };

export class ForgeIdentity extends DurableObject<ForgeIdentityEnv> {
	/**
	 * Store the member's forge credentials, encrypted at rest. The input merges
	 * over any prior payload (so a gh-only re-auth keeps an existing glab config
	 * and vice-versa). Reports `changed=true` when a payload was already stored.
	 *
	 * SECURITY: tokens / config are NEVER logged.
	 */
	async store(input: ForgeIdentityInput): Promise<PutResult> {
		const prev = await this.readPayload();
		const merged: ForgeIdentityInput = {
			githubToken: input.githubToken ?? prev?.githubToken,
			glabConfigYml: input.glabConfigYml ?? prev?.glabConfigYml,
		};
		const enc = await this.encrypt(JSON.stringify(merged));
		await this.ctx.storage.put({
			[KEY_ENC_PAYLOAD]: enc,
			[KEY_META]: forgeStatusFromInput(merged),
			[KEY_UPDATED_AT]: new Date().toISOString(),
		});
		return { changed: Boolean(prev) };
	}

	/**
	 * Return the decrypted credentials for cold-start injection. No fetch, no
	 * lock (the DO is single-threaded; no awaited network call between read and
	 * use). `{ error: 'no_identity' }` when nothing is stored.
	 */
	async mint(): Promise<MintResult> {
		const payload = await this.readPayload();
		return payload ?? { error: "no_identity" };
	}

	/** Non-secret status for the settings panel. NEVER returns a token. */
	async status(): Promise<ForgeIdentityStatus> {
		const meta = await this.ctx.storage.get<ForgeIdentityStatus>(KEY_META);
		return meta ?? { hasGithub: false, glabHosts: [] };
	}

	private async readPayload(): Promise<ForgeIdentityInput | null> {
		const enc = await this.ctx.storage.get<EncEnvelope>(KEY_ENC_PAYLOAD);
		if (!enc) return null;
		return JSON.parse(await this.decrypt(enc)) as ForgeIdentityInput;
	}

	// ── crypto (AES-GCM, key from env.BROKER_ENC_KEY) ────────────────────────
	// Same primitive + shared key as claude-identity.ts / codex-identity.ts.

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

	private async encrypt(plaintext: string): Promise<EncEnvelope> {
		const key = await this.importKey();
		const iv = crypto.getRandomValues(new Uint8Array(12));
		const ct = await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv },
			key,
			new TextEncoder().encode(plaintext),
		);
		return { ct: bytesToBase64(new Uint8Array(ct)), iv: bytesToBase64(iv) };
	}

	private async decrypt(enc: EncEnvelope): Promise<string> {
		const key = await this.importKey();
		const plain = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: base64ToBytes(enc.iv) },
			key,
			base64ToBytes(enc.ct),
		);
		return new TextDecoder().decode(plain);
	}
}

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
