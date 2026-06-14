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
