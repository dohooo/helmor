// Helmor Team Cloud Sandbox — Worker control plane (Phase 0).
//
// A stateless thin proxy: no D1, no team modeling. It keeps one sandbox alive,
// launches `helmor serve` inside it as a managed subprocess, and transparently
// forwards every request (RPC, NDJSON `/rpc-stream`, SSE `/v1/stream`, SPA
// assets, WebSocket) to the in-container companion server. The companion does
// its own bearer-token auth, so the Worker just passes the client's
// `Authorization` header through. Blueprint: cloudflare/claude-managed-agents.

import {
	Sandbox as CloudflareSandbox,
	getSandbox,
	proxyToSandbox,
} from "@cloudflare/sandbox";
import { parseGlabTokens } from "./forge-config";
import {
	createWorkerTeamGatewayStore,
	handleTeamRoute,
	readBackupHandle,
	readCloudIdentityMemberId,
	TEAM_ID,
	writeBackupHandle,
} from "./team";
import {
	deriveGatewayHeaders,
	inferRepoName,
	stripInboundMemberHeader,
} from "./team-gateway/core";

export class Sandbox extends CloudflareSandbox<Env> {
	// Stored explicitly (typed as our Env) for the idle-sleep backup; the base's
	// generic env field would otherwise need a cast.
	private readonly helmorEnv: Env;

	constructor(ctx: DurableObjectState<Record<never, never>>, env: Env) {
		super(ctx, env);
		this.helmorEnv = env;
		// Idle auto-sleep so an unused team sandbox stops billing. The container
		// stops after this much inactivity (no open companion connection / no
		// in-flight requests); the next request cold-starts via `ensureServe`,
		// restoring from the last backup. The base reads `this.sleepAfter` AFTER
		// this constructor runs (it defers via blockConcurrencyWhile).
		this.sleepAfter = env.SANDBOX_IDLE_TIMEOUT ?? "15m";
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const match = url.pathname.match(/^\/__helmor-companion\/(\d+)(\/.*)?$/);
		if (!match) {
			return super.fetch(request);
		}

		const port = Number(match[1]);
		if (!Number.isFinite(port) || port <= 0 || port > 65_535) {
			return new Response("Invalid companion port", { status: 400 });
		}
		const upstreamPath = match[2] || "/";
		const upstreamUrl = `http://localhost:${port}${upstreamPath}${url.search}`;
		return this.fetchCompanionPort(new Request(upstreamUrl, request), port);
	}

	private async fetchCompanionPort(
		request: Request,
		port: number,
	): Promise<Response> {
		const internals = this as unknown as {
			container?: {
				running: boolean;
				getTcpPort: (port: number) => {
					fetch: (url: string, request: Request) => Promise<Response>;
				};
			};
			inflightRequests?: number;
			renewActivityTimeout?: () => void;
			decrementInflight?: () => void;
		};
		if (!internals.container?.running) {
			return new Response("Container is not running", { status: 503 });
		}

		const tcpPort = internals.container.getTcpPort(port);
		const target = request.url.replace("https:", "http:");

		internals.inflightRequests = (internals.inflightRequests ?? 0) + 1;
		internals.renewActivityTimeout?.();
		let released = false;
		const release = () => {
			if (released) return;
			released = true;
			internals.decrementInflight?.();
		};
		try {
			const response = await tcpPort.fetch(target, request);
			if (!response.body) {
				release();
				return response;
			}
			// Stay "busy" (inflightRequests > 0) until the response body closes,
			// not just until the headers arrive. For a long-lived `/v1/stream`
			// SSE this keeps the sandbox awake for the whole connection, so an
			// open desktop blocks the idle-sleep alarm; the moment the client
			// disconnects (body cancels) it drops to idle and `sleepAfter` starts.
			// Non-streaming bodies close immediately, so they release right away.
			const reader = response.body.getReader();
			const monitored = new ReadableStream<Uint8Array>({
				async pull(controller) {
					try {
						const { done, value } = await reader.read();
						if (done) {
							release();
							controller.close();
							return;
						}
						controller.enqueue(value);
					} catch (error) {
						release();
						controller.error(error);
					}
				},
				cancel(reason) {
					release();
					void reader.cancel(reason);
				},
			});
			return new Response(monitored, response);
		} catch (error) {
			release();
			throw error;
		}
	}

