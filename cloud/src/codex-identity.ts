// Helmor Team Cloud Sandbox — Codex subscription token broker (Phase 1).
//
// A per-user Durable Object that EXCLUSIVELY holds one ChatGPT subscription
// OAuth `refresh_token` (RT) and mints short-lived ChatgptAuthTokens auth.json
// for the container on cold start. Design: .agent-contexts/team-cloud-sandbox/
// phase1-broker-design.md (§3.1 / §3.3 / §9.A — this file IS §9.A).
//
// SECURITY INVARIANTS (the whole point of this module):
//   - The RT is encrypted at rest (AES-GCM, key derived from BROKER_ENC_KEY).
//     Plaintext RT lives only transiently in DO memory during a refresh.
//   - The RT is NEVER logged, NEVER returned to the frontend, NEVER written to
//     the container or D1 in plaintext. `status()` returns metadata only.
//   - The injected auth.json carries an EMPTY refresh_token, so codex is
//     structurally unable to self-refresh inside the container (design fact #2):
//     all rotation happens here, in the control plane.
//   - Rotation is single-use-safe: concurrent mints are serialized (promise
//     chain) so two refreshes can never interleave and brick the RT (fact #4).
//   - Crash-safe order: a new RT is persisted (await storage.put) BEFORE it is
//     used or cached. A persist failure bricks the identity rather than risk
//     using an unpersisted RT; the OLD RT is never retried (it may be spent).

import { DurableObject } from "cloudflare:workers";

/** The OpenAI public client that can self-refresh (no secret, no PKCE) —
 *  design §1 fact #1, sourced from codex `codex-rs/login/manager.rs`. */
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_REFRESH_TOKEN_URL = "https://auth.openai.com/oauth/token";

/** Reuse a cached access_token while it has more than this slack before exp.
 *  Below it (or absent) we refresh once, under the serial lock. */
const ACCESS_TOKEN_REUSE_SLACK_MS = 30 * 60 * 1000; // 30 minutes

/** Storage keys. The RT is stored ONLY in encrypted form (`enc:rt`). */
const KEY_ENC_RT = "enc:rt"; // { ct: base64, iv: base64 } — AES-GCM ciphertext
const KEY_ACCOUNT_ID = "account_id";
const KEY_SUB = "sub";
const KEY_ACCESS_TOKEN = "access_token"; // cached, short-lived
const KEY_ID_TOKEN = "id_token"; // cached, paired with access_token
const KEY_ACCESS_EXP = "access_exp"; // epoch ms (from access_token JWT exp)
const KEY_UPDATED_AT = "updated_at"; // ISO string
const KEY_BRICKED = "bricked"; // boolean — needs re-authorization

/** The minimal env this DO needs. The orchestrator merges these fields into the
 *  Worker's `Env` (see integration_notes); typed locally to keep this module
 *  self-contained and decoupled from the shared `./index` Env surface. */
export interface CodexIdentityEnv {
	/** Base64-encoded 32-byte AES-GCM key. Worker secret. NEVER enters the
	 *  container / D1 / frontend. */
	BROKER_ENC_KEY: string;
	/** Override the OAuth token endpoint (tests / spike). Falls back to the
	 *  hard-coded OpenAI endpoint. */
	CODEX_REFRESH_TOKEN_URL_OVERRIDE?: string;
}

/** Encrypted-at-rest envelope for the refresh_token. */
interface EncEnvelope {
	ct: string; // base64 ciphertext
	iv: string; // base64 12-byte GCM nonce
}

/** ChatgptAuthTokens auth.json shape codex accepts (design §1 fact #2). The
 *  `refresh_token` is ALWAYS empty in the injected form. */
export interface ChatgptAuthJson {
	auth_mode: "chatgptAuthTokens";
	tokens: {
		id_token: string;
		access_token: string;
		refresh_token: "";
		account_id: string;
	};
	last_refresh: string;
}

/** OAuth token endpoint response (only the fields we consume). */
interface RefreshResponse {
	access_token?: string;
	id_token?: string;
	refresh_token?: string;
}

