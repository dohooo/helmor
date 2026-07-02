import {
	type ForgeIdentityInput,
	type ForgeIdentityStatus,
	forgeStatusFromInput,
} from "../forge-config";
import { TEAM_ID, type TeamSyncInput } from "../team-gateway/core";

export const LOCAL_TEAM_ID = TEAM_ID;

type Caller = "admin" | "member" | "unauthorized";

export interface LocalTeamMember {
	id: string;
	github_login: string;
	avatar_url: string | null;
	display_name: string | null;
}

export interface LocalTeamWorkspace {
	id: string;
	name: string;
	status: string;
	created_at: string;
}

export interface LocalInvite {
	token: string;
	team_id: string;
	member_id: string | null;
	created_at: string;
	expires_at: string | null;
}

/** Stage B mirror rows — snake_case to match the D1 columns + the desktop's
 *  historical-record reader, so local dev and the deployed Worker serve the
 *  same shape. */
export interface LocalSessionRow {
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
	is_hidden: number;
	last_user_message_at: string | null;
	created_at: string | null;
	updated_at: string | null;
}
export interface LocalMessageRow {
	id: string;
	session_id: string;
	role: string | null;
	content: string | null;
	sent_at: string | null;
	created_at: string | null;
	author_id: string | null;
}

export interface CloudCodexIdentityStatus {
	hasToken: boolean;
	accountId: string | null;
	accessExp: number | null;
	bricked: boolean;
}

export interface CloudClaudeIdentityStatus {
	hasToken: boolean;
}

export interface LocalTeamSnapshot {
	teams: Record<
		string,
		{
			id: string;
			sandbox_id: string;
			cloud_identity_member_id: string | null;
		}
	>;
	members: Record<string, LocalTeamMember>;
	invites: Record<string, LocalInvite>;
	workspaces: Record<string, LocalTeamWorkspace & { team_id: string }>;
	sessions: Record<string, LocalSessionRow>;
	messages: Record<string, LocalMessageRow>;
	codexIdentities: Record<string, CloudCodexIdentityStatus>;
	claudeIdentities: Record<string, CloudClaudeIdentityStatus>;
	/** Local-dev only: the raw Claude OAuth token per member, kept so the
	 *  launcher can inject it into the container as CLAUDE_CODE_OAUTH_TOKEN.
	 *  NEVER returned over HTTP — `getClaudeIdentity` exposes only `{ hasToken }`. */
	claudeTokens: Record<string, string>;
	/** Per-member forge status (non-secret: `{ hasGithub, glabHosts }`). */
	forgeIdentities: Record<string, ForgeIdentityStatus>;
	/** Local-dev only: each member's raw forge creds (gh token / glab config),
	 *  kept so the launcher can inject them per-member into the container. NEVER
	 *  returned over HTTP — `getForgeIdentity` exposes only the status. */
	forgeCredentials: Record<string, ForgeIdentityInput>;
}

export interface AcceptInviteInput {
	token: string;
	githubId: string;
	login: string;
	avatarUrl?: string | null;
	displayName?: string | null;
}

export interface LocalTeamRegistry {
	classify(
		token: string | null,
		adminToken: string,
	): Promise<{
		caller: Caller;
		memberId: string | null;
	}>;
	lookupMemberId(token: string): Promise<string | null>;
	bootstrap(sandboxId: string): Promise<{ teamId: string }>;
	createInvite(input: {
		baseUrl: string;
		expiresAt?: string | null;
		token?: string;
	}): Promise<{ token: string; url: string }>;
	acceptInvite(
		input: AcceptInviteInput,
	): Promise<
		| { ok: true; memberId: string }
		| { ok: false; status: number; message: string }
	>;
	listMembers(): Promise<LocalTeamMember[]>;
	listWorkspaces(): Promise<LocalTeamWorkspace[]>;
	upsertWorkspace(workspace: {
		id: string;
		name: string;
		status?: string;
		createdAt?: string;
	}): Promise<void>;
	syncTeamData(input: TeamSyncInput): Promise<{ ok: true }>;
	/** WP5: model-catalog cache (local analog of the Worker's D1 `model_catalog`
	 *  row). Ephemeral in-memory by design — a proxy restart is a "fresh Worker"
	 *  and re-seeds on the first live pass of the RPC. */
	getModelCatalog(): string | null;
	setModelCatalog(payload: string): void;
	listSessions(workspaceId: string): Promise<LocalSessionRow[]>;
	listSessionMessages(sessionId: string): Promise<LocalMessageRow[]>;
	putCodexIdentity(
		memberId: string,
		input: { refreshToken: string; idToken: string },
	): Promise<{ accountId: string | null; changed: boolean }>;
	getCodexIdentity(): Promise<CloudCodexIdentityStatus>;
	putClaudeIdentity(
		memberId: string,
		input: { oauthToken: string },
	): Promise<{ changed: boolean }>;
	getClaudeIdentity(): Promise<CloudClaudeIdentityStatus>;
	putForgeIdentity(
		memberId: string,
		input: ForgeIdentityInput,
	): Promise<{ changed: boolean }>;
	getForgeIdentity(memberId: string): Promise<ForgeIdentityStatus>;
	snapshot(): LocalTeamSnapshot;
}