	/** Snapshot the session right before the idle timeout sleeps the container,
	 *  then let the base stop it. Best-effort — a backup failure must not block
	 *  sleep (cold start just restores the prior post-turn snapshot). */
	async onActivityExpired(): Promise<void> {
		await this.backupBeforeSleep();
		await super.onActivityExpired();
	}

	private async backupBeforeSleep(): Promise<void> {
		try {
			const handle = await this.createBackup({
				dir: "/home/helmor",
				localBucket: true,
				name: `helmor-idle-${new Date().toISOString()}`,
				ttl: 259200, // 3 days
				excludes: ["workspaces", "cache", "logs", "run", "local-llm"],
			});
			await writeBackupHandle(this.helmorEnv, handle);
		} catch (error) {
			console.error("idle-sleep backup failed", error);
		}
	}
}
// Likewise for the `CLAUDE_IDENTITY` binding (Claude subscription token broker).
export { ClaudeIdentity } from "./claude-identity";
// Re-export so workerd registers the Durable Object class named in
// wrangler.toml's `CODEX_IDENTITY` binding (Phase 1 Codex token broker).
export { CodexIdentity } from "./codex-identity";
export { ForgeIdentity } from "./forge-identity";

export interface Env {
	Sandbox: DurableObjectNamespace<CloudflareSandbox>;
	/** Team registry: members / invites / teams / workspaces mirror (Phase 3). */
	DB: D1Database;
	/** Fixed sandbox id for Phase 0 (one team → one sandbox). */
	HELMOR_SANDBOX_ID: string;
	/** Companion port inside the container (matches HELMOR_SERVE_PORT). */
	HELMOR_COMPANION_PORT: string;
	/** Idle auto-sleep threshold for the Sandbox DO (e.g. "15m", "1h", or
	 *  seconds). After this much inactivity the container stops; the next request
	 *  cold-starts it. Defaults to "15m" when unset. */
	SANDBOX_IDLE_TIMEOUT?: string;
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
	/** Claude subscription token broker: per-member Durable Object that holds the
	 *  Claude `setup-token` OAuth token (`sk-ant-oat01…`) encrypted at rest and
	 *  hands it back at cold start to inject as the `CLAUDE_CODE_OAUTH_TOKEN` env
	 *  var. Unlike Codex, the token is self-contained (~1-year, inference-only):
	 *  inject-and-forget, no in-DO refresh. */
	CLAUDE_IDENTITY: DurableObjectNamespace<
		import("./claude-identity").ClaudeIdentity
	>;
	/** Per-member forge credential broker: each member's `ForgeIdentity` DO holds
	 *  their gh token / glab config encrypted at rest. TRUE per-member — the
	 *  container injects ALL members' creds at cold start and the forge layer
	 *  selects by the acting member (no single team-bound identity). */
	FORGE_IDENTITY: DurableObjectNamespace<
		import("./forge-identity").ForgeIdentity
	>;
	/** Base64-encoded 32-byte AES-256-GCM key the `CodexIdentity` AND
	 *  `ClaudeIdentity` DOs derive their at-rest encryption key from (Worker
	 *  secret, SHARED). NEVER enters the container, D1, or the frontend. */
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
const HEALTH_CHECK_TIMEOUT_MS = 1_500;
const RESTORE_BACKUP_TIMEOUT_MS = 15_000;
const START_PROCESS_TIMEOUT_MS = 90_000;
const IDENTITY_MINT_TIMEOUT_MS = 15_000;
const SERVE_READY_TIMEOUT_MS = 180_000;
const SERVE_POLL_INTERVAL_MS = 500;

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
	const req = stripInboundMemberHeader(request);

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

