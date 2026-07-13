import {
	cachedCatalogResponse,
	MODEL_CATALOG_RPC,
	parseModelCatalogPayload,
} from "../model-catalog";
import {
	deriveGatewayForwardedRequest,
	handleTeamGatewayRoute,
	inferRepoName,
	json,
	stripInboundMemberHeader,
	type TeamGatewayForwardedRequest,
	type TeamGatewayStore,
} from "../team-gateway/core";
import type { LocalTeamRegistry } from "./registry";

export interface LocalTeamProxyOptions {
	registry: LocalTeamRegistry;
	companionBaseUrl: string;
	companionToken: string;
	adminToken: string;
	publicBaseUrl: string;
	sandboxId?: string;
	fetchCompanion?: (request: Request) => Promise<Response>;
	restartCompanion?: () => Promise<void>;
}

export interface LocalTeamGatewayStoreOptions {
	registry: LocalTeamRegistry;
	adminToken: string;
	/** The shared companion token the in-container Stage B write-through
	 *  authenticates with. The real Worker treats this token as admin (companion
	 *  and admin are one shared secret), so the local gateway must too — otherwise
	 *  PUT /team/sync 401s and team-mode history never populates locally. Optional:
	 *  callers that don't run a mirroring container (e.g. contract tests) omit it. */
	companionToken?: string;
	publicBaseUrl: string;
	sandboxId?: string;
}

export function createLocalTeamGatewayStore(
	options: LocalTeamGatewayStoreOptions,
): TeamGatewayStore {
	const sandboxId = options.sandboxId ?? "local-docker";
	return {
		classifyBearer: (token) =>
			options.companionToken && token === options.companionToken
				? Promise.resolve({ caller: "admin" as const, memberId: null })
				: options.registry.classify(token, options.adminToken),
		bootstrap: () => options.registry.bootstrap(sandboxId),
		createInvite: (input) =>
			options.registry.createInvite({
				baseUrl: options.publicBaseUrl,
				expiresAt: input.expiresAt,
			}),
		acceptInvite: (input) => options.registry.acceptInvite(input),
		listMembers: () => options.registry.listMembers(),
		listWorkspaces: () => options.registry.listWorkspaces(),
		putCodexIdentity: (memberId, input) =>
			options.registry.putCodexIdentity(memberId, input),
		getCodexIdentity: () => options.registry.getCodexIdentity(),
		putClaudeIdentity: (memberId, input) =>
			options.registry.putClaudeIdentity(memberId, input),
		getClaudeIdentity: () => options.registry.getClaudeIdentity(),
		putForgeIdentity: (memberId, input) =>
			options.registry.putForgeIdentity(memberId, input),
		getForgeIdentity: (memberId) => options.registry.getForgeIdentity(memberId),
		syncTeamData: (input) => options.registry.syncTeamData(input),
		listSessions: (workspaceId) => options.registry.listSessions(workspaceId),
		listSessionMessages: (sessionId) =>
			options.registry.listSessionMessages(sessionId),
		getGitSnapshot: (workspaceId) =>
			options.registry.getGitSnapshot(workspaceId),
		getWorkspaceDetail: (workspaceId) =>
			options.registry.getWorkspaceDetail(workspaceId),
	};
}

