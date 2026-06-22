export const TEAM_ID = "team-0";

const MEMBER_ID_HEADER = "X-Helmor-Member-Id";

export type TeamGatewayCaller = "admin" | "member" | "unauthorized";

export interface TeamGatewayAuth {
	caller: TeamGatewayCaller;
	memberId: string | null;
}

export interface TeamGatewayStore {
	classifyBearer(token: string | null): Promise<TeamGatewayAuth>;
	bootstrap(): Promise<{ teamId: string }>;
	createInvite(input: {
		expiresAt?: string | null;
	}): Promise<{ token: string; url: string }>;
	acceptInvite(
		input: TeamGatewayAcceptInviteInput,
	): Promise<TeamGatewayAcceptInviteResult>;
	listMembers(): Promise<unknown[]>;
	listWorkspaces(): Promise<unknown[]>;
	putCodexIdentity(
		memberId: string,
		input: { refreshToken: string; idToken: string },
	): Promise<unknown>;
	getCodexIdentity(): Promise<unknown>;
	putClaudeIdentity(
		memberId: string,
		input: { oauthToken: string },
	): Promise<unknown>;
	getClaudeIdentity(): Promise<unknown>;
	putForgeIdentity(
		memberId: string,
		input: { githubToken?: string; glabConfigYml?: string },
	): Promise<unknown>;
	getForgeIdentity(memberId: string): Promise<unknown>;
}

export interface TeamGatewayAcceptInviteInput {
	token: string;
	githubId: string;
	login: string;
	avatarUrl?: string | null;
	displayName?: string | null;
}

export type TeamGatewayAcceptInviteResult =
	| { ok: true; memberId: string }
	| { ok: false; status: number; message: string };

export interface TeamGatewayForwardedRequest {
	url: string;
	method: string;
	headers: Headers;
	body?: ArrayBuffer;
}

export async function handleTeamGatewayRoute(
	request: Request,
	url: URL,
	store: TeamGatewayStore,
): Promise<Response | null> {
	if (!url.pathname.startsWith("/team/")) return null;

	const route = `${request.method} ${url.pathname}`;
	let authPromise: Promise<TeamGatewayAuth> | null = null;
	const auth = () => {
		authPromise ??= store.classifyBearer(readGatewayBearer(request));
		return authPromise;
	};

	switch (route) {
		case "POST /team/bootstrap": {
			if ((await auth()).caller !== "admin") {
				return json({ code: "Unauthorized" }, 401);
			}
			return json({ ok: true, ...(await store.bootstrap()) });
		}
		case "POST /team/invite": {
			if ((await auth()).caller !== "admin") {
				return json({ code: "Unauthorized" }, 401);
			}
			const body = await readGatewayJsonBody(request);
			const expiresAt =
				typeof body.expiresAt === "string" ? body.expiresAt : null;
			return json(await store.createInvite({ expiresAt }));
		}
		case "POST /team/accept": {
			const body = await readGatewayJsonBody(request);
			const result = await store.acceptInvite({
				token: typeof body.token === "string" ? body.token : "",
				githubId:
					typeof body.githubId === "string"
						? body.githubId
						: String(body.githubId ?? ""),
				login: typeof body.login === "string" ? body.login : "",
				avatarUrl: typeof body.avatarUrl === "string" ? body.avatarUrl : null,
				displayName:
					typeof body.displayName === "string" ? body.displayName : null,
			});
			return result.ok
				? json({ ok: true, memberId: result.memberId })
				: json(
						{ code: statusCodeName(result.status), message: result.message },
						result.status,
					);
		}
		case "GET /team/members": {
			if ((await auth()).caller === "unauthorized") {
				return json({ code: "Unauthorized" }, 401);
			}
			return json({ members: await store.listMembers() });
		}
		case "GET /team/workspaces": {
			if ((await auth()).caller === "unauthorized") {
				return json({ code: "Unauthorized" }, 401);
			}
			return json({ workspaces: await store.listWorkspaces() });
		}
		case "PUT /team/cloud-identity": {
			const caller = await auth();
			if (!caller.memberId) return json({ code: "Unauthorized" }, 401);
			const body = await readGatewayJsonBody(request);
			const refreshToken =
				typeof body.refreshToken === "string" ? body.refreshToken : "";
			const idToken = typeof body.idToken === "string" ? body.idToken : "";
			if (!refreshToken || !idToken) {
				return json(
					{ code: "BadRequest", message: "refreshToken, idToken required" },
					400,
				);
			}
			return json(
				await store.putCodexIdentity(caller.memberId, {
					refreshToken,
					idToken,
				}),
			);
		}
		case "GET /team/cloud-identity": {
			if ((await auth()).caller === "unauthorized") {
				return json({ code: "Unauthorized" }, 401);
			}
			return json(await store.getCodexIdentity());
		}
		case "PUT /team/claude-identity": {
			const caller = await auth();
			if (!caller.memberId) return json({ code: "Unauthorized" }, 401);
			const body = await readGatewayJsonBody(request);
			const oauthToken =
				typeof body.oauthToken === "string" ? body.oauthToken : "";
			if (!oauthToken) {
				return json(
					{ code: "BadRequest", message: "oauthToken required" },
					400,
				);
			}
			return json(
				await store.putClaudeIdentity(caller.memberId, { oauthToken }),
			);
		}
		case "GET /team/claude-identity": {
			if ((await auth()).caller === "unauthorized") {
				return json({ code: "Unauthorized" }, 401);
			}
			return json(await store.getClaudeIdentity());
		}
		case "PUT /team/forge-identity": {
			const caller = await auth();
			if (!caller.memberId) return json({ code: "Unauthorized" }, 401);
			const body = await readGatewayJsonBody(request);
			const githubToken =
				typeof body.githubToken === "string" ? body.githubToken : undefined;
			const glabConfigYml =
				typeof body.glabConfigYml === "string" ? body.glabConfigYml : undefined;
			if (!githubToken && !glabConfigYml) {
				return json(
					{
						code: "BadRequest",
						message: "githubToken or glabConfigYml required",
					},
					400,
				);
			}
			return json(
				await store.putForgeIdentity(caller.memberId, {
					githubToken,
					glabConfigYml,
				}),
			);
		}
		case "GET /team/forge-identity": {
			// Per-member: a member reads only THEIR OWN forge status (the admin
			// token carries no member identity, so it gets 401 here).
			const caller = await auth();
			if (!caller.memberId) return json({ code: "Unauthorized" }, 401);
			return json(await store.getForgeIdentity(caller.memberId));
		}
		default:
			return json({ code: "NotFound", message: `no route ${route}` }, 404);
	}
}