	// Admin/member op: restart the sandbox so the NEXT request cold-starts and
	// re-mints the Codex auth.json — needed to apply a re-authorization or a
	// broker change without waiting for an idle sleep. `stop()` is graceful;
	// /workspace persists and the DB restores from R2 on the next cold start.
	// Gated to an authenticated member (X-Helmor-Member-Id, set by
	// deriveForwardedRequest) or the admin token.
	if (url.pathname === "/admin/restart-sandbox") {
		const authed =
			forwarded.headers.get("X-Helmor-Member-Id") !== null ||
			forwarded.headers.get("Authorization") ===
				`Bearer ${env.HELMOR_COMPANION_TOKEN}`;
		if (!authed) {
			return new Response(
				JSON.stringify({
					code: "Unauthorized",
					message: "member or admin token required",
				}),
				{ status: 401, headers: { "content-type": "application/json" } },
			);
		}
		await sandbox.stop();
		return new Response(
			JSON.stringify({
				ok: true,
				message: "sandbox stopped; the next request cold-starts and re-mints",
			}),
			{ headers: { "content-type": "application/json" } },
		);
	}

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
		return handleTeamClone(forwarded, sandbox, port, env);
	}

	// WebSocket upgrades (future-proofs the streaming transport).
	if (forwarded.headers.get("Upgrade")?.toLowerCase() === "websocket") {
		return sandbox.wsConnect(forwarded, port);
	}

	// Transparent HTTP proxy: method, path, body, and streaming responses
	// pass straight through; headers carry the derived member id + shared
	// companion token (see `deriveForwardedRequest`).
	const response = await containerFetchThroughPort(sandbox, forwarded, port);

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
 * Team-mode "add repository" (BUG-3). A plain `git clone` inside the container
 * fails: the serve subprocess sees /workspace as EROFS (only the Sandbox SDK can
 * write the persistent volume) and /home as ENOTSUP. So the Worker performs the
 * clone via `sandbox.gitCheckout` into the persistent /workspace, then forwards
 * the existing `add_repository_from_local_path` RPC to serve to register the
 * now-on-disk repo in the container DB. The serve response (an
 * `AddRepositoryResponse`) is returned verbatim — the frontend sees the same
 * shape it gets from a local clone, so no client change is needed.
 */
