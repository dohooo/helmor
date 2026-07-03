/**
 * Team cloud control-plane client. Unlike `src/lib/api.ts` (which wraps
 * Tauri `invoke` calls to the *local* backend), these are plain `fetch()`
 * calls to the Cloudflare Worker that fronts a shared team sandbox — the
 * registry lives in the Worker (D1), not on this machine.
 *
 * Trust model (decided): the invite token IS the member's bearer (a
 * capability token). `/team/accept` is open — holding the token is the
 * credential. `members.id` is the GitHub NUMERIC id (string form), which
 * survives a login rename.
 */

import type { ActionKind, WorkspaceSessionSummary } from "./api";
import type { TeamConfig } from "./team-mode";

/** A team member as returned by `GET /team/members`. Field names mirror
 * the D1 row shape (snake_case) the Worker emits verbatim. */
export interface TeamMember {
	/** GitHub numeric id (string form) — the stable member identity. */
	id: string;
	github_login: string;
	avatar_url: string | null;
	display_name: string | null;
}

/** A team workspace as returned by `GET /team/workspaces`. */
export interface TeamWorkspace {
	id: string;
	name: string;
	status: string;
	created_at: number;
}

/** The accepting user's GitHub identity, sent to `POST /team/accept`.
 * `githubId` is the numeric id (string form) — load-bearing for member
 * identity (see `forge::accounts::ForgeAccount.id`). */
export interface TeamIdentity {
	githubId: string;
	login: string;
	avatarUrl?: string | null;
	displayName?: string | null;
}

/** Distinguishable accept failures so the UI can phrase each one. The
 * Worker maps these to HTTP status codes (404 unknown / 410 expired /
 * 409 already-claimed); `network` covers fetch/CORS failure. */
export type AcceptInviteError =
	| "unknown" // 404 — token not recognized
	| "expired" // 410 — invite lapsed
	| "claimed" // 409 — already redeemed
	| "network" // fetch threw (offline / CORS / DNS)
	| "server"; // any other non-2xx

export interface AcceptInviteResult {
	ok: boolean;
	memberId: string;
}

function normalizeUrl(url: string): string {
	return url.trim().replace(/\/+$/, "");
}

/** Thrown by {@link acceptInvite} so the caller can branch on `reason`
 * (to phrase the toast) without parsing message strings. */
export class InviteAcceptFailure extends Error {
	constructor(
		readonly reason: AcceptInviteError,
		message: string,
	) {
		super(message);
		this.name = "InviteAcceptFailure";
	}
}

function acceptErrorForStatus(status: number): AcceptInviteError {
	switch (status) {
		case 404:
			return "unknown";
		case 410:
			return "expired";
		case 409:
			return "claimed";
		default:
			return "server";
	}
}

/**
 * Redeem an invite token against `{workerUrl}/team/accept`, registering the
 * caller as a member under their GitHub identity. On success the token is
 * the member's durable bearer — persist it via `saveTeamConfig`.
 *
 * Throws {@link InviteAcceptFailure} (with a `reason`) on any failure so the
 * UI can surface 404 / 410 / 409 distinctly.
 */
export async function acceptInvite(
	workerUrl: string,
	token: string,
	identity: TeamIdentity,
): Promise<AcceptInviteResult> {
	const base = normalizeUrl(workerUrl);
	let res: Response;
	try {
		res = await fetch(`${base}/team/accept`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				token,
				githubId: identity.githubId,
				login: identity.login,
				avatarUrl: identity.avatarUrl ?? undefined,
				displayName: identity.displayName ?? undefined,
			}),
		});
	} catch (error) {
		throw new InviteAcceptFailure(
			"network",
			error instanceof Error ? error.message : "Network request failed",
		);
	}
	if (!res.ok) {
		throw new InviteAcceptFailure(
			acceptErrorForStatus(res.status),
			`Invite accept failed (HTTP ${res.status})`,
		);
	}
	const body = (await res
		.json()
		.catch(() => ({}))) as Partial<AcceptInviteResult>;
	return { ok: body.ok ?? true, memberId: body.memberId ?? "" };
}

