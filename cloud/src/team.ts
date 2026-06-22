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
import {
	handleTeamGatewayRoute,
	TEAM_ID,
	type TeamGatewayAcceptInviteInput,
	type TeamGatewayAcceptInviteResult,
	type TeamGatewayAuth,
	type TeamGatewayStore,
} from "./team-gateway/core";

export { TEAM_ID };

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

/**
 * Handle `/team/*` registry routes. Returns null for any other path so the
 * caller falls through to the container proxy.
 */
export async function handleTeamRoute(
	request: Request,
	env: Env,
	url: URL,
): Promise<Response | null> {
	return handleTeamGatewayRoute(
		request,
		url,
		createWorkerTeamGatewayStore(env, url),
	);
}

export function createWorkerTeamGatewayStore(
	env: Env,
	url: URL,
): TeamGatewayStore {
	return {
		classifyBearer: (token) => classifyBearer(env, token),
		bootstrap: () => bootstrap(env),
		createInvite: (input) => createInvite(env, url, input.expiresAt),
		acceptInvite: (input) => acceptInvite(env, input),
		listMembers: () => listMembers(env),
		listWorkspaces: () => listWorkspaces(env),
		putCodexIdentity: (memberId, input) =>
			putCloudIdentity(env, memberId, input),
		getCodexIdentity: () => getCloudIdentity(env),
		putClaudeIdentity: (memberId, input) =>
			putClaudeIdentity(env, memberId, input),
		getClaudeIdentity: () => getClaudeIdentity(env),
		putForgeIdentity: (memberId, input) =>
			putForgeIdentity(env, memberId, input),
		getForgeIdentity: (memberId) => getForgeIdentity(env, memberId),
	};
}

async function classifyBearer(
	env: Env,
	token: string | null,
): Promise<TeamGatewayAuth> {
	if (!token) return { caller: "unauthorized", memberId: null };
	if (token === env.HELMOR_COMPANION_TOKEN) {
		return { caller: "admin", memberId: null };
	}
	const memberId = await lookupMemberId(env, token);
	return memberId
		? { caller: "member", memberId }
		: { caller: "unauthorized", memberId: null };
}

async function bootstrap(env: Env): Promise<{ teamId: string }> {
	await env.DB.prepare(
		`INSERT INTO teams (id, sandbox_id) VALUES (?1, ?2)
		 ON CONFLICT(id) DO UPDATE SET sandbox_id = excluded.sandbox_id`,
	)
		.bind(TEAM_ID, env.HELMOR_SANDBOX_ID)
		.run();
	return { teamId: TEAM_ID };
}

async function createInvite(
	env: Env,
	url: URL,
	expiresAt?: string | null,
): Promise<{ token: string; url: string }> {
	const token = crypto.randomUUID();
	await env.DB.prepare(
		`INSERT INTO invites (token, team_id, created_at, expires_at)
		 VALUES (?1, ?2, ?3, ?4)`,
	)
		.bind(token, TEAM_ID, new Date().toISOString(), expiresAt ?? null)
		.run();
	return { token, url: `https://${url.host}/?invite=${token}` };
}

