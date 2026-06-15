// Helmor Team Cloud Sandbox — D1 team-registry routes (Phase 3 / P3.3).
//
// The Worker's D1 is the team REGISTRY: members, invites, the team row, and a
// read-only mirror of workspaces. These `/team/*` JSON routes own that table;
// the proxy path in index.ts only READS `invites` to derive member identity.
//
// Trust model (security-critical):
//   - The invite token IS the member's bearer (capability token,
//     trust-on-first-use). Admin actions use the shared HELMOR_COMPANION_TOKEN.
//   - `/team/accept` is OPEN — the token itself is the credential.
// All queries are parameterized (`prepare().bind()`) — never interpolated.

import { type DirectoryBackup, getSandbox } from "@cloudflare/sandbox";
import type { Env } from "./index";

export const TEAM_ID = "team-0";

type Caller = "admin" | "member" | "unauthorized";

/** Read the `Authorization: Bearer <token>` value, or null if absent. */
function readBearer(request: Request): string | null {
	const header = request.headers.get("Authorization");
	if (!header) return null;
	const match = /^Bearer\s+(.+)$/i.exec(header);
	return match ? match[1] : null;
}

/** Classify the caller: admin (shared token), member (a token that maps to a
 *  non-null accepted `invites.member_id`), or unauthorized. */
async function classifyCaller(request: Request, env: Env): Promise<Caller> {
	const bearer = readBearer(request);
	if (!bearer) return "unauthorized";
	if (bearer === env.HELMOR_COMPANION_TOKEN) return "admin";
	const memberId = await lookupMemberId(env, bearer);
	return memberId ? "member" : "unauthorized";
}

/** Map an invite token to its accepted member id (null if unknown/unaccepted). */
export async function lookupMemberId(
	env: Env,
	token: string,
): Promise<string | null> {
	const row = await env.DB.prepare(
		"SELECT member_id FROM invites WHERE token = ?1",
	)
		.bind(token)
		.first<{ member_id: string | null }>();
	return row?.member_id ?? null;
}

/**
 * Read the stored Sandbox backup handle for this Worker's sandbox (Phase 2b).
 * Returns null when no backup has been taken yet (cold start → empty DB), or
 * when the stored value can't be parsed (treated as absent — re-snapshot next
 * turn). Keyed by `HELMOR_SANDBOX_ID` so it tracks the routing key, not TEAM_ID.
 */
export async function readBackupHandle(
	env: Env,
): Promise<DirectoryBackup | null> {
	const row = await env.DB.prepare(
		"SELECT backup_handle FROM teams WHERE sandbox_id = ?1",
	)
		.bind(env.HELMOR_SANDBOX_ID)
		.first<{ backup_handle: string | null }>();
	if (!row?.backup_handle) return null;
	try {
		return JSON.parse(row.backup_handle) as DirectoryBackup;
	} catch {
		return null;
	}
}

/**
 * Persist the latest Sandbox backup handle (Phase 2b). UPSERTs the single team
 * row keyed by `id` (the PK), recording the handle JSON so the next cold start's
 * `readBackupHandle` can restore it. Mirrors `bootstrap`'s upsert shape.
 */
export async function writeBackupHandle(
	env: Env,
	handle: DirectoryBackup,
): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO teams (id, sandbox_id, backup_handle) VALUES (?1, ?2, ?3)
		 ON CONFLICT(id) DO UPDATE SET
		   sandbox_id    = excluded.sandbox_id,
		   backup_handle = excluded.backup_handle`,
	)
		.bind(TEAM_ID, env.HELMOR_SANDBOX_ID, JSON.stringify(handle))
		.run();
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/**
 * Handle `/team/*` registry routes. Returns null for any other path so the
 * caller falls through to the container proxy.
 */
export async function handleTeamRoute(
	request: Request,
	env: Env,
	url: URL,
): Promise<Response | null> {
	if (!url.pathname.startsWith("/team/")) return null;

	const route = `${request.method} ${url.pathname}`;
	switch (route) {
		case "POST /team/bootstrap":
			return bootstrap(request, env);
		case "POST /team/invite":
			return createInvite(request, env, url);
		case "POST /team/accept":
			return acceptInvite(request, env);
		case "GET /team/members":
			return listMembers(request, env);
		case "GET /team/workspaces":
			return listWorkspaces(request, env);
		case "PUT /team/cloud-identity":
			return putCloudIdentity(request, env);
		case "GET /team/cloud-identity":
			return getCloudIdentity(request, env);
		case "PUT /team/claude-identity":
			return putClaudeIdentity(request, env);
		case "GET /team/claude-identity":
			return getClaudeIdentity(request, env);
		default:
			return json({ code: "NotFound", message: `no route ${route}` }, 404);
	}
}