/** Bearer header for the saved team config (invite token OR shared admin
 * token — both are accepted by the read routes). */
function authHeaders(cfg: TeamConfig): HeadersInit {
	return cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {};
}

/**
 * Stage D: pre-warm the team sandbox container in the BACKGROUND so a subsequent
 * @agent run is hot. The Worker's `/admin/warm-up` returns 202 immediately and
 * wakes the container via `ctx.waitUntil`. Fire-and-forget + best-effort — a
 * failure (offline / transient) is swallowed; warm-up is an optimization, never
 * a hard dependency, and must never block or surface an error to the composer.
 */
export async function warmUpSandbox(cfg: TeamConfig): Promise<void> {
	const base = normalizeUrl(cfg.url);
	try {
		await fetch(`${base}/admin/warm-up`, {
			method: "POST",
			headers: authHeaders(cfg),
		});
	} catch {
		// best-effort: warm-up never blocks or surfaces an error
	}
}

/**
 * `POST /team/bootstrap` (admin) — create/upsert the single team row, returning
 * its id. The route is admin-gated: a 401 means {@link TeamConfig.token} is not
 * the companion/admin token (an ordinary invite/member token can't bootstrap).
 * Mirrors {@link listTeamMembers}' error style (throw on non-2xx) so the panel
 * surfaces the failure rather than silently no-op'ing.
 */
export async function createTeam(cfg: TeamConfig): Promise<{ teamId: string }> {
	const base = normalizeUrl(cfg.url);
	const res = await fetch(`${base}/team/bootstrap`, {
		method: "POST",
		headers: { ...authHeaders(cfg), "Content-Type": "application/json" },
		body: JSON.stringify({}),
	});
	if (!res.ok) {
		throw new Error(
			res.status === 401
				? "Not an admin token — use the companion/admin token to create a team (HTTP 401)."
				: `Failed to create team (HTTP ${res.status})`,
		);
	}
	const body = (await res.json()) as { teamId?: string };
	return { teamId: body.teamId ?? "" };
}

/**
 * `POST /team/invite` (admin) — mint a one-time invite token (which doubles as
 * the member's bearer once accepted). Returns the bare `{token, url}` the Worker
 * emits; the URL is a capability secret — render it only after an explicit user
 * action, never log it. Admin-gated like {@link createTeam}: 401 ⇒ not an admin
 * token.
 */
export async function mintInvite(
	cfg: TeamConfig,
	opts?: { expiresAt?: string },
): Promise<{ token: string; url: string }> {
	const base = normalizeUrl(cfg.url);
	const res = await fetch(`${base}/team/invite`, {
		method: "POST",
		headers: { ...authHeaders(cfg), "Content-Type": "application/json" },
		body: JSON.stringify(opts?.expiresAt ? { expiresAt: opts.expiresAt } : {}),
	});
	if (!res.ok) {
		throw new Error(
			res.status === 401
				? "Not an admin token — use the companion/admin token to mint invites (HTTP 401)."
				: `Failed to mint invite (HTTP ${res.status})`,
		);
	}
	const body = (await res.json()) as { token?: string; url?: string };
	return { token: body.token ?? "", url: body.url ?? "" };
}

/** `GET /team/members` — the roster rendered in the sidebar team section.
 * Throws on non-2xx / network failure so React Query surfaces an error
 * state rather than silently rendering an empty list. */
export async function listTeamMembers(cfg: TeamConfig): Promise<TeamMember[]> {
	const base = normalizeUrl(cfg.url);
	const res = await fetch(`${base}/team/members`, {
		headers: authHeaders(cfg),
	});
	if (!res.ok) {
		throw new Error(`Failed to load team members (HTTP ${res.status})`);
	}
	const body = (await res.json()) as { members?: TeamMember[] };
	return body.members ?? [];
}

