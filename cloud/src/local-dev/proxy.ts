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
	publicBaseUrl: string;
	sandboxId?: string;
}

export function createLocalTeamGatewayStore(
	options: LocalTeamGatewayStoreOptions,
): TeamGatewayStore {
	const sandboxId = options.sandboxId ?? "local-docker";
	return {
		classifyBearer: (token) =>
			options.registry.classify(token, options.adminToken),
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
			if (response) return response;
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

		const response = await proxyToCompanion(forwarded, fetchCompanion);
		if (url.pathname === "/rpc/clone_repository_from_url" && response.ok) {
			await mirrorCloneWorkspace(cloneRepoName, response.clone());
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
