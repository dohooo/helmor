// Helmor Team Cloud Sandbox — Worker control plane (Phase 0).
//
// A stateless thin proxy: no D1, no team modeling. It keeps one sandbox alive,
// launches `helmor serve` inside it as a managed subprocess, and transparently
// forwards every request (RPC, NDJSON `/rpc-stream`, SSE `/v1/stream`, SPA
// assets, WebSocket) to the in-container companion server. The companion does
// its own bearer-token auth, so the Worker just passes the client's
// `Authorization` header through. Blueprint: cloudflare/claude-managed-agents.

import { getSandbox, proxyToSandbox, type Sandbox } from "@cloudflare/sandbox";
import {
	handleTeamRoute,
	lookupMemberId,
	readBackupHandle,
	writeBackupHandle,
} from "./team";

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
	/** R2 bucket for Sandbox backups (Phase 2b). Bound so the Sandbox DO can
	 *  resolve BACKUP_BUCKET for localBucket-mode createBackup/restoreBackup. */
	BACKUP_BUCKET?: R2Bucket;
}

/** Boot script staged in the image (Xvfb daemon → readiness → `helmor serve`). */
const SERVE_START_CMD = "/usr/local/bin/helmor-start-serve";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Agent-stream RPC path. After this stream closes, the in-container WAL
 *  checkpoint (gated by HELMOR_CLOUD_AUTOPUSH) has already folded helmor.db, so
 *  a backup taken now snapshots a consistent DB. */
const AGENT_STREAM_PATH = "/rpc-stream/send_agent_message_stream";

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		// Security (EVERY path): strip any client-supplied X-Helmor-Member-Id up
		// front — before proxyToSandbox — so the "never client-asserted" invariant
		// holds on the SDK preview path too, not only the derived proxy hop. The
		// companion trusts this header as author_id, so a client must never set it.
		const req = request.headers.has("X-Helmor-Member-Id")
			? new Request(request, { headers: withoutMemberHeader(request.headers) })
			: request;

		// Preview-URL passthrough (port-subdomain hostnames). Returns null for
		// the Worker's own hostname, which we proxy transparently below.
		const proxied = await proxyToSandbox(req, env);
		if (proxied) return proxied;

		// Team registry (`/team/*`): D1-backed JSON routes. Returns null for any
		// other path, which falls through to the container proxy below.
		const url = new URL(req.url);
		const teamResp = await handleTeamRoute(req, env, url);
		if (teamResp) return teamResp;

		// Derive the member identity + companion-token swap for the proxied hop.
		// Unauthenticated calls pass through unswapped (the companion gates them:
		// /rpc -> 401, /v1/health stays public); unknown tokens -> 401 (see fn).
		const forwarded = await deriveForwardedRequest(req, env);
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
		const response = await sandbox.containerFetch(forwarded, port);

		// Phase 2b sleep persistence: ONLY for the agent-stream path, snapshot
		// /home/helmor to R2 after the turn so the session survives sandbox
		// sleep. We don't block the client — `waitUntil` keeps the Worker alive
		// past the response while the backup runs. The backup must start AFTER
		// the stream drains (the in-container WAL checkpoint runs just before the
		// terminal `done`), so we tee the body and await the clone's completion
		// before snapshotting. All other paths return byte-unchanged.
		if (url.pathname === AGENT_STREAM_PATH && response.body) {
			const [toClient, toDrain] = response.body.tee();
			ctx.waitUntil(backupAfterStream(toDrain, sandbox, env));
			return new Response(toClient, response);
		}

		return response;
	},
};

/**
 * Wait for the agent-stream body to fully drain (so the in-container WAL
 * checkpoint + autopush that fire just before the terminal `done` have run),
 * then snapshot the data dir to R2 and persist the handle. Best-effort: a
 * backup failure must never surface to the client (the response already left).
 */
async function backupAfterStream(
	body: ReadableStream<Uint8Array>,
	sandbox: Sandbox,
	env: Env,
): Promise<void> {
	try {
		// Drain to EOF — resolves when the companion closes the stream, i.e.
		// after the turn finalized (checkpoint folded helmor.db).
		await body.pipeTo(new WritableStream());
	} catch {
		// A client disconnect can abort the tee; still attempt the backup with
		// whatever is on disk — a slightly-stale snapshot beats none.
	}
	await backupAndStore(sandbox, env);
}