async function acceptInvite(
	env: Env,
	input: TeamGatewayAcceptInviteInput,
): Promise<TeamGatewayAcceptInviteResult> {
	const token = input.token.trim();
	const githubId = input.githubId.trim();
	const login = input.login.trim();
	if (!token || !githubId || !login) {
		return {
			ok: false,
			status: 400,
			message: "token, githubId, login required",
		};
	}

	const invite = await env.DB.prepare(
		"SELECT expires_at, member_id FROM invites WHERE token = ?1",
	)
		.bind(token)
		.first<{ expires_at: string | null; member_id: string | null }>();
	if (!invite) return { ok: false, status: 404, message: "unknown invite" };
	if (invite.expires_at) {
		// Fail-closed: an unparseable expires_at counts as expired.
		const expiry = Date.parse(invite.expires_at);
		if (!Number.isFinite(expiry) || expiry < Date.now()) {
			return { ok: false, status: 410, message: "invite expired" };
		}
	}
	// An already-claimed invite may be refreshed by the SAME member, but never
	// re-bound to a different id.
	if (invite.member_id && invite.member_id !== githubId) {
		return { ok: false, status: 409, message: "invite already claimed" };
	}

	await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO members (id, github_login, avatar_url, display_name, created_at)
			 VALUES (?1, ?2, ?3, ?4, ?5)
			 ON CONFLICT(id) DO UPDATE SET
			   github_login = excluded.github_login,
			   avatar_url   = excluded.avatar_url,
			   display_name = excluded.display_name`,
		).bind(
			githubId,
			login,
			input.avatarUrl ?? null,
			input.displayName ?? null,
			new Date().toISOString(),
		),
		env.DB.prepare("UPDATE invites SET member_id = ?1 WHERE token = ?2").bind(
			githubId,
			token,
		),
	]);

	return { ok: true, memberId: githubId };
}

async function listMembers(env: Env): Promise<unknown[]> {
	const { results } = await env.DB.prepare(
		"SELECT id, github_login, avatar_url, display_name FROM members",
	).all();
	return results;
}

async function listWorkspaces(env: Env): Promise<unknown[]> {
	const { results } = await env.DB.prepare(
		"SELECT id, name, status, created_at FROM workspaces WHERE team_id = ?1",
	)
		.bind(TEAM_ID)
		.all();
	return results;
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
async function putCloudIdentity(
	env: Env,
	memberId: string,
	input: { refreshToken: string; idToken: string },
): Promise<{ accountId: string | null; changed: boolean }> {
	const stub = env.CODEX_IDENTITY.get(env.CODEX_IDENTITY.idFromName(memberId));
	const result = await stub.putRefreshToken(input.refreshToken, input.idToken);

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
	return { accountId: result.accountId, changed: result.changed };
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
async function getCloudIdentity(env: Env): Promise<unknown> {
	const memberId = await readCloudIdentityMemberId(env);
	if (!memberId) {
		return {
			hasToken: false,
			accountId: null,
			accessExp: null,
			bricked: false,
		};
	}

	const stub = env.CODEX_IDENTITY.get(env.CODEX_IDENTITY.idFromName(memberId));
	return stub.status();
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
	env: Env,
	memberId: string,
	input: { oauthToken: string },
): Promise<{ changed: boolean }> {
	const stub = env.CLAUDE_IDENTITY.get(
		env.CLAUDE_IDENTITY.idFromName(memberId),
	);
	const result = await stub.store(input.oauthToken);

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
	return { changed: result.changed };
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
async function getClaudeIdentity(env: Env): Promise<unknown> {
	const memberId = await readCloudIdentityMemberId(env);
	if (!memberId) {
		return { hasToken: false };
	}

	const stub = env.CLAUDE_IDENTITY.get(
		env.CLAUDE_IDENTITY.idFromName(memberId),
	);
	return stub.status();
}

/**
 * PUT /team/forge-identity (AUTHENTICATED MEMBER) — store the member's forge
 * credentials (gh token / glab config) in their OWN `ForgeIdentity` DO.
 *
 * TRUE per-member (unlike Claude/Codex's "one team -> one identity"): every
 * member's DO is independent, keyed by their own member id. There is NO
 * `teams.cloud_identity_member_id` binding — at cold start the container injects
 * ALL members' creds and the forge layer selects by the acting member.
 *
 * SECURITY: same trust boundary as the Claude route — member id comes SOLELY
 * from the bearer->`invites.member_id` mapping (never client-supplied). Tokens
 * are handed to the DO (encrypted at rest there), NEVER logged or echoed.
 */
async function putForgeIdentity(
	env: Env,
	memberId: string,
	input: { githubToken?: string; glabConfigYml?: string },
): Promise<{ changed: boolean }> {
	const stub = env.FORGE_IDENTITY.get(env.FORGE_IDENTITY.idFromName(memberId));
	return stub.store(input);
}

/**
 * GET /team/forge-identity (AUTHENTICATED MEMBER) — the calling member's forge
 * status from their own DO. Metadata only (`{ hasGithub, glabHosts }`) — NEVER
 * a token.
 */
async function getForgeIdentity(env: Env, memberId: string): Promise<unknown> {
	const stub = env.FORGE_IDENTITY.get(env.FORGE_IDENTITY.idFromName(memberId));
	return stub.status();
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