export type PutResult = { accountId: string | null; changed: boolean };

export type MintResult =
	| { authJson: ChatgptAuthJson; accountId: string }
	| { error: "no_identity" | "no_account_id" | "bricked" | "refresh_failed" };

export interface StatusResult {
	hasToken: boolean;
	accountId: string | null;
	/** Cached access-token expiry as a unix epoch in SECONDS (the JWT `exp`
	 *  claim), or null when no token is cached. Stored internally in ms; `status`
	 *  converts down so the frontend contract (seconds) holds. */
	accessExp: number | null;
	bricked: boolean;
}

export class CodexIdentity extends DurableObject<CodexIdentityEnv> {
	/** Promise-chain mutex. DO is single-threaded, but `mintAuthJson` awaits a
	 *  network refresh; without this, two concurrent cold-start mints could
	 *  interleave their `fetch`es and double-spend / brick the RT (fact #4).
	 *  Every refresh runs strictly after the previous one settles. */
	private refreshChain: Promise<unknown> = Promise.resolve();

	/**
	 * Store the user's subscription refresh_token, encrypted at rest. Decodes the
	 * id_token for `account_id` (+ `sub` for same-account hygiene). Clears the
	 * `bricked` flag (a fresh authorization recovers a bricked identity). Reports
	 * `changed=true` when the account_id differs from a previously-stored one
	 * (identity hygiene only — never blocks; design §8 / §9.A).
	 *
	 * SECURITY: `refreshToken` / `idToken` are NEVER logged here or anywhere.
	 */
	async putRefreshToken(
		refreshToken: string,
		idToken: string,
	): Promise<PutResult> {
		const accountId = decodeAccountId(idToken);
		const sub = decodeClaim(idToken, "sub");

		const prevAccountId =
			(await this.ctx.storage.get<string>(KEY_ACCOUNT_ID)) ?? null;
		const changed =
			prevAccountId !== null &&
			accountId !== null &&
			prevAccountId !== accountId;

		const enc = await this.encryptRt(refreshToken);

		// Atomically replace the identity. Clear the cached access token / exp:
		// the new RT lineage invalidates any token minted from the old one, and
		// `bricked` is cleared because re-authorization is the recovery path.
		await this.ctx.storage.put({
			[KEY_ENC_RT]: enc,
			[KEY_ACCOUNT_ID]: accountId,
			[KEY_SUB]: sub,
			[KEY_UPDATED_AT]: new Date().toISOString(),
			[KEY_BRICKED]: false,
		});
		await this.ctx.storage.delete([
			KEY_ACCESS_TOKEN,
			KEY_ID_TOKEN,
			KEY_ACCESS_EXP,
		]);

		return { accountId, changed };
	}

	/**
	 * Mint a ChatgptAuthTokens auth.json (empty RT) for container cold-start
	 * injection (design §3.3). Reuses a cached access_token while it still has
	 * >30min of life; otherwise refreshes ONCE under the serial lock.
	 *
	 *   - no RT stored        -> { error: 'no_identity' }
	 *   - bricked             -> { error: 'bricked' }
	 *   - no account_id        -> { error: 'no_account_id' } (account_id is
	 *                            REQUIRED — design fact #2; never emit "")
	 *   - cache fresh enough   -> reuse (NO refresh, RT untouched)
	 *   - else                -> serialized refresh; persist NEW rt FIRST, then
	 *                            cache access/id, then build authJson
	 *   - persist failure      -> set bricked, { error: 'refresh_failed' }
	 *                            (NEVER retry with the old, possibly-spent RT)
	 */
	async mintAuthJson(): Promise<MintResult> {
		if (await this.ctx.storage.get<boolean>(KEY_BRICKED)) {
			return { error: "bricked" };
		}
		const enc = await this.ctx.storage.get<EncEnvelope>(KEY_ENC_RT);
		if (!enc) return { error: "no_identity" };

		const accountId =
			(await this.ctx.storage.get<string>(KEY_ACCOUNT_ID)) ?? "";

		// Fast path: reuse a still-fresh cached access_token without touching the
		// RT or the network (the common case — access tokens live ~10 days, §1#5).
		// Requires a non-empty account_id (design fact #2): codex needs it in the
		// auth.json, so a "" would inject a broken identity — fall through to the
		// refresh path (which may decode a fresh account_id) instead.
		const cachedAccess = await this.ctx.storage.get<string>(KEY_ACCESS_TOKEN);
		const cachedId = await this.ctx.storage.get<string>(KEY_ID_TOKEN);
		const cachedExp = await this.ctx.storage.get<number>(KEY_ACCESS_EXP);
		if (
			accountId &&
			cachedAccess &&
			cachedId &&
			cachedExp &&
			cachedExp > Date.now() + ACCESS_TOKEN_REUSE_SLACK_MS
		) {
			return {
				authJson: buildAuthJson(cachedId, cachedAccess, accountId),
				accountId,
			};
		}

		// Slow path: refresh under the serial lock. Chain off the previous refresh
		// so concurrent mints never interleave their network calls.
		return this.runSerial(() => this.refreshAndBuild(enc, accountId));
	}

