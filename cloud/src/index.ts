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
	readCloudIdentityMemberId,
	writeBackupHandle,
} from "./team";

export { Sandbox } from "@cloudflare/sandbox";
// Re-export so workerd registers the Durable Object class named in
// wrangler.toml's `CODEX_IDENTITY` binding (Phase 1 Codex token broker).
export { CodexIdentity } from "./codex-identity";

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
	/** Cloud run identity broker (Phase 1): per-member Durable Object that holds
	 *  the ChatGPT subscription refresh_token encrypted at rest and mints the
	 *  short-lived, empty-RT ChatgptAuthTokens auth.json injected at cold start.
	 *  REPLACES the Phase-0 static `CODEX_AUTH_JSON` secret — the container's
	 *  auth.json is now computed per cold start from `mintAuthJson()`, never a
	 *  static binding that would replay a stale token on wake (design §3.3). */
	CODEX_IDENTITY: DurableObjectNamespace<
		import("./codex-identity").CodexIdentity
	>;
	/** Base64-encoded 32-byte AES-256-GCM key the `CodexIdentity` DO derives its
	 *  at-rest encryption key from (Worker secret). NEVER enters the container,
	 *  D1, or the frontend. */
	BROKER_ENC_KEY: string;
	/** Override the OAuth token endpoint the broker refreshes against (tests /
	 *  spike). Falls back to the hard-coded OpenAI endpoint inside the DO. */
	CODEX_REFRESH_TOKEN_URL_OVERRIDE?: string;
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

/** CORS for the desktop team-mode webview, which calls this Worker over browser
 *  `fetch` from a cross-origin context (http://localhost:1420 in dev,
 *  tauri://localhost in a release build). team-api `fetch` is CORS-gated, so
 *  without reflecting the caller's Origin + answering the OPTIONS preflight every
 *  team-mode request fails as a "network" error (TypeError: Load failed). The
 *  bearer (Authorization header, not a cookie) is the real gate; reflecting the
 *  Origin just lets the webview READ the response. */
function corsHeaders(origin: string): Record<string, string> {
	return {
		"Access-Control-Allow-Origin": origin,
		"Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,PATCH,OPTIONS",
		"Access-Control-Allow-Headers":
			"Authorization, Content-Type, X-Helmor-Member-Id",
		"Access-Control-Allow-Credentials": "true",
		"Access-Control-Max-Age": "86400",
		Vary: "Origin",
	};
}

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		const origin = request.headers.get("Origin");
		// Answer the CORS preflight before any auth/proxy work — the webview's
		// preflighted POST/PUT (Authorization + JSON body) must clear first.
		if (request.method === "OPTIONS" && origin) {
			return new Response(null, { status: 204, headers: corsHeaders(origin) });
		}
		let response: Response;
		try {
			response = await route(request, env, ctx);
		} catch (error) {
			// A throw from route() would otherwise produce the runtime's bare 500
			// OUTSIDE the CORS block below, which the cross-origin webview reads as
			// an opaque "network error". Convert it to a CORS-able JSON 500 so the
			// real message reaches the client.
			response = new Response(
				JSON.stringify({
					code: "Internal",
					message: `worker error: ${(error as Error).message}`,
				}),
				{ status: 500, headers: { "content-type": "application/json" } },
			);
		}
		// Reflect CORS on the real response so the webview can read it. Skip
		// WebSocket upgrades (status 101 / `.webSocket`): CORS doesn't apply to the
		// handshake and re-wrapping would drop the socket.
		if (
			origin &&
			response.status !== 101 &&
			!(response as { webSocket?: unknown }).webSocket
		) {
			const headers = new Headers(response.headers);
			for (const [key, value] of Object.entries(corsHeaders(origin))) {
				headers.set(key, value);
			}
			return new Response(response.body, {
				status: response.status,
				statusText: response.statusText,
				headers,
			});
		}
		return response;
	},
};

