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
import { healthOk } from "./container-net";
import { reinjectForgeMembersIfServing } from "./forge-creds";
import type { Env } from "./index";
import {
	handleTeamGatewayRoute,
	TEAM_ID,
	type TeamGatewayAcceptInviteInput,
	type TeamGatewayAcceptInviteResult,
	type TeamGatewayAuth,
	type TeamGatewayStore,
	type TeamSyncInput,
} from "./team-gateway/core";

// Re-exported from its new home (forge-creds.ts) so existing importers keep
// working — the binding logic moved next to the injection paths it feeds.
export { readForgeIdentityMemberId } from "./forge-creds";
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
 * Drop a stale backup handle (P1-3a). Called when the pre-restore expiry
 * check proves the archive is gone (past TTL / deleted) — the handle would
 * otherwise wedge every future wake on a restore that can never succeed.
 */
export async function clearBackupHandle(env: Env): Promise<void> {
	await env.DB.prepare(
		"UPDATE teams SET backup_handle = NULL WHERE sandbox_id = ?1",
	)
		.bind(env.HELMOR_SANDBOX_ID)
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

/** Side-effect hooks the identity PUT routes fire on success (round6 P1-4a).
 *  Injectable so tests can pin the WIRING (a PUT must trigger its effect)
 *  without a real Sandbox DO in the isolate; production uses the defaults. */
export type TeamGatewayStoreDeps = {
	/** Live members-file re-inject after a forge (re-)authorization. */
	reinjectForgeCreds: (env: Env) => Promise<void>;
	/** Guarded backup-then-destroy after a cloud-identity (re-)authorization. */
	restartForReauth: (env: Env) => Promise<void>;
};

const DEFAULT_STORE_DEPS: TeamGatewayStoreDeps = {
	reinjectForgeCreds: reinjectForgeCredsLive,
	restartForReauth: stopSandboxForReauth,
};

export function createWorkerTeamGatewayStore(
	env: Env,
	url: URL,
	deps: TeamGatewayStoreDeps = DEFAULT_STORE_DEPS,
): TeamGatewayStore {
	return {
		classifyBearer: (token) => classifyBearer(env, token),
		bootstrap: () => bootstrap(env),
		createInvite: (input) => createInvite(env, url, input.expiresAt),
		acceptInvite: (input) => acceptInvite(env, input),
		listMembers: () => listMembers(env),
		listWorkspaces: () => listWorkspaces(env),
		putCodexIdentity: (memberId, input) =>
			putCloudIdentity(env, memberId, input, deps),
		getCodexIdentity: () => getCloudIdentity(env),
		putClaudeIdentity: (memberId, input) =>
			putClaudeIdentity(env, memberId, input, deps),
		getClaudeIdentity: () => getClaudeIdentity(env),
		putForgeIdentity: (memberId, input) =>
			putForgeIdentity(env, memberId, input, deps),
		getForgeIdentity: (memberId) => getForgeIdentity(env, memberId),
		syncTeamData: (input) => syncTeamData(env, input),
		listSessions: (workspaceId) => listSessions(env, workspaceId),
		listSessionMessages: (sessionId) => listSessionMessages(env, sessionId),
		getGitSnapshot: (workspaceId) => getGitSnapshot(env, workspaceId),
		getWorkspaceDetail: (workspaceId) => getWorkspaceDetail(env, workspaceId),
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

/** R2-E git snapshot mirror. Own table (write-path self-heal CREATE, the
 * model_catalog precedent — no migration step for existing deployments).
 * Payload stored opaque: it is the exact serialization of the container's
 * /rpc response shapes, versioned inside the blob. */
const CREATE_GIT_SNAPSHOTS_SQL = `CREATE TABLE IF NOT EXISTS git_snapshots (
	workspace_id TEXT PRIMARY KEY,
	payload TEXT NOT NULL,
	updated_at TEXT NOT NULL
)`;

async function putGitSnapshot(
	env: Env,
	snapshot: NonNullable<TeamSyncInput["gitSnapshot"]>,
): Promise<void> {
	if (!snapshot.workspaceId) return;
	await env.DB.prepare(CREATE_GIT_SNAPSHOTS_SQL).run();
	await env.DB.prepare(
		`INSERT INTO git_snapshots (workspace_id, payload, updated_at)
		 VALUES (?1, ?2, datetime('now'))
		 ON CONFLICT(workspace_id) DO UPDATE SET
		   payload = excluded.payload, updated_at = excluded.updated_at`,
	)
		.bind(snapshot.workspaceId, JSON.stringify(snapshot))
		.run();
}

async function getGitSnapshot(
	env: Env,
	workspaceId: string,
): Promise<unknown | null> {
	if (!workspaceId) return null;
	try {
		const row = await env.DB.prepare(
			"SELECT payload FROM git_snapshots WHERE workspace_id = ?1",
		)
			.bind(workspaceId)
			.first<{ payload: string }>();
		return row ? JSON.parse(row.payload) : null;
	} catch {
		// Table not created yet (no snapshot ever pushed) — not an error.
		return null;
	}
}

/** Lever A workspace-detail mirror. Same contract as git_snapshots: own table
 * (write-path self-heal CREATE — no migration step for existing deployments),
 * opaque payload holding the container's exact `get_workspace` WorkspaceDetail
 * serialization. Answers the desktop's switch-time detail read with the
 * container asleep. */
const CREATE_WORKSPACE_DETAILS_SQL = `CREATE TABLE IF NOT EXISTS workspace_details (
	workspace_id TEXT PRIMARY KEY,
	payload TEXT NOT NULL,
	updated_at TEXT NOT NULL
)`;

async function putWorkspaceDetails(
	env: Env,
	rows: NonNullable<TeamSyncInput["workspaceDetails"]>,
): Promise<void> {
	const valid = rows.filter(
		(row) =>
			row?.workspaceId && row.detail !== undefined && row.detail !== null,
	);
	if (valid.length === 0) return;
	await env.DB.prepare(CREATE_WORKSPACE_DETAILS_SQL).run();
	await env.DB.batch(
		valid.map((row) =>
			env.DB.prepare(
				`INSERT INTO workspace_details (workspace_id, payload, updated_at)
				 VALUES (?1, ?2, datetime('now'))
				 ON CONFLICT(workspace_id) DO UPDATE SET
				   payload = excluded.payload, updated_at = excluded.updated_at`,
			).bind(row.workspaceId, JSON.stringify(row.detail)),
		),
	);
}

async function getWorkspaceDetail(
	env: Env,
	workspaceId: string,
): Promise<unknown | null> {
	if (!workspaceId) return null;
	try {
		const row = await env.DB.prepare(
			"SELECT payload FROM workspace_details WHERE workspace_id = ?1",
		)
			.bind(workspaceId)
			.first<{ payload: string }>();
		return row ? JSON.parse(row.payload) : null;
	} catch {
		// Table not created yet (no detail ever pushed) — not an error.
		return null;
	}
}

/**
 * Stage B write-through (PUT /team/sync, container→D1). Upserts session rows,
 * APPENDS message rows (immutable — `ON CONFLICT DO NOTHING`), and applies
 * cascade deletes. Everything is id-keyed + idempotent, so a retried/duplicated
 * sync is a no-op and a wake-time reconcile self-heals any dropped best-effort
 * write. Batched into one D1 transaction.
 */
async function syncTeamData(
	env: Env,
	input: TeamSyncInput,
): Promise<{ ok: true }> {
	// R2-E: git snapshot rides the same sync payload; separate table + upsert.
	if (input.gitSnapshot) {
		await putGitSnapshot(env, input.gitSnapshot);
	}
	// Lever A: workspace-detail mirror rides the same payload; own table.
	if (input.workspaceDetails?.length) {
		await putWorkspaceDetails(env, input.workspaceDetails);
	}
	const stmts: ReturnType<typeof env.DB.prepare>[] = [];
	for (const s of input.sessions ?? []) {
		if (!s?.id || !s.workspaceId) continue;
		// DF-2: `created_at` follows the container byte-for-byte on update too
		// (not just first insert), so the container's format-normalization
		// migration self-heals stale mirror rows on the next sync. COALESCE
		// guards a null payload value from clobbering a good mirror value.
		stmts.push(
			env.DB.prepare(
				`INSERT INTO sessions
				   (id, workspace_id, title, status, model, agent_type, permission_mode,
				    effort_level, action_kind, session_kind, is_hidden,
				    last_user_message_at, created_at, updated_at)
				 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)
				 ON CONFLICT(id) DO UPDATE SET
				   workspace_id = excluded.workspace_id,
				   title = excluded.title,
				   status = excluded.status,
				   model = excluded.model,
				   agent_type = excluded.agent_type,
				   permission_mode = excluded.permission_mode,
				   effort_level = excluded.effort_level,
				   action_kind = excluded.action_kind,
				   session_kind = excluded.session_kind,
				   is_hidden = excluded.is_hidden,
				   last_user_message_at = excluded.last_user_message_at,
				   created_at = COALESCE(excluded.created_at, created_at),
				   updated_at = excluded.updated_at`,
			).bind(
				s.id,
				s.workspaceId,
				s.title ?? null,
				s.status ?? null,
				s.model ?? null,
				s.agentType ?? null,
				s.permissionMode ?? null,
				s.effortLevel ?? null,
				s.actionKind ?? null,
				s.sessionKind ?? null,
				s.isHidden ? 1 : 0,
				s.lastUserMessageAt ?? null,
				s.createdAt ?? null,
				s.updatedAt ?? null,
			),
		);
	}
	for (const m of input.messages ?? []) {
		if (!m?.id || !m.sessionId) continue;
		// Append-only: a message id never changes, so ignore a duplicate insert.
		stmts.push(
			env.DB.prepare(
				`INSERT INTO messages (id, session_id, role, content, sent_at, created_at, author_id)
				 VALUES (?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(id) DO NOTHING`,
			).bind(
				m.id,
				m.sessionId,
				m.role ?? null,
				m.content ?? null,
				m.sentAt ?? null,
				m.createdAt ?? null,
				m.authorId ?? null,
			),
		);
	}
	for (const id of input.deletedSessionIds ?? []) {
		if (!id) continue;
		stmts.push(
			env.DB.prepare("DELETE FROM messages WHERE session_id = ?1").bind(id),
		);
		stmts.push(env.DB.prepare("DELETE FROM sessions WHERE id = ?1").bind(id));
	}
	for (const id of input.deletedMessageIds ?? []) {
		if (!id) continue;
		stmts.push(env.DB.prepare("DELETE FROM messages WHERE id = ?1").bind(id));
	}
	// Authoritative prune: drop D1 sessions (+ their messages) for the workspace
	// that the container no longer has. Runs after the upserts above, so newly
	// created sessions in the same sync survive.
	const replace = input.replaceWorkspaceSessions;
	if (replace?.workspaceId) {
		const ids = (replace.sessionIds ?? []).filter(Boolean);
		if (ids.length === 0) {
			stmts.push(
				env.DB.prepare(
					"DELETE FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE workspace_id = ?1)",
				).bind(replace.workspaceId),
				env.DB.prepare("DELETE FROM sessions WHERE workspace_id = ?1").bind(
					replace.workspaceId,
				),
			);
		} else {
			const ph = ids.map((_, i) => `?${i + 2}`).join(",");
			stmts.push(
				env.DB.prepare(
					`DELETE FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE workspace_id = ?1 AND id NOT IN (${ph}))`,
				).bind(replace.workspaceId, ...ids),
				env.DB.prepare(
					`DELETE FROM sessions WHERE workspace_id = ?1 AND id NOT IN (${ph})`,
				).bind(replace.workspaceId, ...ids),
			);
		}
	}
	if (stmts.length > 0) await env.DB.batch(stmts);
	return { ok: true };
}

/** Read the session mirror for a workspace (newest first). Sandbox-independent. */
async function listSessions(env: Env, workspaceId: string): Promise<unknown[]> {
	if (!workspaceId) return [];
	const { results } = await env.DB.prepare(
		// DF-2 defense-in-depth: `datetime()` normalizes both timestamp formats
		// (legacy space-separated vs RFC 3339), so mixed stock rows sort
		// chronologically even before the container migration propagates.
		// Within-second ties fall back to `id ASC` (R2-D determinism).
		`SELECT id, workspace_id, title, status, model, agent_type, permission_mode,
		        effort_level, action_kind, session_kind, is_hidden,
		        last_user_message_at, created_at, updated_at
		 FROM sessions WHERE workspace_id = ?1
		 ORDER BY datetime(created_at) ASC, id ASC`,
	)
		.bind(workspaceId)
		.all();
	return results;
}

/** Read the raw message mirror for a session, ordered for the pipeline. */
async function listSessionMessages(
	env: Env,
	sessionId: string,
): Promise<unknown[]> {
	if (!sessionId) return [];
	const { results } = await env.DB.prepare(
		`SELECT id, session_id, role, content, sent_at, created_at, author_id
		 FROM messages WHERE session_id = ?1 ORDER BY sent_at ASC, rowid ASC`,
	)
		.bind(sessionId)
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
	deps: TeamGatewayStoreDeps = DEFAULT_STORE_DEPS,
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

	// OBS-R6-1: restart whenever a token was actually stored, not only on an
	// account switch. The Codex DO's `changed` is account hygiene (docstring:
	// "identity hygiene only"), so a SAME-account re-authorization reported
	// changed=false and the warm container kept its old startProcess-env auth
	// (401 token_invalidated until natural sleep). `restartForReauth` itself
	// guards the not-serving case.
	if (result.stored || result.changed) await deps.restartForReauth(env);
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
	deps: TeamGatewayStoreDeps = DEFAULT_STORE_DEPS,
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

	if (result.changed) await deps.restartForReauth(env);
	return { changed: result.changed };
}

/** The one Sandbox DO capability the reauth restart needs — the custom
 *  `backupThenDestroyForReauth` method on the `Sandbox` class (index.ts),
 *  reached over DO RPC. Structural so tests can pass a spy; the production
 *  stub is the `getSandbox` proxy, which passes unknown properties through to
 *  the raw DO stub (verified in the SDK source), so the custom method
 *  dispatches — only TypeScript needs the cast. */
export type ReauthRestartableSandbox = {
	backupThenDestroyForReauth(): Promise<void>;
};

/**
 * Restart a SERVING sandbox so a just-(re)authorized cloud identity takes
 * effect (round6 P1-4a). Codex/Claude tokens are `startProcess` ENV on the
 * serve — they cannot hot-reload — so the container must truly restart:
 * backup-then-DESTROY (SIGKILL). The previous `stop()` (SIGTERM) was a no-op
 * lie: `helmor serve` ignores SIGTERM, the VM stayed up (active:1) caching the
 * old credential, and nothing ever re-minted (see the idle path's
 * `onActivityExpired` in index.ts for the live-verified evidence).
 *
 * Rules (both architect-mandated):
 *  - NEVER a bare `destroy()`: back up first, or /home/helmor rolls back to
 *    the last idle snapshot and everything since is lost.
 *  - `probe` (healthOk, non-waking) gates the whole thing: a container that
 *    isn't serving has no serve to kill and NO REAL DISK to snapshot (scaled
 *    to zero = ephemeral disk), so backing it up would capture garbage — skip
 *    entirely; the next cold start re-mints the fresh identity anyway.
 *
 * Best-effort: the identity is already persisted, so any failure here just
 * means the change applies on the next cold start instead of immediately.
 */
export async function restartSandboxForReauth(
	sandbox: ReauthRestartableSandbox,
	probe: () => Promise<boolean>,
): Promise<void> {
	try {
		if (!(await probe())) return;
		await sandbox.backupThenDestroyForReauth();
	} catch {
		// ignore — store already succeeded; next cold start applies it regardless
	}
}

/** Env-wiring for {@link restartSandboxForReauth} (the default
 *  `restartForReauth` store dep). */
async function stopSandboxForReauth(env: Env): Promise<void> {
	try {
		const sandbox = getSandbox(
			env.Sandbox,
			env.HELMOR_SANDBOX_ID ?? "helmor-team-0",
		);
		const port = Number(env.HELMOR_COMPANION_PORT ?? "8080");
		await restartSandboxForReauth(
			sandbox as unknown as ReauthRestartableSandbox,
			() => healthOk(sandbox, port),
		);
	} catch {
		// ignore — store already succeeded; next cold start applies it regardless
	}
}

/** Env-wiring for the live forge-creds re-inject (the default
 *  `reinjectForgeCreds` store dep) — see
 *  {@link reinjectForgeMembersIfServing} for the guard semantics. */
async function reinjectForgeCredsLive(env: Env): Promise<void> {
	try {
		const sandbox = getSandbox(
			env.Sandbox,
			env.HELMOR_SANDBOX_ID ?? "helmor-team-0",
		);
		const port = Number(env.HELMOR_COMPANION_PORT ?? "8080");
		await reinjectForgeMembersIfServing(sandbox, env, () =>
			healthOk(sandbox, port),
		);
	} catch {
		// ignore — creds are persisted in the DO; the next cold start injects them
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
 * Every member's DO is independent (keyed by their own member id), but since
 * round6 P1-2a only ONE member's tokens ever reach the container: the team's
 * forge "creator", bound below as `teams.forge_identity_member_id` —
 * FIRST-authorizer-wins (a later PUT by another member still stores their DO,
 * but never rebinds the column). A non-creator racing to authorize first is
 * the same accepted TOFU edge as cloud identity. Cold start injects the
 * creator's tokens only; the forge layer falls back to them for every acting
 * member (creator-identity model, user product ruling).
 *
 * SECURITY: same trust boundary as the Claude route — member id comes SOLELY
 * from the bearer->`invites.member_id` mapping (never client-supplied). Tokens
 * are handed to the DO (encrypted at rest there), NEVER logged or echoed.
 */
async function putForgeIdentity(
	env: Env,
	memberId: string,
	input: { githubToken?: string; glabConfigYml?: string },
	deps: TeamGatewayStoreDeps = DEFAULT_STORE_DEPS,
): Promise<{ changed: boolean }> {
	const stub = env.FORGE_IDENTITY.get(env.FORGE_IDENTITY.idFromName(memberId));
	const result = await stub.store(input);

	// Bind the team's forge creator (first-authorizer-wins). Mirrors
	// putCloudIdentity's single-row upsert, except COALESCE keeps an existing
	// binding instead of overwriting it.
	await env.DB.prepare(
		`INSERT INTO teams (id, sandbox_id, forge_identity_member_id) VALUES (?1, ?2, ?3)
		 ON CONFLICT(id) DO UPDATE SET forge_identity_member_id =
		   COALESCE(teams.forge_identity_member_id, excluded.forge_identity_member_id)`,
	)
		.bind(TEAM_ID, env.HELMOR_SANDBOX_ID, memberId)
		.run();

	// Round6 P1-4a: rewrite the RUNNING container's members file so the fresh
	// credential takes effect immediately (mtime hot-reload — no restart).
	// Before this, injection ran ONLY at cold start, so authorizing forge left
	// a warm container's creds stale until a manual destroy (class2 rollout:
	// private clone failed with `could not read Username`). UNCONDITIONAL (no
	// `result.changed` gate, unlike the cloud-identity restart): one writeFile
	// is cheap + idempotent, and re-injecting on an unchanged token self-heals
	// an earlier failed injection.
	await deps.reinjectForgeCreds(env);

	return result;
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