	/**
	 * Return identity metadata for the settings panel. NEVER returns the
	 * refresh_token or access_token (design §3.1 / §9.A).
	 */
	async status(): Promise<StatusResult> {
		const [enc, accountId, accessExp, bricked] = await Promise.all([
			this.ctx.storage.get<EncEnvelope>(KEY_ENC_RT),
			this.ctx.storage.get<string>(KEY_ACCOUNT_ID),
			this.ctx.storage.get<number>(KEY_ACCESS_EXP),
			this.ctx.storage.get<boolean>(KEY_BRICKED),
		]);
		return {
			hasToken: Boolean(enc),
			accountId: accountId ?? null,
			// `access_exp` is stored as epoch MILLISECONDS (the internal form the
			// `now+30min` reuse comparison needs). The frontend contract is epoch
			// SECONDS (team-api `CloudCodexIdentityStatus.accessExp`), so convert
			// here — emitting ms would be ~1000x off and the expiry gate would
			// never fire.
			accessExp: accessExp != null ? Math.floor(accessExp / 1000) : null,
			bricked: Boolean(bricked),
		};
	}

	// ── internals ──────────────────────────────────────────────────────────

	/** Serialize `task` after every previously-queued one (promise-chain mutex).
	 *  The chain is kept alive even if a task rejects, so a failed refresh never
	 *  wedges later mints. */
	private runSerial<T>(task: () => Promise<T>): Promise<T> {
		const run = this.refreshChain.then(task, task);
		// Swallow rejection on the CHAIN link only (the caller still sees it via
		// `run`); otherwise an unhandled rejection would poison the next link.
		this.refreshChain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	/**
	 * Decrypt the RT, POST a refresh, and — crash-safely — persist any NEW RT
	 * BEFORE caching the access token or building auth.json. Runs inside the
	 * serial lock (called only via `runSerial`).
	 */
	private async refreshAndBuild(
		enc: EncEnvelope,
		accountId: string,
	): Promise<MintResult> {
		// Re-check the cache: a concurrent mint queued ahead of us may have just
		// refreshed, making a second network call unnecessary (and a needless RT
		// rotation).
		const freshAccess = await this.ctx.storage.get<string>(KEY_ACCESS_TOKEN);
		const freshId = await this.ctx.storage.get<string>(KEY_ID_TOKEN);
		const freshExp = await this.ctx.storage.get<number>(KEY_ACCESS_EXP);
		if (
			accountId &&
			freshAccess &&
			freshId &&
			freshExp &&
			freshExp > Date.now() + ACCESS_TOKEN_REUSE_SLACK_MS
		) {
			return {
				authJson: buildAuthJson(freshId, freshAccess, accountId),
				accountId,
			};
		}

		// Re-read the bricked flag: a peer link queued ahead of us may have bricked
		// the identity mid-queue (e.g. a 4xx refresh). Short-circuit rather than
		// fire a doomed second POST of a now-dead RT (design §3.3).
		if (await this.ctx.storage.get<boolean>(KEY_BRICKED)) {
			return { error: "bricked" };
		}

		const refreshToken = await this.decryptRt(enc);

		let resp: RefreshResponse;
		try {
			resp = await this.postRefresh(refreshToken);
		} catch {
			// Transient: a network failure or a 5xx (endpoint up but erroring). The
			// RT was NOT consumed, so this is retryable — do NOT brick; the old RT
			// stays valid for the next mint (design §3.3: only a rejected/spent RT
			// or a persist failure bricks).
			return { error: "refresh_failed" };
		}

		if (!resp.access_token || !resp.id_token) {
			// The endpoint accepted the request (2xx) but returned an unusable body
			// with no token material. Treat as a rejected RT — we cannot recover by
			// retrying the same RT, so brick and force re-authorization (design
			// §3.3). A 4xx (reused/invalidated/revoked) reaches here via postRefresh.
			await this.brick();
			return { error: "refresh_failed" };
		}

		const newAccessToken = resp.access_token;
		const newIdToken = resp.id_token;
		const newAccountId = decodeAccountId(newIdToken) ?? accountId;
		const accessExp = decodeExpMs(newAccessToken);

		// CRASH-SAFE ORDER (design §3.3 / fact #4): if the endpoint rotated the
		// RT, persist the NEW RT FIRST — even before the account_id guard below —
		// so a rotated RT is never discarded. If that persist throws, brick rather
		// than proceed: using an unpersisted RT (or retrying the old, now-spent
		// one) is the brick scenario we must avoid.
		if (resp.refresh_token && resp.refresh_token !== refreshToken) {
			try {
				const newEnc = await this.encryptRt(resp.refresh_token);
				await this.ctx.storage.put(KEY_ENC_RT, newEnc);
			} catch {
				await this.brick();
				return { error: "refresh_failed" };
			}
		}

		// account_id is REQUIRED (design fact #2): codex's ChatgptAuthTokens
		// auth.json must carry it, so we refuse to mint/cache a "" identity. The
		// refresh succeeded and any rotated RT is already persisted above, so do
		// NOT brick — surface a clean error; recovery is a re-authorization with a
		// token whose id_token carries the claim.
		if (!newAccountId) {
			return { error: "no_account_id" };
		}

		// Only now cache the freshly-minted short-lived material. A failure here
		// is non-fatal: the RT is already safely persisted, so the next mint can
		// re-derive — but we still surface it so the caller doesn't inject a
		// half-stored identity.
		try {
			await this.ctx.storage.put({
				[KEY_ACCESS_TOKEN]: newAccessToken,
				[KEY_ID_TOKEN]: newIdToken,
				[KEY_ACCESS_EXP]: accessExp,
				[KEY_ACCOUNT_ID]: newAccountId,
				[KEY_UPDATED_AT]: new Date().toISOString(),
			});
		} catch {
			return { error: "refresh_failed" };
		}

		return {
			authJson: buildAuthJson(newIdToken, newAccessToken, newAccountId),
			accountId: newAccountId,
		};
	}

	/** POST the OAuth refresh. The caller distinguishes two failure modes:
	 *    - THROW   = transient (network error or 5xx) → retryable, no brick.
	 *    - empty {} = the RT was rejected (4xx) → the caller bricks.
	 *  A 2xx returns the parsed body. NEVER reads/logs the error body — it can
	 *  echo token material on the override endpoint (design §7 secret safety). */
	private async postRefresh(refreshToken: string): Promise<RefreshResponse> {
		const url =
			this.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE || CODEX_REFRESH_TOKEN_URL;
		const res = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				client_id: CODEX_CLIENT_ID,
				grant_type: "refresh_token",
				refresh_token: refreshToken,
			}),
		});
		if (res.status >= 500) {
			// Endpoint up but erroring — the RT was not consumed. Retryable.
			throw new Error(`refresh endpoint ${res.status}`);
		}
		if (!res.ok) {
			// 4xx: the RT was rejected (reused / invalidated / revoked). Signal as
			// an empty body so the caller bricks. Do NOT read the body.
			return {};
		}
		return (await res.json()) as RefreshResponse;
	}

	/** Persist the bricked flag (identity needs re-authorization). */
	private async brick(): Promise<void> {
		await this.ctx.storage.put(KEY_BRICKED, true);
	}

	// ── crypto (AES-GCM, key from env.BROKER_ENC_KEY) ────────────────────────

	private async importKey(): Promise<CryptoKey> {
		const raw = base64ToBytes(this.env.BROKER_ENC_KEY);
		return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
			"encrypt",
			"decrypt",
		]);
	}

	private async encryptRt(refreshToken: string): Promise<EncEnvelope> {
		const key = await this.importKey();
		const iv = crypto.getRandomValues(new Uint8Array(12));
		const ct = await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv },
			key,
			new TextEncoder().encode(refreshToken),
		);
		return { ct: bytesToBase64(new Uint8Array(ct)), iv: bytesToBase64(iv) };
	}

	private async decryptRt(enc: EncEnvelope): Promise<string> {
		const key = await this.importKey();
		const plain = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: base64ToBytes(enc.iv) },
			key,
			base64ToBytes(enc.ct),
		);
		return new TextDecoder().decode(plain);
	}
}