/** The request handler proper. `fetch` (above) wraps this with CORS. */
async function route(
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

	// Team-mode "add repository" (BUG-3): the serve subprocess cannot write the
	// persistent volume, so the Worker clones via the Sandbox SDK into /workspace
	// then registers through serve. A plain proxy would EROFS in the container.
	if (url.pathname === "/rpc/clone_repository_from_url") {
		return handleTeamClone(forwarded, sandbox, port);
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
}

/**
 * Derive the repo folder name from a clone URL, mirroring the Rust
 * `infer_repo_name_from_url` so a cloud clone lands at the same name a local
 * clone would (`…/foo.git` → `foo`). Returns null when none can be derived.
 */
function inferRepoName(url: string): string | null {
	const trimmed = url.trim().replace(/[/\\]+$/, "");
	const withoutGit = trimmed.endsWith(".git")
		? trimmed.slice(0, -".git".length)
		: trimmed;
	const segments = withoutGit.split(/[/\\:]/);
	const last = (segments[segments.length - 1] ?? "").trim();
	return last.length > 0 ? last : null;
}

/**
 * Team-mode "add repository" (BUG-3). A plain `git clone` inside the container
 * fails: the serve subprocess sees /workspace as EROFS (only the Sandbox SDK can
 * write the persistent volume) and /home as ENOTSUP. So the Worker performs the
 * clone via `sandbox.gitCheckout` into the persistent /workspace, then forwards
 * the existing `add_repository_from_local_path` RPC to serve to register the
 * now-on-disk repo in the container DB. The serve response (an
 * `AddRepositoryResponse`) is returned verbatim — the frontend sees the same
 * shape it gets from a local clone, so no client change is needed.
 */
async function handleTeamClone(
	forwarded: Request,
	sandbox: Sandbox,
	port: number,
): Promise<Response> {
	const jsonError = (status: number, message: string) =>
		new Response(
			JSON.stringify({
				code: status === 400 ? "InvalidArgument" : "Internal",
				message,
			}),
			{ status, headers: { "content-type": "application/json" } },
		);

	let body: { gitUrl?: unknown; cloneDirectory?: unknown };
	try {
		body = (await forwarded.clone().json()) as typeof body;
	} catch {
		return jsonError(400, "clone: malformed request body");
	}

	const gitUrl = typeof body.gitUrl === "string" ? body.gitUrl.trim() : "";
	if (!gitUrl) return jsonError(400, "clone: missing gitUrl");

	const name = inferRepoName(gitUrl);
	if (
		!name ||
		name === "." ||
		name === ".." ||
		!/^[A-Za-z0-9._-]+$/.test(name)
	) {
		return jsonError(
			400,
			`clone: cannot derive a safe repo name from "${gitUrl}"`,
		);
	}

	// The persistent volume is always /workspace; never honor a caller path that
	// would escape it. targetDir mirrors a local clone: <root>/<name>.
	const requested =
		typeof body.cloneDirectory === "string" ? body.cloneDirectory.trim() : "";
	const root = requested.startsWith("/workspace")
		? requested.replace(/\/+$/, "")
		: "/workspace";
	const targetDir = `${root}/${name}`;

	// 1. Clone onto the persistent volume via the SDK (serve cannot write it).
	//    The SDK THROWS on a failed clone (it does not return success:false), so
	//    catch it — an uncaught throw escapes as a bare CORS-less 500 and the
	//    webview only sees an opaque "network error". The likely cases are a
	//    private/unreachable URL and a re-add where targetDir already exists.
	try {
		const checkout = await sandbox.gitCheckout(gitUrl, {
			targetDir,
			cloneTimeoutMs: 120_000,
		});
		if (!checkout.success) {
			return jsonError(
				502,
				`git clone failed (exit ${checkout.exitCode ?? "?"}) for "${gitUrl}" → ${targetDir}.`,
			);
		}
	} catch (error) {
		return jsonError(
			502,
			`git clone failed for "${gitUrl}" → ${targetDir}: ${(error as Error).message}. ` +
				"The path may already exist, or the URL is private/unreachable.",
		);
	}

	// 2. Register the now-on-disk repo via the EXISTING companion RPC, which owns
	//    the container DB. Reuse the derived member auth from `forwarded`; build
	//    fresh headers so a stale content-length can't corrupt the new body.
	const headers = new Headers({ "content-type": "application/json" });
	const auth = forwarded.headers.get("Authorization");
	if (auth) headers.set("Authorization", auth);
	const memberId = forwarded.headers.get("X-Helmor-Member-Id");
	if (memberId) headers.set("X-Helmor-Member-Id", memberId);

	const origin = new URL(forwarded.url).origin;
	const registerReq = new Request(
		`${origin}/rpc/add_repository_from_local_path`,
		{
			method: "POST",
			headers,
			body: JSON.stringify({ folderPath: targetDir }),
		},
	);
	const registerRes = await sandbox.containerFetch(registerReq, port);
	if (!registerRes.ok) {
		// The clone landed but registration failed (transient serve error).
		// Leaving the dir behind wedges a retry on the "already exists" clone
		// error (the local Rust path cleans up on failure for the same reason),
		// so remove it best-effort. targetDir is sanitized (/workspace/<safe-name>).
		try {
			await sandbox.exec(`rm -rf '${targetDir}'`);
		} catch {
			// best-effort — surface the original register error regardless
		}
	}
	return registerRes;
}

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

	// Phase 1 Codex token broker: mint a fresh, short-lived ChatgptAuthTokens
	// auth.json from the team's identity DO and inject it as CODEX_AUTH_JSON for
	// THIS cold start (design §3.3). Computed per startProcess — never a static
	// binding — so a sandbox wake never replays a stale token. A missing
	// identity or a brick/refresh failure starts serve WITHOUT Codex auth (the
	// container runs un-authenticated for Codex until the user re-authorizes);
	// we log only a NON-SENSITIVE marker, never the auth.json or any token.
	const codexAuthJson = await mintCodexAuthJson(env);

	await sandbox.startProcess(SERVE_START_CMD, {
		env: {
			HELMOR_COMPANION_TOKEN: env.HELMOR_COMPANION_TOKEN,
			HELMOR_SERVE_PORT: String(port),
			// Phase 2b: relocate the data dir under /home so it lands in the
			// backed-up /home/helmor tree (createBackup dir must be under
			// /workspace|/home|/tmp|/var/tmp|/app).
			HELMOR_DATA_DIR: "/home/helmor",
			...(env.GITHUB_TOKEN ? { GITHUB_TOKEN: env.GITHUB_TOKEN } : {}),
			...(codexAuthJson ? { CODEX_AUTH_JSON: codexAuthJson } : {}),
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

/**
 * Mint the container's Codex auth.json from the team's identity DO at cold
 * start (Phase 1 broker, design §3.3). Resolves the team's bound
 * `cloud_identity_member_id`, gets that member's `CodexIdentity` DO, and calls
 * `mintAuthJson()` (Workers RPC). Returns the serialized ChatgptAuthTokens
 * auth.json (empty RT) to inject, or `null` to start serve WITHOUT Codex auth.
 *
 * SECURITY: only ever logs a NON-SENSITIVE marker — never the auth.json, the
 * minted access_token, or any token material. A `{ error }` result (no
 * identity / bricked / refresh failed) is a clean skip; cloud Codex runs fail
 * until the user re-authorizes (Phase 5 reconnect semantics).
 */
async function mintCodexAuthJson(env: Env): Promise<string | null> {
	const memberId = await readCloudIdentityMemberId(env);
	if (!memberId) return null; // No cloud identity configured for this team.

	try {
		const stub = env.CODEX_IDENTITY.get(
			env.CODEX_IDENTITY.idFromName(memberId),
		);
		const mint = await stub.mintAuthJson();
		if ("authJson" in mint) {
			return JSON.stringify(mint.authJson);
		}
		// Non-sensitive marker only (the `error` discriminant, never a value).
		console.error(`Phase 1 codex mint skipped: ${mint.error}`);
		return null;
	} catch (error) {
		console.error(
			"Phase 1 codex mint failed",
			error instanceof Error ? error.message : "unknown",
		);
		return null;
	}
}