/** POST /team/bootstrap (admin) — upsert the single team row. */
async function bootstrap(request: Request, env: Env): Promise<Response> {
	if ((await classifyCaller(request, env)) !== "admin") {
		return json({ code: "Unauthorized" }, 401);
	}
	await env.DB.prepare(
		`INSERT INTO teams (id, sandbox_id) VALUES (?1, ?2)
		 ON CONFLICT(id) DO UPDATE SET sandbox_id = excluded.sandbox_id`,
	)
		.bind(TEAM_ID, env.HELMOR_SANDBOX_ID)
		.run();
	return json({ ok: true, teamId: TEAM_ID });
}

/** POST /team/invite (admin) — mint a capability token (the member's bearer). */
async function createInvite(
	request: Request,
	env: Env,
	url: URL,
): Promise<Response> {
	if ((await classifyCaller(request, env)) !== "admin") {
		return json({ code: "Unauthorized" }, 401);
	}
	const body = await readJsonBody(request);
	const expiresAt = typeof body.expiresAt === "string" ? body.expiresAt : null;
	const token = crypto.randomUUID();
	await env.DB.prepare(
		`INSERT INTO invites (token, team_id, created_at, expires_at)
		 VALUES (?1, ?2, ?3, ?4)`,
	)
		.bind(token, TEAM_ID, new Date().toISOString(), expiresAt)
		.run();
	return json({ token, url: `https://${url.host}/?invite=${token}` });
}