// ── pure helpers ────────────────────────────────────────────────────────────

/** Assemble the ChatgptAuthTokens auth.json codex consumes (empty RT). */
function buildAuthJson(
	idToken: string,
	accessToken: string,
	accountId: string,
): ChatgptAuthJson {
	return {
		auth_mode: "chatgptAuthTokens",
		tokens: {
			id_token: idToken,
			access_token: accessToken,
			refresh_token: "",
			account_id: accountId,
		},
		last_refresh: new Date().toISOString(),
	};
}

/** Decode the ChatGPT account id from an id_token: top-level
 *  `chatgpt_account_id`, the nested `https://api.openai.com/auth` claim, or a
 *  `tokens.account_id` fallback (design §9.A). Returns null if undecodable. */
function decodeAccountId(idToken: string): string | null {
	const claims = decodeJwtPayload(idToken);
	if (!claims) return null;
	const top = claims["chatgpt_account_id"];
	if (typeof top === "string" && top) return top;
	const auth = claims["https://api.openai.com/auth"];
	if (auth && typeof auth === "object") {
		const nested = (auth as Record<string, unknown>)["chatgpt_account_id"];
		if (typeof nested === "string" && nested) return nested;
	}
	const tokens = claims["tokens"];
	if (tokens && typeof tokens === "object") {
		const fallback = (tokens as Record<string, unknown>)["account_id"];
		if (typeof fallback === "string" && fallback) return fallback;
	}
	return null;
}