export async function deriveGatewayHeaders(
	request: Request,
	options: { store: TeamGatewayStore; companionToken: string },
): Promise<Headers | Response> {
	const headers = new Headers(request.headers);
	headers.delete(MEMBER_ID_HEADER);

	const bearer = readGatewayBearer(request);
	if (!bearer) return headers;

	const auth = await options.store.classifyBearer(bearer);
	if (auth.caller === "unauthorized") {
		return json({ code: "Unauthorized" }, 401);
	}

	headers.set("Authorization", `Bearer ${options.companionToken}`);
	if (auth.caller === "member") {
		if (!auth.memberId) return json({ code: "Unauthorized" }, 401);
		headers.set(MEMBER_ID_HEADER, auth.memberId);
	}
	return headers;
}

export async function deriveGatewayForwardedRequest(
	request: Request,
	options: {
		store: TeamGatewayStore;
		companionToken: string;
		body?: ArrayBuffer;
	},
): Promise<TeamGatewayForwardedRequest | Response> {
	const headers = await deriveGatewayHeaders(request, options);
	if (headers instanceof Response) return headers;
	return {
		url: request.url,
		method: request.method,
		headers,
		body: options.body,
	};
}

export function stripInboundMemberHeader(request: Request): Request {
	if (!request.headers.has(MEMBER_ID_HEADER)) return request;
	const headers = new Headers(request.headers);
	headers.delete(MEMBER_ID_HEADER);
	return new Request(request, { headers });
}

export function readGatewayBearer(request: Request): string | null {
	const header = request.headers.get("Authorization");
	if (!header) return null;
	const match = /^Bearer\s+(.+)$/i.exec(header);
	return match?.[1] ?? null;
}

export function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

export function statusCodeName(status: number): string {
	switch (status) {
		case 400:
			return "BadRequest";
		case 401:
			return "Unauthorized";
		case 404:
			return "NotFound";
		case 409:
			return "Conflict";
		case 410:
			return "Gone";
		default:
			return "Error";
	}
}

export function inferRepoName(url: string): string | null {
	const trimmed = url.trim().replace(/[/\\]+$/, "");
	const withoutGit = trimmed.endsWith(".git")
		? trimmed.slice(0, -".git".length)
		: trimmed;
	const segments = withoutGit.split(/[/\\:]/);
	const last = (segments[segments.length - 1] ?? "").trim();
	return last.length > 0 ? last : null;
}

async function readGatewayJsonBody(
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