export class InMemoryLocalTeamRegistry implements LocalTeamRegistry {
	private snapshotState: LocalTeamSnapshot;
	private readonly onChange?: (snapshot: LocalTeamSnapshot) => void;
	/** WP5 model-catalog cache — deliberately NOT part of the snapshot (it is a
	 *  derived cache, not team state; the Worker's D1 row is likewise disposable). */
	private modelCatalog: string | null = null;

	getModelCatalog(): string | null {
		return this.modelCatalog;
	}

	setModelCatalog(payload: string): void {
		this.modelCatalog = payload;
	}

	constructor(
		initial?: Partial<LocalTeamSnapshot>,
		onChange?: (snapshot: LocalTeamSnapshot) => void,
	) {
		this.snapshotState = normalizeSnapshot(initial);
		this.onChange = onChange;
	}

	async classify(
		token: string | null,
		adminToken: string,
	): Promise<{ caller: Caller; memberId: string | null }> {
		if (!token) return { caller: "unauthorized", memberId: null };
		if (token === adminToken) return { caller: "admin", memberId: null };
		const memberId = await this.lookupMemberId(token);
		return memberId
			? { caller: "member", memberId }
			: { caller: "unauthorized", memberId: null };
	}

	async lookupMemberId(token: string): Promise<string | null> {
		return this.snapshotState.invites[token]?.member_id ?? null;
	}

	async bootstrap(sandboxId: string): Promise<{ teamId: string }> {
		this.snapshotState.teams[LOCAL_TEAM_ID] = {
			id: LOCAL_TEAM_ID,
			sandbox_id: sandboxId,
			cloud_identity_member_id:
				this.snapshotState.teams[LOCAL_TEAM_ID]?.cloud_identity_member_id ??
				null,
		};
		this.changed();
		return { teamId: LOCAL_TEAM_ID };
	}

	async createInvite(input: {
		baseUrl: string;
		expiresAt?: string | null;
		/** Seed a fixed invite token (local dev only) instead of a random UUID,
		 *  so the desktop can default to a known token with no manual entry. */
		token?: string;
	}): Promise<{ token: string; url: string }> {
		const token = input.token?.trim() || crypto.randomUUID();
		this.snapshotState.invites[token] = {
			token,
			team_id: LOCAL_TEAM_ID,
			member_id: null,
			created_at: new Date().toISOString(),
			expires_at: input.expiresAt ?? null,
		};
		this.changed();
		return {
			token,
			url: `${input.baseUrl.replace(/\/+$/, "")}/?invite=${token}`,
		};
	}

	async acceptInvite(
		input: AcceptInviteInput,
	): Promise<
		| { ok: true; memberId: string }
		| { ok: false; status: number; message: string }
	> {
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

		const invite = this.snapshotState.invites[token];
		if (!invite) {
			return { ok: false, status: 404, message: "unknown invite" };
		}
		if (invite.expires_at) {
			const expiry = Date.parse(invite.expires_at);
			if (!Number.isFinite(expiry) || expiry < Date.now()) {
				return { ok: false, status: 410, message: "invite expired" };
			}
		}
		if (invite.member_id && invite.member_id !== githubId) {
			return { ok: false, status: 409, message: "invite already claimed" };
		}

		invite.member_id = githubId;
		this.snapshotState.members[githubId] = {
			id: githubId,
			github_login: login,
			avatar_url: input.avatarUrl ?? null,
			display_name: input.displayName ?? null,
		};
		this.changed();
		return { ok: true, memberId: githubId };
	}

	async listMembers(): Promise<LocalTeamMember[]> {
		return Object.values(this.snapshotState.members).sort((a, b) =>
			a.github_login.localeCompare(b.github_login),
		);
	}