export async function handleTeamClone(
	forwarded: Request,
	sandbox: CloudflareSandbox,
	port: number,
	env: Env,
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
	// True per-member clone: rewrite the URL with the acting member's forge token
	// so a private repo clones AS them (the SDK gitCheckout has no auth option).
	// The member id was stamped by the gateway (trusted, never client-set); no
	// member / token → plain URL (public repos still clone).
	let cloneUrl = gitUrl;
	const cloneMemberId = forwarded.headers.get("X-Helmor-Member-Id");
	if (cloneMemberId) {
		try {
			const stub = env.FORGE_IDENTITY.get(
				env.FORGE_IDENTITY.idFromName(cloneMemberId),
			);
			const minted = await stub.mint();
			if (minted && !("error" in minted)) {
				cloneUrl = authenticatedGitUrl(gitUrl, minted);
			}
		} catch {
			// DO read failed → plain URL.
		}
	}
	try {
		const checkout = await sandbox.gitCheckout(cloneUrl, {
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
	const registerRes = await containerFetchThroughPort(
		sandbox,
		registerReq,
		port,
	);
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
	} else {
		// Registration succeeded: upsert the D1 workspaces mirror so the team
		// sidebar (`GET /team/workspaces`) lists the new repo. Best-effort — the
		// container DB is the source of truth; a mirror write failure must never
		// break the clone (the response already represents success). Read the
		// register response (AddRepositoryResponse, camelCase) off a clone so the
		// body returned to the client stays intact.
		try {
			const reg = (await registerRes.clone().json()) as {
				repositoryId?: string;
				selectedWorkspaceId?: string | null;
			};
			const id = reg.selectedWorkspaceId ?? reg.repositoryId;
			if (id) {
				await env.DB.prepare(
					`INSERT INTO workspaces (id, team_id, name, status, created_at)
					 VALUES (?1, ?2, ?3, ?4, ?5)
					 ON CONFLICT(id) DO UPDATE SET
					   name   = excluded.name,
					   status = excluded.status`,
				)
					.bind(id, TEAM_ID, name, "active", new Date().toISOString())
					.run();
			}
		} catch {
			// best-effort mirror — never break the clone on a registry write error
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
	sandbox: CloudflareSandbox,
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
async function backupAndStore(
	sandbox: CloudflareSandbox,
	env: Env,
): Promise<void> {
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
	const headers = await deriveGatewayHeaders(request, {
		store: createWorkerTeamGatewayStore(env, new URL(request.url)),
		companionToken: env.HELMOR_COMPANION_TOKEN,
	});
	if (headers instanceof Response) return headers;
	return new Request(request, { headers });
}

/** Where the per-member forge creds file is written in the container. OUTSIDE
 *  the backed-up `/home` tree so plaintext tokens never enter an R2 backup and a
 *  restore can't shadow a fresh injection. Matches the in-container loader's
 *  `HELMOR_FORGE_MEMBERS_PATH`. */
const FORGE_MEMBERS_PATH = "/tmp/helmor-forge-members.json";

/** Collect every member's forge creds from their `ForgeIdentity` DOs, keyed by
 *  member id. Members with nothing stored are omitted. */
async function collectMemberForgeCreds(
	env: Env,
): Promise<
	Record<
		string,
		{ githubToken?: string; glabConfigYml?: string; login?: string }
	>
> {
	const { results } = await env.DB.prepare(
		"SELECT id, github_login FROM members",
	).all<{ id: string; github_login: string | null }>();
	const out: Record<
		string,
		{ githubToken?: string; glabConfigYml?: string; login?: string }
	> = {};
	for (const row of results ?? []) {
		try {
			const stub = env.FORGE_IDENTITY.get(
				env.FORGE_IDENTITY.idFromName(row.id),
			);
			const minted = await stub.mint();
			if (
				minted &&
				!("error" in minted) &&
				(minted.githubToken || minted.glabConfigYml)
			) {
				out[row.id] = {
					githubToken: minted.githubToken,
					glabConfigYml: minted.glabConfigYml,
					login: row.github_login ?? undefined,
				};
			}
		} catch {
			// Skip a member whose DO read failed; the rest still inject.
		}
	}
	return out;
}

/** Write the collected per-member forge creds into the running container at
 *  {@link FORGE_MEMBERS_PATH}. The in-container `member_creds` loader hot-reloads
 *  it via mtime, so this doubles as the live re-inject on re-authorize. */
async function injectForgeMembers(
	sandbox: CloudflareSandbox,
	env: Env,
): Promise<void> {
	const creds = await collectMemberForgeCreds(env);
	await sandbox.writeFile(FORGE_MEMBERS_PATH, JSON.stringify(creds));
}

/** Rewrite an https clone URL to embed the acting member's forge token so the
 *  SDK `gitCheckout` (which has no auth option) can clone private repos AS that
 *  member. Returns the URL unchanged for non-https, already-credentialed, or
 *  unknown-host URLs (public clones still work). */
function authenticatedGitUrl(
	gitUrl: string,
	creds: { githubToken?: string; glabConfigYml?: string },
): string {
	let parsed: URL;
	try {
		parsed = new URL(gitUrl);
	} catch {
		return gitUrl;
	}
	if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
		return gitUrl;
	}
	if (parsed.hostname === "github.com" && creds.githubToken) {
		parsed.username = "x-access-token";
		parsed.password = creds.githubToken;
		return parsed.toString();
	}
	if (creds.glabConfigYml) {
		const token = parseGlabTokens(creds.glabConfigYml)[parsed.hostname];
		if (token) {
			parsed.username = "oauth2";
			parsed.password = token;
			return parsed.toString();
		}
	}
	return gitUrl;
}

/** Ensure the companion server is up. Fast-path on a health hit; otherwise
 *  launch the boot script and poll until it answers (Xvfb + serve cold start). */
export interface EnsureServeOptions {
	healthCheckTimeoutMs?: number;
	restoreBackupTimeoutMs?: number;
	startProcessTimeoutMs?: number;
	identityMintTimeoutMs?: number;
	readyTimeoutMs?: number;
	pollIntervalMs?: number;
}

export async function ensureServe(
	sandbox: CloudflareSandbox,
	env: Env,
	port: number,
	options: EnsureServeOptions = {},
): Promise<void> {
	const healthCheckTimeoutMs =
		options.healthCheckTimeoutMs ?? HEALTH_CHECK_TIMEOUT_MS;
	const restoreBackupTimeoutMs =
		options.restoreBackupTimeoutMs ?? RESTORE_BACKUP_TIMEOUT_MS;
	const startProcessTimeoutMs =
		options.startProcessTimeoutMs ?? START_PROCESS_TIMEOUT_MS;
	const identityMintTimeoutMs =
		options.identityMintTimeoutMs ?? IDENTITY_MINT_TIMEOUT_MS;
	const readyTimeoutMs = options.readyTimeoutMs ?? SERVE_READY_TIMEOUT_MS;
	const pollIntervalMs = options.pollIntervalMs ?? SERVE_POLL_INTERVAL_MS;

	if (await healthOk(sandbox, port, healthCheckTimeoutMs)) return;

	// Phase 2b sleep persistence: restore the last DB snapshot BEFORE serve
	// binds. Restore must precede serve (serve not yet running = no open handle
	// on helmor.db, safe to overwrite). A missing/failed restore is non-fatal —
	// the container cold-starts with an empty DB, exactly like a brand-new team.
	try {
		const handle = await readBackupHandle(env);
		if (handle) {
			await withTimeout(
				sandbox.restoreBackup(handle),
				restoreBackupTimeoutMs,
				"restoreBackup",
			);
		}
	} catch (error) {
		console.error("Phase 2b restore failed (cold-starting empty)", error);
	}

	// Phase 1 token brokers: mint a fresh, short-lived Codex auth.json
	// (CODEX_AUTH_JSON) and the Claude OAuth token (CLAUDE_CODE_OAUTH_TOKEN) from
	// the team's identity DOs and inject them for THIS cold start (design §3.3 /
	// VERIFIED §1.5). Computed per startProcess — never static bindings — so a
	// wake never replays a stale token. Run CONCURRENTLY: they hit independent
	// identity DOs, so serializing them needlessly added up to ~15s to every cold
	// start; failures stay isolated (one null never sinks the other). A missing
	// identity / brick / refresh failure starts serve WITHOUT that agent's auth
	// (it runs un-authenticated until re-authorize); we log only a NON-SENSITIVE
	// marker, never any token.
	const [codexAuthJson, claudeToken] = await Promise.all([
		withTimeout(
			mintCodexAuthJson(env),
			identityMintTimeoutMs,
			"codex identity mint",
		).catch((error) => {
			console.error(
				"Phase 1 codex mint timed out or failed",
				error instanceof Error ? error.message : "unknown",
			);
			return null;
		}),
		withTimeout(
			mintClaudeOauthToken(env),
			identityMintTimeoutMs,
			"claude identity mint",
		).catch((error) => {
			console.error(
				"Claude mint timed out or failed",
				error instanceof Error ? error.message : "unknown",
			);
			return null;
		}),
	]);

	await withTimeout(
		sandbox.startProcess(SERVE_START_CMD, {
			env: {
				HELMOR_COMPANION_TOKEN: env.HELMOR_COMPANION_TOKEN,
				HELMOR_SERVE_PORT: String(port),
				// Phase 2b: relocate the data dir under /home so it lands in the
				// backed-up /home/helmor tree (createBackup dir must be under
				// /workspace|/home|/tmp|/var/tmp|/app).
				HELMOR_DATA_DIR: "/home/helmor",
				// Pin HOME explicitly. The image sets no USER/HOME, so the spawned
				// serve process would otherwise inherit whatever ambient HOME the
				// sandbox runtime injects. The Claude onboarding seed in
				// start-serve.sh writes
				// `${CLAUDE_CONFIG_DIR:-${HOME:-/root}}/.claude.json` and the SDK's
				// claude child reads `$HOME/.claude.json` — pinning HOME makes the
				// seeded dir == the child's read path PROVABLY (VERIFIED §2.6 /
				// RISK-2). /root is root's home (matches start-serve.sh's fallback),
				// so today's behavior is unchanged, just made deterministic.
				HOME: "/root",
				// Claude Code refuses --dangerously-skip-permissions as root
				// (getuid()===0) UNLESS IS_SANDBOX=1 (binary guard, VERIFIED 2.1.x:
				// `getuid()===0 && IS_SANDBOX!=="1" && !CLAUDE_CODE_BUBBLEWRAP`). The
				// cloud Agent SDK runs claude-code non-interactively with
				// bypassPermissions, so without this EVERY claude turn exits code 1 in
				// this isolated, ephemeral CF container.
				IS_SANDBOX: "1",
				...(env.GITHUB_TOKEN ? { GITHUB_TOKEN: env.GITHUB_TOKEN } : {}),
				...(codexAuthJson ? { CODEX_AUTH_JSON: codexAuthJson } : {}),
				...(claudeToken ? { CLAUDE_CODE_OAUTH_TOKEN: claudeToken } : {}),
				// Per-member forge creds file (written just below, after the
				// container is up). The in-container loader reads it lazily on the
				// first forge op, so writing it right after startProcess is in time.
				HELMOR_FORGE_MEMBERS_PATH: FORGE_MEMBERS_PATH,
			},
		}),
		startProcessTimeoutMs,
		"startProcess",
	);

	// True per-member forge: snapshot every member's gh/glab creds from their
	// ForgeIdentity DOs and write them into the container (OUTSIDE the backed-up
	// /home tree, so plaintext tokens never land in an R2 backup). Best-effort —
	// a failure just leaves the forge layer on its repo-bound fallback.
	await injectForgeMembers(sandbox, env).catch((error) => {
		console.error(
			"forge members inject failed",
			error instanceof Error ? error.message : "unknown",
		);
	});

	// Cold start: Xvfb + GTK/WebKit init + companion bind. Poll up to ~120s
	// (WebKitGTK init is heavy on a fresh container's first boot).
	const deadline = Date.now() + readyTimeoutMs;
	do {
		if (await healthOk(sandbox, port, healthCheckTimeoutMs)) return;
		await sleep(pollIntervalMs);
	} while (Date.now() < deadline);
	throw new Error("companion /v1/health did not respond in time");
}

export async function healthOk(
	sandbox: CloudflareSandbox,
	port: number,
	timeoutMs = HEALTH_CHECK_TIMEOUT_MS,
): Promise<boolean> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await withTimeout(
			containerFetchThroughPort(
				sandbox,
				new Request(`http://localhost:${port}/v1/health`, {
					signal: controller.signal,
				}),
				port,
			),
			timeoutMs,
			"health check",
		);
		return res.ok;
	} catch {
		return false;
	} finally {
		clearTimeout(timeout);
	}
}

function containerFetchThroughPort(
	sandbox: CloudflareSandbox,
	request: Request,
	port: number,
): Promise<Response> {
	const url = new URL(request.url);
	const target = `http://localhost:${port}${url.pathname}${url.search}`;
	const proxyUrl = new URL(request.url);
	proxyUrl.pathname = `/__helmor-companion/${port}${url.pathname}`;
	const init: RequestInit = {
		method: request.method,
		headers: request.headers,
		signal: request.signal,
	};
	if (request.method !== "GET" && request.method !== "HEAD") {
		init.body = request.body;
	}
	const fetchThroughDurableObject = (sandbox as { fetch?: typeof fetch }).fetch;
	if (fetchThroughDurableObject) {
		return fetchThroughDurableObject(new Request(proxyUrl.toString(), init));
	}
	return sandbox.containerFetch(target, init, port);
}

async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	label: string,
): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | null = null;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeout = setTimeout(
			() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
			timeoutMs,
		);
	});
	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		if (timeout) clearTimeout(timeout);
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