/** Read a top-level string claim from a JWT (e.g. `sub`). Null if absent. */
function decodeClaim(jwt: string, claim: string): string | null {
	const claims = decodeJwtPayload(jwt);
	const value = claims?.[claim];
	return typeof value === "string" ? value : null;
}

/** Read a JWT's `exp` claim as epoch milliseconds, or 0 if absent/unparseable
 *  (0 forces a refresh on the next mint rather than reusing a stale token). */
function decodeExpMs(jwt: string): number {
	const claims = decodeJwtPayload(jwt);
	const exp = claims?.["exp"];
	return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : 0;
}

/** Base64url-decode a JWT's payload to a claims object. Decode-only — we do NOT
 *  verify the signature (the token arrives over an authenticated TLS PUT from
 *  the member's own device, and is used only to extract identity metadata).
 *  Returns null on any malformed input. NEVER logs the token. */
function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
	const parts = jwt.split(".");
	if (parts.length < 2) return null;
	try {
		const bytes = base64ToBytes(base64UrlToBase64(parts[1]));
		const json = new TextDecoder().decode(bytes);
		const parsed = JSON.parse(json);
		return parsed && typeof parsed === "object"
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function base64UrlToBase64(s: string): string {
	const padded = s.replace(/-/g, "+").replace(/_/g, "/");
	const pad = padded.length % 4;
	return pad ? padded + "=".repeat(4 - pad) : padded;
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
