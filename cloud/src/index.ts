// Helmor Team Cloud Sandbox — Worker control plane (Phase 0).
//
// A stateless thin proxy: no D1, no team modeling. It keeps one sandbox alive,
// launches `helmor serve` inside it as a managed subprocess, and transparently
// forwards every request (RPC, NDJSON `/rpc-stream`, SSE `/v1/stream`, SPA
// assets, WebSocket) to the in-container companion server. The companion does
// its own bearer-token auth, so the Worker just passes the client's
// `Authorization` header through. Blueprint: cloudflare/claude-managed-agents.

import { getSandbox, proxyToSandbox, type Sandbox } from "@cloudflare/sandbox";
import { handleTeamRoute, lookupMemberId } from "./team";

export { Sandbox } from "@cloudflare/sandbox";

export interface Env {
	Sandbox: DurableObjectNamespace<Sandbox>;
	/** Team registry: members / invites / teams / workspaces mirror (Phase 3). */
	DB: D1Database;
	/** Fixed sandbox id for Phase 0 (one team → one sandbox). */
	HELMOR_SANDBOX_ID: string;
	/** Companion port inside the container (matches HELMOR_SERVE_PORT). */
	HELMOR_COMPANION_PORT: string;
	/** Capability token the serve host accepts (secret). */
	HELMOR_COMPANION_TOKEN: string;
	/** PAT for PR6 clone / push, injected into the serve process env (secret). */
	GITHUB_TOKEN?: string;
	/** Cloud run identity: ChatGPT auth.json (the user's subscription), written to
	 *  the container's ~/.codex/auth.json so the agent authenticates as that
	 *  subscription. Phase-0 passes the whole credential through; Phase-1 will have
	 *  the control-plane broker mint a per-turn short-lived token instead. */
	CODEX_AUTH_JSON?: string;
}

/** Boot script staged in the image (Xvfb daemon → readiness → `helmor serve`). */
const SERVE_START_CMD = "/usr/local/bin/helmor-start-serve";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		// Preview-URL passthrough (port-subdomain hostnames). Returns null for
		// the Worker's own hostname, which we proxy transparently below.
		const proxied = await proxyToSandbox(request, env);
		if (proxied) return proxied;

		// Team registry (`/team/*`): D1-backed JSON routes. Returns null for any
		// other path, which falls through to the container proxy below.
		const url = new URL(request.url);
		const teamResp = await handleTeamRoute(request, env, url);
		if (teamResp) return teamResp;

		// Derive the member identity for the proxied hop. On a bad token this
		// short-circuits with 401 (we must not proxy an unknown caller).
		const forwarded = await deriveForwardedRequest(request, env);
		if (forwarded instanceof Response) return forwarded;

		const port = Number(env.HELMOR_COMPANION_PORT ?? "8080");
		const sandbox = getSandbox(
			env.Sandbox,
			env.HELMOR_SANDBOX_ID ?? "helmor-team-0",
		);

		try {
			await ensureServe(sandbox, env, port);
		} catch (error) {
			return new Response(
				JSON.stringify({
					code: "Unavailable",
					message: `serve host not ready: ${(error as Error).message}`,
				}),
				{ status: 503, headers: { "content-type": "application/json" } },
			);
		}

		// WebSocket upgrades (future-proofs the streaming transport).
		if (forwarded.headers.get("Upgrade")?.toLowerCase() === "websocket") {
			return sandbox.wsConnect(forwarded, port);
		}

		// Transparent HTTP proxy: method, path, body, and streaming responses
		// pass straight through; headers carry the derived member id + shared
		// companion token (see `deriveForwardedRequest`).
		return sandbox.containerFetch(forwarded, port);
	},
};

/**
 * Build the request forwarded to the companion, deriving member identity from
 * the client's bearer (the invite token doubles as the member's capability
 * token). Returns a 401 Response if the token is unknown.
 *
 * Security: the client-supplied `X-Helmor-Member-Id` is ALWAYS stripped, and
 * the bearer is swapped to the shared `HELMOR_COMPANION_TOKEN` for the
 * companion hop (the companion stamps the derived id onto the persisted
 * message as `author_id`). Admin/local callers (shared token) carry no member.
 */
async function deriveForwardedRequest(
	request: Request,
	env: Env,
): Promise<Request | Response> {
	const bearer = readBearer(request);
	let memberId: string | null = null;
	if (bearer && bearer !== env.HELMOR_COMPANION_TOKEN) {
		memberId = await lookupMemberId(env, bearer);
		if (!memberId) {
			return new Response(JSON.stringify({ code: "Unauthorized" }), {
				status: 401,
				headers: { "content-type": "application/json" },
			});
		}
	}

	const forwarded = new Request(request, {
		headers: new Headers(request.headers),
	});
	forwarded.headers.delete("X-Helmor-Member-Id"); // never client-asserted
	if (memberId) forwarded.headers.set("X-Helmor-Member-Id", memberId);
	forwarded.headers.set(
		"Authorization",
		`Bearer ${env.HELMOR_COMPANION_TOKEN}`,
	);
	return forwarded;
}

/** Read the `Authorization: Bearer <token>` value, or null if absent. */
function readBearer(request: Request): string | null {
	const header = request.headers.get("Authorization");
	if (!header) return null;
	const match = /^Bearer\s+(.+)$/i.exec(header);
	return match ? match[1] : null;
}

/** Ensure the companion server is up. Fast-path on a health hit; otherwise
 *  launch the boot script and poll until it answers (Xvfb + serve cold start). */
async function ensureServe(
	sandbox: Sandbox,
	env: Env,
	port: number,
): Promise<void> {
	if (await healthOk(sandbox, port)) return;

	await sandbox.startProcess(SERVE_START_CMD, {
		env: {
			HELMOR_COMPANION_TOKEN: env.HELMOR_COMPANION_TOKEN,
			HELMOR_SERVE_PORT: String(port),
			...(env.GITHUB_TOKEN ? { GITHUB_TOKEN: env.GITHUB_TOKEN } : {}),
			...(env.CODEX_AUTH_JSON ? { CODEX_AUTH_JSON: env.CODEX_AUTH_JSON } : {}),
		},
	});

	// Cold start: Xvfb + GTK/WebKit init + companion bind. Poll up to ~120s
	// (WebKitGTK init is heavy on a fresh container's first boot).
	for (let attempt = 0; attempt < 240; attempt++) {
		if (await healthOk(sandbox, port)) return;
		await sleep(500);
	}
	throw new Error("companion /v1/health did not respond in time");
}

async function healthOk(sandbox: Sandbox, port: number): Promise<boolean> {
	try {
		const res = await sandbox.containerFetch(
			new Request(`http://localhost:${port}/v1/health`),
			port,
		);
		return res.ok;
	} catch {
		return false;
	}
}
