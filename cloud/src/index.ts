// Helmor Team Cloud Sandbox — Worker control plane (Phase 0).
//
// A stateless thin proxy: no D1, no team modeling. It keeps one sandbox alive,
// launches `helmor serve` inside it as a managed subprocess, and transparently
// forwards every request (RPC, NDJSON `/rpc-stream`, SSE `/v1/stream`, SPA
// assets, WebSocket) to the in-container companion server. The companion does
// its own bearer-token auth, so the Worker just passes the client's
// `Authorization` header through. Blueprint: cloudflare/claude-managed-agents.

import { getSandbox, proxyToSandbox, type Sandbox } from "@cloudflare/sandbox";

export { Sandbox } from "@cloudflare/sandbox";

interface Env {
	Sandbox: DurableObjectNamespace<Sandbox>;
	/** Fixed sandbox id for Phase 0 (one team → one sandbox). */
	HELMOR_SANDBOX_ID: string;
	/** Companion port inside the container (matches HELMOR_SERVE_PORT). */
	HELMOR_COMPANION_PORT: string;
	/** Capability token the serve host accepts (secret). */
	HELMOR_COMPANION_TOKEN: string;
	/** PAT for PR6 clone / push, injected into the serve process env (secret). */
	GITHUB_TOKEN?: string;
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
		if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
			return sandbox.wsConnect(request, port);
		}

		// Transparent HTTP proxy: method, path, headers (incl. the bearer
		// token), body, and streaming responses pass straight through.
		return sandbox.containerFetch(request, port);
	},
};

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