/** `GET /team/workspaces` — the shared sandbox's workspaces. */
export async function listTeamWorkspaces(
	cfg: TeamConfig,
): Promise<TeamWorkspace[]> {
	const base = normalizeUrl(cfg.url);
	const res = await fetch(`${base}/team/workspaces`, {
		headers: authHeaders(cfg),
	});
	if (!res.ok) {
		throw new Error(`Failed to load team workspaces (HTTP ${res.status})`);
	}
	const body = (await res.json()) as { workspaces?: TeamWorkspace[] };
	return body.workspaces ?? [];
}

/** Raw D1 session-mirror row from `GET /team/sessions` (snake_case, matching the
 *  Worker's `sessions` table). Mapped to {@link WorkspaceSessionSummary} below. */
interface TeamSessionRow {
	id: string;
	workspace_id: string;
	title: string | null;
	status: string | null;
	model: string | null;
	agent_type: string | null;
	permission_mode: string | null;
	effort_level: string | null;
	action_kind: string | null;
	session_kind: string | null;
	is_hidden: number | boolean;
	last_user_message_at: string | null;
	created_at: string | null;
	updated_at: string | null;
}

function toSessionSummary(row: TeamSessionRow): WorkspaceSessionSummary {
	return {
		id: row.id,
		workspaceId: row.workspace_id,
		title: row.title ?? "Untitled",
		agentType: row.agent_type ?? null,
		status: row.status ?? "idle",
		model: row.model ?? null,
		permissionMode: row.permission_mode ?? "default",
		// Browsing-only fields: these resume-time values come from the live
		// container when the user actually runs a turn, not the mirror.
		providerSessionId: null,
		effortLevel: row.effort_level ?? null,
		unreadCount: 0,
		fastMode: false,
		createdAt: row.created_at ?? "",
		updatedAt: row.updated_at ?? "",
		lastUserMessageAt: row.last_user_message_at ?? null,
		isHidden: row.is_hidden === 1 || row.is_hidden === true,
		actionKind: (row.action_kind as ActionKind | null) ?? null,
		sessionKind: row.session_kind === "terminal" ? "terminal" : "gui",
		active: false,
	};
}

/** `GET /team/sessions` — the D1 session mirror for a workspace. Readable with
 *  the sandbox asleep (Stage B), shaped like the local `list_workspace_sessions`. */
export async function listTeamSessions(
	cfg: TeamConfig,
	workspaceId: string,
): Promise<WorkspaceSessionSummary[]> {
	const base = normalizeUrl(cfg.url);
	const res = await fetch(
		`${base}/team/sessions?workspaceId=${encodeURIComponent(workspaceId)}`,
		{ headers: authHeaders(cfg) },
	);
	if (!res.ok) {
		throw new Error(`Failed to load team sessions (HTTP ${res.status})`);
	}
	const body = (await res.json()) as { sessions?: TeamSessionRow[] };
	return (body.sessions ?? []).map(toSessionSummary);
}

/** Raw D1 message-mirror row from `GET /team/messages` (snake_case). Fed to the
 *  local `convert_historical_records` command so it renders identically to the
 *  container path. */
export interface TeamMessageRow {
	id: string;
	session_id: string;
	role: string | null;
	content: string | null;
	sent_at: string | null;
	created_at: string | null;
	author_id: string | null;
}

/** `GET /team/git-status` — the D1 git snapshot mirror (R2-E). Null when the
 *  container has never pushed one for this workspace (fresh repo / chat
 *  workspace). Readable with the sandbox asleep. */
export async function getTeamGitSnapshot(
	cfg: TeamConfig,
	workspaceId: string,
): Promise<{ gitStatus?: unknown; changes?: unknown } | null> {
	const base = normalizeUrl(cfg.url);
	const res = await fetch(
		`${base}/team/git-status?workspaceId=${encodeURIComponent(workspaceId)}`,
		{ headers: authHeaders(cfg) },
	);
	if (!res.ok) {
		throw new Error(`Failed to load team git snapshot (HTTP ${res.status})`);
	}
	const body = (await res.json()) as {
		snapshot?: { gitStatus?: unknown; changes?: unknown } | null;
	};
	return body.snapshot ?? null;
}