/** POST /team/accept (OPEN — token is the credential) — claim an invite. */
async function acceptInvite(request: Request, env: Env): Promise<Response> {
	const body = await readJsonBody(request);
	const token = typeof body.token === "string" ? body.token : "";
	const githubId =
		typeof body.githubId === "string"
			? body.githubId
			: String(body.githubId ?? "");
	const login = typeof body.login === "string" ? body.login : "";
	if (!token || !githubId || !login) {
		return json(
			{ code: "BadRequest", message: "token, githubId, login required" },
			400,
		);
	}

	const invite = await env.DB.prepare(
		"SELECT expires_at, member_id FROM invites WHERE token = ?1",
	)
		.bind(token)
		.first<{ expires_at: string | null; member_id: string | null }>();
	if (!invite)
		return json({ code: "NotFound", message: "unknown invite" }, 404);
	if (invite.expires_at) {
		// Fail-closed: an unparseable expires_at counts as expired (Date.parse ->
		// NaN, and `NaN < now` is false, which would otherwise never expire).
		const expiry = Date.parse(invite.expires_at);
		if (!Number.isFinite(expiry) || expiry < Date.now()) {
			return json({ code: "Gone", message: "invite expired" }, 410);
		}
	}
	// An already-claimed invite may be refreshed by the SAME member, but never
	// re-bound to a different id — no seat takeover via a leaked invite link.
	if (invite.member_id && invite.member_id !== githubId) {
		return json({ code: "Conflict", message: "invite already claimed" }, 409);
	}

	const avatarUrl = typeof body.avatarUrl === "string" ? body.avatarUrl : null;
	const displayName =
		typeof body.displayName === "string" ? body.displayName : null;

	await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO members (id, github_login, avatar_url, display_name, created_at)
			 VALUES (?1, ?2, ?3, ?4, ?5)
			 ON CONFLICT(id) DO UPDATE SET
			   github_login = excluded.github_login,
			   avatar_url   = excluded.avatar_url,
			   display_name = excluded.display_name`,
		).bind(githubId, login, avatarUrl, displayName, new Date().toISOString()),
		env.DB.prepare("UPDATE invites SET member_id = ?1 WHERE token = ?2").bind(
			githubId,
			token,
		),
	]);

	return json({ ok: true, memberId: githubId });
}

/** GET /team/members (member-or-admin) — roster for the sidebar. */
async function listMembers(request: Request, env: Env): Promise<Response> {
	if ((await classifyCaller(request, env)) === "unauthorized") {
		return json({ code: "Unauthorized" }, 401);
	}
	const { results } = await env.DB.prepare(
		"SELECT id, github_login, avatar_url, display_name FROM members",
	).all();
	return json({ members: results });
}

/** GET /team/workspaces (member-or-admin) — read-only workspace mirror. */
async function listWorkspaces(request: Request, env: Env): Promise<Response> {
	if ((await classifyCaller(request, env)) === "unauthorized") {
		return json({ code: "Unauthorized" }, 401);
	}
	const { results } = await env.DB.prepare(
		"SELECT id, name, status, created_at FROM workspaces WHERE team_id = ?1",
	)
		.bind(TEAM_ID)
		.all();
	return json({ workspaces: results });
}

/**
 * PUT /team/cloud-identity (AUTHENTICATED MEMBER) — store the member's Codex
 * subscription OAuth tokens in their own `CodexIdentity` Durable Object.
 *
 * SECURITY (the trust boundary): the member id is derived SOLELY from the
 * `Authorization: Bearer <invite-token>` → `invites.member_id` mapping. A
 * client-supplied `X-Helmor-Member-Id` is NEVER trusted (and is stripped on the
 * proxy path in index.ts regardless). The admin/shared token carries no member
 * identity, so it cannot write a cloud identity — only a real member can write
 * their OWN. An unauthenticated / unknown token is rejected with 401.
 *
 * The body is `{ refreshToken, idToken }`. The refresh_token is handed straight
 * to the DO (encrypted at rest there) and is NEVER logged, NEVER echoed back —
 * the response is `{ accountId, changed }` only.
 */
async function putCloudIdentity(request: Request, env: Env): Promise<Response> {
	// Derive the member id from the bearer alone — never from a client header.
	const bearer = readBearer(request);
	const memberId = bearer ? await lookupMemberId(env, bearer) : null;
	if (!memberId) {
		return json({ code: "Unauthorized" }, 401);
	}

	const body = await readJsonBody(request);
	const refreshToken =
		typeof body.refreshToken === "string" ? body.refreshToken : "";
	const idToken = typeof body.idToken === "string" ? body.idToken : "";
	if (!refreshToken || !idToken) {
		// NB: never include the (absent/empty) token values in the error.
		return json(
			{ code: "BadRequest", message: "refreshToken, idToken required" },
			400,
		);
	}

	const stub = env.CODEX_IDENTITY.get(env.CODEX_IDENTITY.idFromName(memberId));
	const result = await stub.putRefreshToken(refreshToken, idToken);

	// Bind this team's cloud run identity to the authorizing member (v1: one
	// team -> one identity; last writer wins). Upsert the single team row so a
	// member can authorize before any explicit bootstrap.
	await env.DB.prepare(
		`INSERT INTO teams (id, sandbox_id, cloud_identity_member_id) VALUES (?1, ?2, ?3)
		 ON CONFLICT(id) DO UPDATE SET cloud_identity_member_id = excluded.cloud_identity_member_id`,
	)
		.bind(TEAM_ID, env.HELMOR_SANDBOX_ID, memberId)
		.run();

	if (result.changed) await stopSandboxForReauth(env);
	return json({ accountId: result.accountId, changed: result.changed });
}

/**
 * GET /team/cloud-identity (member-or-admin) — read the team's cloud Codex
 * identity status from its `CodexIdentity` DO. Returns metadata only
 * (`{ hasToken, accountId, accessExp, bricked }`) — NEVER any token material.
 *
 * For v1 (one team -> one identity) the queried DO is the team's bound
 * `cloud_identity_member_id`. A no-identity team (none bound yet) reports
 * `hasToken: false` without touching a DO.
 */
async function getCloudIdentity(request: Request, env: Env): Promise<Response> {
	if ((await classifyCaller(request, env)) === "unauthorized") {
		return json({ code: "Unauthorized" }, 401);
	}

	const memberId = await readCloudIdentityMemberId(env);
	if (!memberId) {
		return json({
			hasToken: false,
			accountId: null,
			accessExp: null,
			bricked: false,
		});
	}

	const stub = env.CODEX_IDENTITY.get(env.CODEX_IDENTITY.idFromName(memberId));
	const status = await stub.status();
	return json(status);
}

/**
 * PUT /team/claude-identity (AUTHENTICATED MEMBER) — store the member's Claude
 * subscription OAuth token in their own `ClaudeIdentity` Durable Object.
 *
 * SECURITY (the trust boundary, identical to the Codex route): the member id is
 * derived SOLELY from the `Authorization: Bearer <invite-token>` →
 * `invites.member_id` mapping. A client-supplied `X-Helmor-Member-Id` is NEVER
 * trusted (and is stripped on the proxy path in index.ts regardless). The
 * admin/shared token carries no member identity, so it cannot write a cloud
 * identity — only a real member can write their OWN. An unauthenticated /
 * unknown token is rejected with 401.
 *
 * The body is `{ oauthToken }` (the `sk-ant-oat01…` token from
 * `claude setup-token`). The token is handed straight to the DO (encrypted at
 * rest there) and is NEVER logged, NEVER echoed back — the response is
 * `{ changed }` only.
 */
async function putClaudeIdentity(
	request: Request,
	env: Env,
): Promise<Response> {
	// Derive the member id from the bearer alone — never from a client header.
	const bearer = readBearer(request);
	const memberId = bearer ? await lookupMemberId(env, bearer) : null;
	if (!memberId) {
		return json({ code: "Unauthorized" }, 401);
	}

	const body = await readJsonBody(request);
	const oauthToken = typeof body.oauthToken === "string" ? body.oauthToken : "";
	if (!oauthToken) {
		// NB: never include the (absent/empty) token value in the error.
		return json({ code: "BadRequest", message: "oauthToken required" }, 400);
	}

	const stub = env.CLAUDE_IDENTITY.get(
		env.CLAUDE_IDENTITY.idFromName(memberId),
	);
	const result = await stub.store(oauthToken);

	// Bind this team's cloud run identity to the authorizing member (v1: one
	// team -> one identity; last writer wins). REUSES the same
	// `cloud_identity_member_id` binding as Codex (shared identity for v1).
	// Upsert the single team row so a member can authorize before any explicit
	// bootstrap.
	await env.DB.prepare(
		`INSERT INTO teams (id, sandbox_id, cloud_identity_member_id) VALUES (?1, ?2, ?3)
		 ON CONFLICT(id) DO UPDATE SET cloud_identity_member_id = excluded.cloud_identity_member_id`,
	)
		.bind(TEAM_ID, env.HELMOR_SANDBOX_ID, memberId)
		.run();

	if (result.changed) await stopSandboxForReauth(env);
	return json({ changed: result.changed });
}

/**
 * After a cloud identity is (re)authorized, stop the sandbox so the NEXT request
 * cold-starts and re-mints + re-injects the new credential into a FRESH serve.
 * start-serve.sh is idempotent ("bail if serve already running"), so a serve
 * that started BEFORE authorization never picks up the new token on its own —
 * without this the user has to manually restart. Best-effort: the identity is
 * already persisted, so a missing/idle sandbox just cold-starts fresh anyway.
 */
async function stopSandboxForReauth(env: Env): Promise<void> {
	try {
		const sandbox = getSandbox(
			env.Sandbox,
			env.HELMOR_SANDBOX_ID ?? "helmor-team-0",
		);
		await sandbox.stop();
	} catch {
		// ignore — store already succeeded; next cold start applies it regardless
	}
}

/**
 * GET /team/claude-identity (member-or-admin) — read the team's cloud Claude
 * identity status from its `ClaudeIdentity` DO. Returns metadata only
 * (`{ hasToken }`) — NEVER any token material.
 *
 * For v1 (one team -> one identity) the queried DO is the team's bound
 * `cloud_identity_member_id`. A no-identity team (none bound yet) reports
 * `hasToken: false` without touching a DO.
 */
async function getClaudeIdentity(
	request: Request,
	env: Env,
): Promise<Response> {
	if ((await classifyCaller(request, env)) === "unauthorized") {
		return json({ code: "Unauthorized" }, 401);
	}

	const memberId = await readCloudIdentityMemberId(env);
	if (!memberId) {
		return json({ hasToken: false });
	}

	const stub = env.CLAUDE_IDENTITY.get(
		env.CLAUDE_IDENTITY.idFromName(memberId),
	);
	const status = await stub.status();
	return json(status);
}

/** Read the team's bound cloud-identity member id (the member whose
 *  `CodexIdentity` DO backs the team's cloud run identity), or null if none.
 *  Exported so the cold-start mint hook in index.ts can resolve which DO to
 *  mint the container's auth.json from. */
export async function readCloudIdentityMemberId(
	env: Env,
): Promise<string | null> {
	const row = await env.DB.prepare(
		"SELECT cloud_identity_member_id FROM teams WHERE id = ?1",
	)
		.bind(TEAM_ID)
		.first<{ cloud_identity_member_id: string | null }>();
	return row?.cloud_identity_member_id ?? null;
}

/** Best-effort JSON body parse — an empty/invalid body yields `{}`. */
async function readJsonBody(
	request: Request,
): Promise<Record<string, unknown>> {
	try {
		const parsed = await request.json();
		return parsed && typeof parsed === "object"
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}