export function createLocalTeamProxy(options: LocalTeamProxyOptions): {
	fetch(request: Request): Promise<Response>;
} {
	const fetchCompanion = options.fetchCompanion ?? fetch;
	const gatewayStore = createLocalTeamGatewayStore(options);

	async function fetchHandler(request: Request): Promise<Response> {
		const origin = request.headers.get("Origin");
		if (request.method === "OPTIONS") {
			return withCors(new Response(null, { status: 204 }), origin);
		}

		let response: Response;
		try {
			response = await route(stripInboundMemberHeader(request));
		} catch (error) {
			response = json(
				{
					code: "Internal",
					message: error instanceof Error ? error.message : String(error),
				},
				500,
			);
		}
		return withCors(response, origin);
	}

	async function route(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname.startsWith("/team/")) {
			const response = await handleTeamGatewayRoute(request, url, gatewayStore);
			if (response) {
				// A successful in-app Claude (re)authorize must re-create the local
				// container so the freshly-stored token is injected as env (baked at
				// create time). Block until it's healthy so "Authorize" finishing
				// means cloud Claude is ready. The token is already persisted; a
				// recreate failure must not fail authorize.
				if (
					request.method === "PUT" &&
					response.ok &&
					url.pathname === "/team/claude-identity"
				) {
					try {
						await options.restartCompanion?.();
					} catch {
						// best-effort — the identity is persisted regardless
					}
				}
				return response;
			}
		}

		const requestBody = await readRequestBody(request);
		const cloneRepoName =
			url.pathname === "/rpc/clone_repository_from_url"
				? readCloneRepoName(requestBody)
				: null;
		const forwarded = await deriveGatewayForwardedRequest(request, {
			store: gatewayStore,
			companionToken: options.companionToken,
			body: requestBody,
		});
		if (forwarded instanceof Response) return forwarded;

		if (url.pathname === "/admin/restart-sandbox") {
			const authed =
				forwarded.headers.get("X-Helmor-Member-Id") !== null ||
				forwarded.headers.get("Authorization") ===
					`Bearer ${options.companionToken}`;
			if (!authed) return json({ code: "Unauthorized" }, 401);
			await options.restartCompanion?.();
			return json({
				ok: true,
				message:
					"local Docker companion restarted; the next request uses the same Team URL",
			});
		}

		// WP5: answer the model-catalog RPC from the registry cache (same
		// semantics as the Worker's D1 intercept — auth mirrors /admin/*, a miss
		// falls through to the companion and the live answer is written through).
		if (url.pathname === MODEL_CATALOG_RPC) {
			const authed =
				forwarded.headers.get("X-Helmor-Member-Id") !== null ||
				forwarded.headers.get("Authorization") ===
					`Bearer ${options.companionToken}`;
			if (!authed) return json({ code: "Unauthorized" }, 401);
			const cached = options.registry.getModelCatalog();
			if (cached !== null) return cachedCatalogResponse(cached);
		}

		const response = await proxyToCompanion(forwarded, fetchCompanion);
		if (url.pathname === "/rpc/clone_repository_from_url" && response.ok) {
			await mirrorCloneWorkspace(cloneRepoName, response.clone());
		}
		if (url.pathname === MODEL_CATALOG_RPC && response.ok) {
			const payload = parseModelCatalogPayload(await response.clone().text());
			if (payload) options.registry.setModelCatalog(payload);
		}
		return response;
	}

	async function proxyToCompanion(
		request: TeamGatewayForwardedRequest,
		fetchImpl: (request: Request) => Promise<Response>,
	): Promise<Response> {
		const sourceUrl = new URL(request.url);
		const target = new URL(
			`${sourceUrl.pathname}${sourceUrl.search}`,
			options.companionBaseUrl.replace(/\/+$/, ""),
		);
		const headers = new Headers(request.headers);
		headers.delete("Host");
		headers.delete("Connection");
		headers.delete("Content-Length");

		const method = request.method;
		const body =
			method === "GET" || method === "HEAD" ? undefined : request.body;
		const upstream = await fetchImpl(
			new Request(target, {
				method,
				headers,
				body,
			}),
		);
		const responseHeaders = new Headers(upstream.headers);
		responseHeaders.delete("Content-Length");
		return new Response(upstream.body, {
			status: upstream.status,
			statusText: upstream.statusText,
			headers: responseHeaders,
		});
	}

	async function mirrorCloneWorkspace(
		repoName: string | null,
		response: Response,
	): Promise<void> {
		let responseBody: Record<string, unknown>;
		try {
			responseBody = (await response.json()) as Record<string, unknown>;
		} catch {
			return;
		}
		const id =
			stringOrNull(responseBody.selectedWorkspaceId) ??
			stringOrNull(responseBody.repositoryId);
		if (!id) return;
		const name = repoName ?? stringOrNull(responseBody.name) ?? id;
		await options.registry.upsertWorkspace({ id, name });
	}

	return { fetch: fetchHandler };
}

function withCors(response: Response, origin: string | null): Response {
	const headers = new Headers(response.headers);
	const allowOrigin = origin ?? "*";
	headers.set("Access-Control-Allow-Origin", allowOrigin);
	headers.set(
		"Access-Control-Allow-Methods",
		"GET,POST,PUT,DELETE,PATCH,OPTIONS",
	);
	headers.set(
		"Access-Control-Allow-Headers",
		"Authorization, Content-Type, X-Helmor-Member-Id",
	);
	if (origin) {
		headers.set("Access-Control-Allow-Credentials", "true");
		headers.set("Vary", "Origin");
	}
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

async function readRequestBody(
	request: Request,
): Promise<ArrayBuffer | undefined> {
	if (request.method === "GET" || request.method === "HEAD") return undefined;
	try {
		return await request.arrayBuffer();
	} catch {
		return undefined;
	}
}

function readCloneRepoName(body: ArrayBuffer | undefined): string | null {
	if (!body) return null;
	try {
		const parsed = JSON.parse(new TextDecoder().decode(body)) as Record<
			string,
			unknown
		>;
		return inferRepoName(stringOrNull(parsed.gitUrl) ?? "");
	} catch {
		return null;
	}
}

function stringOrNull(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}