/** `GET /team/messages` — the D1 message mirror for a session (raw rows). */
export async function listTeamSessionMessages(
	cfg: TeamConfig,
	sessionId: string,
): Promise<TeamMessageRow[]> {
	const base = normalizeUrl(cfg.url);
	const res = await fetch(
		`${base}/team/messages?sessionId=${encodeURIComponent(sessionId)}`,
		{ headers: authHeaders(cfg) },
	);
	if (!res.ok) {
		throw new Error(
			`Failed to load team session messages (HTTP ${res.status})`,
		);
	}
	const body = (await res.json()) as { messages?: TeamMessageRow[] };
	return body.messages ?? [];
}

/**
 * The team's cloud Codex identity status, as returned by the Worker's
 * `GET /team/cloud-identity` → the bound member's `CodexIdentity` DO
 * `status()`. The Worker emits these camelCase fields verbatim. NEVER carries
 * the `refresh_token` or the `access_token` — metadata only.
 */
export interface CloudCodexIdentityStatus {
	/** Whether the DO currently holds a refresh token for this team. */
	hasToken: boolean;
	/** Bound ChatGPT account id (from the id_token claim), if any. */
	accountId: string | null;
	/** Cached access-token expiry as a unix epoch in SECONDS (the JWT `exp`
	 *  claim), or null when no token is cached. */
	accessExp: number | null;
	/** True once the DO marked the identity unrecoverable (persist failure /
	 *  revoked RT) and a fresh authorization is required. */
	bricked: boolean;
}

/**
 * `GET /team/cloud-identity` — the team's cloud Codex identity status (the
 * member's `CodexIdentity` DO `status()`). Mirrors {@link listTeamMembers}:
 * bearer auth, throws on non-2xx so React Query surfaces an error state.
 */
export async function getCloudCodexIdentityStatus(
	cfg: TeamConfig,
): Promise<CloudCodexIdentityStatus> {
	const base = normalizeUrl(cfg.url);
	const res = await fetch(`${base}/team/cloud-identity`, {
		headers: authHeaders(cfg),
	});
	if (!res.ok) {
		throw new Error(`Failed to load cloud identity (HTTP ${res.status})`);
	}
	const body = (await res.json()) as Partial<CloudCodexIdentityStatus>;
	return {
		hasToken: body.hasToken ?? false,
		accountId: body.accountId ?? null,
		accessExp: body.accessExp ?? null,
		bricked: body.bricked ?? false,
	};
}

/**
 * The team's cloud Claude identity status, as returned by the Worker's
 * `GET /team/claude-identity` → the bound member's `ClaudeIdentity` DO
 * `status()`. Far simpler than the Codex shape: the `setup-token` credential is
 * a self-contained ~1-year inference-only token (no refresh, no JWT, no account
 * claim — see claude-cloud-auth-VERIFIED.md §1.7), so status is `{ hasToken }`
 * only. NEVER carries the token itself — metadata only.
 */
export interface CloudClaudeIdentityStatus {
	/** Whether the DO currently holds a Claude OAuth token for this team. */
	hasToken: boolean;
}

/**
 * `GET /team/claude-identity` — the team's cloud Claude identity status (the
 * member's `ClaudeIdentity` DO `status()`). Mirrors
 * {@link getCloudCodexIdentityStatus}: bearer auth, throws on non-2xx so React
 * Query surfaces an error state.
 */
export async function getCloudClaudeIdentityStatus(
	cfg: TeamConfig,
): Promise<CloudClaudeIdentityStatus> {
	const base = normalizeUrl(cfg.url);
	const res = await fetch(`${base}/team/claude-identity`, {
		headers: authHeaders(cfg),
	});
	if (!res.ok) {
		throw new Error(
			`Failed to load cloud Claude identity (HTTP ${res.status})`,
		);
	}
	const body = (await res.json()) as Partial<CloudClaudeIdentityStatus>;
	return {
		hasToken: body.hasToken ?? false,
	};
}
