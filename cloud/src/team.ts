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

import type { Env } from "./index";

const TEAM_ID = "team-0";

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