	async listWorkspaces(): Promise<LocalTeamWorkspace[]> {
		return Object.values(this.snapshotState.workspaces)
			.filter((workspace) => workspace.team_id === LOCAL_TEAM_ID)
			.map(({ team_id: _teamId, ...workspace }) => workspace)
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	async upsertWorkspace(workspace: {
		id: string;
		name: string;
		status?: string;
		createdAt?: string;
	}): Promise<void> {
		this.snapshotState.workspaces[workspace.id] = {
			id: workspace.id,
			team_id: LOCAL_TEAM_ID,
			name: workspace.name,
			status: workspace.status ?? "active",
			created_at: workspace.createdAt ?? new Date().toISOString(),
		};
		this.changed();
	}

	async syncTeamData(input: TeamSyncInput): Promise<{ ok: true }> {
		for (const s of input.sessions ?? []) {
			if (!s?.id || !s.workspaceId) continue;
			this.snapshotState.sessions[s.id] = {
				id: s.id,
				workspace_id: s.workspaceId,
				title: s.title ?? null,
				status: s.status ?? null,
				model: s.model ?? null,
				agent_type: s.agentType ?? null,
				permission_mode: s.permissionMode ?? null,
				effort_level: s.effortLevel ?? null,
				action_kind: s.actionKind ?? null,
				session_kind: s.sessionKind ?? null,
				is_hidden: s.isHidden ? 1 : 0,
				last_user_message_at: s.lastUserMessageAt ?? null,
				created_at: s.createdAt ?? null,
				updated_at: s.updatedAt ?? null,
			};
		}
		for (const m of input.messages ?? []) {
			if (!m?.id || !m.sessionId) continue;
			// Append-only: never overwrite an existing message row.
			if (this.snapshotState.messages[m.id]) continue;
			this.snapshotState.messages[m.id] = {
				id: m.id,
				session_id: m.sessionId,
				role: m.role ?? null,
				content: m.content ?? null,
				sent_at: m.sentAt ?? null,
				created_at: m.createdAt ?? null,
				author_id: m.authorId ?? null,
			};
		}
		for (const id of input.deletedSessionIds ?? []) {
			if (!id) continue;
			delete this.snapshotState.sessions[id];
			for (const mid of Object.keys(this.snapshotState.messages)) {
				if (this.snapshotState.messages[mid]?.session_id === id) {
					delete this.snapshotState.messages[mid];
				}
			}
		}
		for (const id of input.deletedMessageIds ?? []) {
			if (id) delete this.snapshotState.messages[id];
		}
		const replace = input.replaceWorkspaceSessions;
		if (replace?.workspaceId) {
			const keep = new Set((replace.sessionIds ?? []).filter(Boolean));
			for (const sid of Object.keys(this.snapshotState.sessions)) {
				const row = this.snapshotState.sessions[sid];
				if (row?.workspace_id !== replace.workspaceId || keep.has(sid)) {
					continue;
				}
				delete this.snapshotState.sessions[sid];
				for (const mid of Object.keys(this.snapshotState.messages)) {
					if (this.snapshotState.messages[mid]?.session_id === sid) {
						delete this.snapshotState.messages[mid];
					}
				}
			}
		}
		this.changed();
		return { ok: true };
	}

	async listSessions(workspaceId: string): Promise<LocalSessionRow[]> {
		return Object.values(this.snapshotState.sessions)
			.filter((s) => s.workspace_id === workspaceId)
			.sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
	}

	async listSessionMessages(sessionId: string): Promise<LocalMessageRow[]> {
		return Object.values(this.snapshotState.messages)
			.filter((m) => m.session_id === sessionId)
			.sort((a, b) =>
				(a.sent_at ?? a.created_at ?? "").localeCompare(
					b.sent_at ?? b.created_at ?? "",
				),
			);
	}

	async putCodexIdentity(
		memberId: string,
		input: { refreshToken: string; idToken: string },
	): Promise<{ accountId: string | null; changed: boolean }> {
		if (!input.refreshToken || !input.idToken) {
			throw new Error("refreshToken, idToken required");
		}
		const accountId = parseJwtSubject(input.idToken);
		const previous = this.snapshotState.codexIdentities[memberId];
		const next = {
			hasToken: true,
			accountId,
			accessExp: null,
			bricked: false,
		};
		this.snapshotState.codexIdentities[memberId] = next;
		this.bindIdentityMember(memberId);
		this.changed();
		return {
			accountId,
			changed: JSON.stringify(previous ?? null) !== JSON.stringify(next),
		};
	}

	async getCodexIdentity(): Promise<CloudCodexIdentityStatus> {
		const memberId = this.identityMemberId();
		return memberId
			? (this.snapshotState.codexIdentities[memberId] ?? emptyCodexIdentity())
			: emptyCodexIdentity();
	}

	async putClaudeIdentity(
		memberId: string,
		input: { oauthToken: string },
	): Promise<{ changed: boolean }> {
		if (!input.oauthToken) throw new Error("oauthToken required");
		const previous = this.snapshotState.claudeIdentities[memberId];
		const next = { hasToken: true };
		this.snapshotState.claudeIdentities[memberId] = next;
		// Local dev: keep the raw token (NEVER exposed over HTTP) so the launcher
		// can inject it as CLAUDE_CODE_OAUTH_TOKEN when (re)creating the container.
		this.snapshotState.claudeTokens[memberId] = input.oauthToken;
		this.bindIdentityMember(memberId);
		this.changed();
		return {
			changed: JSON.stringify(previous ?? null) !== JSON.stringify(next),
		};
	}

	async getClaudeIdentity(): Promise<CloudClaudeIdentityStatus> {
		const memberId = this.identityMemberId();
		return memberId
			? (this.snapshotState.claudeIdentities[memberId] ?? {
					hasToken: false,
				})
			: { hasToken: false };
	}

	/** Local-dev only: the bound member's raw Claude OAuth token, for container
	 *  injection. Never exposed over HTTP (no gateway route returns it). */
	getClaudeToken(): string | null {
		const memberId = this.identityMemberId();
		return memberId
			? (this.snapshotState.claudeTokens[memberId] ?? null)
			: null;
	}

	async putForgeIdentity(
		memberId: string,
		input: ForgeIdentityInput,
	): Promise<{ changed: boolean }> {
		if (!input.githubToken && !input.glabConfigYml) {
			throw new Error("githubToken or glabConfigYml required");
		}
		const prev = this.snapshotState.forgeCredentials[memberId];
		// Merge so a gh-only re-auth keeps an existing glab config, and vice-versa
		// (mirrors the DO's merge behaviour).
		const merged: ForgeIdentityInput = {
			githubToken: input.githubToken ?? prev?.githubToken,
			glabConfigYml: input.glabConfigYml ?? prev?.glabConfigYml,
		};
		this.snapshotState.forgeCredentials[memberId] = merged;
		this.snapshotState.forgeIdentities[memberId] = forgeStatusFromInput(merged);
		this.changed();
		return { changed: Boolean(prev) };
	}

	async getForgeIdentity(memberId: string): Promise<ForgeIdentityStatus> {
		return (
			this.snapshotState.forgeIdentities[memberId] ?? {
				hasGithub: false,
				glabHosts: [],
			}
		);
	}

	/** Local-dev only: a member's raw forge creds, for per-member container
	 *  injection. Never exposed over HTTP (no gateway route returns it). */
	getForgeCredentials(memberId: string): ForgeIdentityInput | null {
		return this.snapshotState.forgeCredentials[memberId] ?? null;
	}

	snapshot(): LocalTeamSnapshot {
		return cloneSnapshot(this.snapshotState);
	}

	private bindIdentityMember(memberId: string) {
		this.snapshotState.teams[LOCAL_TEAM_ID] = {
			id: LOCAL_TEAM_ID,
			sandbox_id:
				this.snapshotState.teams[LOCAL_TEAM_ID]?.sandbox_id ?? "local-docker",
			cloud_identity_member_id: memberId,
		};
	}

	private identityMemberId(): string | null {
		return (
			this.snapshotState.teams[LOCAL_TEAM_ID]?.cloud_identity_member_id ?? null
		);
	}

	private changed() {
		this.onChange?.(this.snapshot());
	}
}

function normalizeSnapshot(
	initial?: Partial<LocalTeamSnapshot>,
): LocalTeamSnapshot {
	return {
		teams: initial?.teams ?? {},
		members: initial?.members ?? {},
		invites: initial?.invites ?? {},
		workspaces: initial?.workspaces ?? {},
		sessions: initial?.sessions ?? {},
		messages: initial?.messages ?? {},
		codexIdentities: initial?.codexIdentities ?? {},
		claudeIdentities: initial?.claudeIdentities ?? {},
		claudeTokens: initial?.claudeTokens ?? {},
		forgeIdentities: initial?.forgeIdentities ?? {},
		forgeCredentials: initial?.forgeCredentials ?? {},
	};
}

function cloneSnapshot(snapshot: LocalTeamSnapshot): LocalTeamSnapshot {
	return JSON.parse(JSON.stringify(snapshot)) as LocalTeamSnapshot;
}

function emptyCodexIdentity(): CloudCodexIdentityStatus {
	return {
		hasToken: false,
		accountId: null,
		accessExp: null,
		bricked: false,
	};
}

function parseJwtSubject(idToken: string): string | null {
	const [, payload] = idToken.split(".");
	if (!payload) return null;
	try {
		const decoded = JSON.parse(atobUrl(payload)) as { sub?: unknown };
		return typeof decoded.sub === "string" ? decoded.sub : null;
	} catch {
		return null;
	}
}

function atobUrl(value: string): string {
	const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
	const padded = normalized.padEnd(
		normalized.length + ((4 - (normalized.length % 4)) % 4),
		"=",
	);
	return atob(padded);
}
