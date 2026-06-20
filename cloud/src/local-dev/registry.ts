import { TEAM_ID } from "../team-gateway/core";

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
	codexIdentities: Record<string, CloudCodexIdentityStatus>;
	claudeIdentities: Record<string, CloudClaudeIdentityStatus>;
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
	snapshot(): LocalTeamSnapshot;
}

export class InMemoryLocalTeamRegistry implements LocalTeamRegistry {
	private snapshotState: LocalTeamSnapshot;
	private readonly onChange?: (snapshot: LocalTeamSnapshot) => void;

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
	}): Promise<{ token: string; url: string }> {
		const token = crypto.randomUUID();
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
		codexIdentities: initial?.codexIdentities ?? {},
		claudeIdentities: initial?.claudeIdentities ?? {},
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