/**
 * Snapshot `/home/helmor` (the relocated data dir) to R2 in localBucket mode
 * and persist the returned handle in D1. Excludes the bulky, regenerable trees
 * (workspaces are pushed to git by autopush; cache/logs/run/local-llm are
 * disposable) so the backup is just the SQLite DB + small settings. All errors
 * are logged and swallowed — cold-starting with an empty DB is acceptable.
 */
async function backupAndStore(sandbox: Sandbox, env: Env): Promise<void> {
	try {
		const handle = await sandbox.createBackup({
			dir: "/home/helmor",
			localBucket: true,
			name: `helmor-${new Date().toISOString()}`,
			ttl: 259200, // 3 days
			excludes: ["workspaces", "cache", "logs", "run", "local-llm"],
		});
		await writeBackupHandle(env, handle);
	} catch (error) {
		console.error("Phase 2b backup failed", error);
	}
}

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
	// Only swap in the shared companion token for an AUTHENTICATED caller — admin
	// (shared token) or a member (valid invite token). An UNauthenticated caller
	// must NOT receive the shared token (that would bypass the companion's own
	// bearer auth); pass it through unswapped so the companion gates it
	// (/rpc -> 401, /v1/health stays public). An unknown token -> 401 here.
	let injectCompanionToken = false;
	if (bearer === env.HELMOR_COMPANION_TOKEN) {
		injectCompanionToken = true; // admin / local (no member id)
	} else if (bearer) {
		memberId = await lookupMemberId(env, bearer);
		if (!memberId) {
			return new Response(JSON.stringify({ code: "Unauthorized" }), {
				status: 401,
				headers: { "content-type": "application/json" },
			});
		}
		injectCompanionToken = true; // member: invite token -> shared token
	}

	const forwarded = new Request(request, {
		headers: new Headers(request.headers),
	});
	forwarded.headers.delete("X-Helmor-Member-Id"); // never client-asserted
	if (memberId) forwarded.headers.set("X-Helmor-Member-Id", memberId);
	if (injectCompanionToken) {
		forwarded.headers.set(
			"Authorization",
			`Bearer ${env.HELMOR_COMPANION_TOKEN}`,
		);
	}
	return forwarded;
}

/** Read the `Authorization: Bearer <token>` value, or null if absent. */
function readBearer(request: Request): string | null {
	const header = request.headers.get("Authorization");
	if (!header) return null;
	const match = /^Bearer\s+(.+)$/i.exec(header);
	return match ? match[1] : null;
}

/** Clone request headers with the trusted member-id header removed. */
function withoutMemberHeader(headers: Headers): Headers {
	const next = new Headers(headers);
	next.delete("X-Helmor-Member-Id");
	return next;
}

/** Ensure the companion server is up. Fast-path on a health hit; otherwise
 *  launch the boot script and poll until it answers (Xvfb + serve cold start). */
async function ensureServe(
	sandbox: Sandbox,
	env: Env,
	port: number,
): Promise<void> {
	if (await healthOk(sandbox, port)) return;

	// Phase 2b sleep persistence: restore the last DB snapshot BEFORE serve
	// binds. Restore must precede serve (serve not yet running = no open handle
	// on helmor.db, safe to overwrite). A missing/failed restore is non-fatal —
	// the container cold-starts with an empty DB, exactly like a brand-new team.
	try {
		const handle = await readBackupHandle(env);
		if (handle) await sandbox.restoreBackup(handle);
	} catch (error) {
		console.error("Phase 2b restore failed (cold-starting empty)", error);
	}

	await sandbox.startProcess(SERVE_START_CMD, {
		env: {
			HELMOR_COMPANION_TOKEN: env.HELMOR_COMPANION_TOKEN,
			HELMOR_SERVE_PORT: String(port),
			// Phase 2b: relocate the data dir under /home so it lands in the
			// backed-up /home/helmor tree (createBackup dir must be under
			// /workspace|/home|/tmp|/var/tmp|/app).
			HELMOR_DATA_DIR: "/home/helmor",
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