/**
 * Mint the container's Claude subscription OAuth token from the team's identity
 * DO at cold start (Claude broker). Resolves the team's bound
 * `cloud_identity_member_id` (REUSED — shared identity for v1; same binding as
 * Codex), gets that member's `ClaudeIdentity` DO, and calls `mintToken()`
 * (Workers RPC). Returns the bare `sk-ant-oat01…` token to inject as
 * `CLAUDE_CODE_OAUTH_TOKEN`, or `null` to start serve WITHOUT Claude auth.
 *
 * SECURITY: only ever logs a NON-SENSITIVE marker — never the token. A
 * `{ error }` result (no identity) is a clean skip; cloud Claude runs fail until
 * the user authorizes.
 */
async function mintClaudeOauthToken(env: Env): Promise<string | null> {
	const memberId = await readCloudIdentityMemberId(env);
	if (!memberId) return null; // No cloud identity configured for this team.

	try {
		const stub = env.CLAUDE_IDENTITY.get(
			env.CLAUDE_IDENTITY.idFromName(memberId),
		);
		const mint = await stub.mintToken();
		if ("token" in mint) {
			return mint.token;
		}
		// Non-sensitive marker only (the `error` discriminant, never a value).
		console.error(`Claude mint skipped: ${mint.error}`);
		return null;
	} catch (error) {
		console.error(
			"Claude mint failed",
			error instanceof Error ? error.message : "unknown",
		);
		return null;
	}
}
