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
	type DirectoryBackup,
	getSandbox,
	proxyToSandbox,
} from "@cloudflare/sandbox";
import { parseGlabTokens } from "./forge-config";
import {
	cachedCatalogResponse,
	MODEL_CATALOG_RPC,
	parseModelCatalogPayload,
	readModelCatalog,
	writeModelCatalog,
} from "./model-catalog";
import {
	createWorkerTeamGatewayStore,
	handleTeamRoute,
	lookupMemberId,
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

		// F-4 root fix: the base's `isActivityExpired` treats ANY
		// `inflightRequests > 0` as activity and RE-ARMS the idle timer on
		// every alarm tick. A SIGKILLed desktop leaves companion pipes that
		// never settle (verified live: inflight pinned at 4 for 7h+, container
		// never slept, billing on). Replace the expiry check (an instance
		// class-field on the SDK base — override it per-instance) with one
		// keyed ONLY on `sleepAfterMs`: liveness renews the timer explicitly —
		// every request start (base + fetchCompanionPort), and streaming
		// bodies via the throttled progress renewal in `fetchCompanionPort` —
		// so a genuinely active connection keeps the container awake by MOVING
		// BYTES, while a dead pipe stops renewing and the timer runs out.
		const self = this as unknown as {
			isActivityExpired: () => boolean;
			sleepAfterMs?: number;
			inflightRequests?: number;
		};
		self.isActivityExpired = () => {
			// Not yet armed (onStart/renew hasn't run) → not expired.
			if (typeof self.sleepAfterMs !== "number") return false;
			const expired = self.sleepAfterMs <= Date.now();
			if (expired) {
				console.log(
					`[idle] expiry reached (inflight=${self.inflightRequests ?? "?"} — ignored; renewals stopped)`,
				);
			}
			return expired;
		};
	}

	/** Arm the idle countdown on every container start. A rollout / platform
	 *  restart does NOT go through a request, so the base never arms the timer and
	 *  the container would run forever. `renewActivityTimeout` is the documented
	 *  "renew even without a request" call. */
	async onStart(): Promise<void> {
		await super.onStart();
		try {
			await (
				this as unknown as { renewActivityTimeout: () => Promise<void> | void }
			).renewActivityTimeout();
		} catch (error) {
			console.error("arm idle timer on start failed", error);
		}
	}

	/** R3-A (live-verified leak): the containers base constructor calls
	 *  `renewActivityTimeout()` inside `blockConcurrencyWhile` on EVERY DO
	 *  (re-)instantiation. A passive request that wakes an evicted DO would
	 *  therefore re-arm the full idle window — steady passive polling could
	 *  keep a running container alive through eviction cycles forever. Skip
	 *  exactly that one constructor renew: wake traffic renews explicitly,
	 *  and `onStart` re-arms on real container boot (platform-restart guard).
	 *  Class-field init runs before the base's deferred renew (it yields a
	 *  microtask for exactly this reason), so the flag is reliably set. */
	private skipConstructorRenew = true;

	/** F-4 diagnostics: log every idle-timer renewal with its caller so a live
	 *  `wrangler tail` shows exactly what keeps the container awake. Cheap
	 *  (one log per renewal) and safe to keep. */
	renewActivityTimeout(): void {
		if (this.skipConstructorRenew) {
			this.skipConstructorRenew = false;
			console.log(
				"[idle] constructor renew skipped (R3-A: DO re-instantiation must not re-arm)",
			);
			return;
		}
		const caller = new Error().stack?.split("\n")[2]?.trim() ?? "?";
		const internals = this as unknown as {
			inflightRequests?: number;
			sleepAfterMs?: number;
		};
		console.log(
			`[idle] renew inflight=${internals.inflightRequests ?? "?"} caller=${caller}`,
		);
		super.renewActivityTimeout();
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
			// R3-A typed asleep: only reached without a preceding ensureServe (a
			// wake-intent request cold-starts first), so a sleeping container
			// answers with the structured shape the frontend treats as "keep
			// showing last-known data" — never a wake, never an error dialog.
			return containerAsleepResponse();
		}

		// R3-A gate 2 (renew): only requests that explicitly declared wake
		// intent may renew the idle timer — at request start AND through the
		// streaming progress tap below. Unmarked (PASSIVE) traffic is forwarded
		// but leaves the countdown untouched, so an open watch stream (with its
		// 30s keepalives) no longer keeps the container awake forever. Inflight
		// accounting stays IDENTICAL for both (F-4 leak protection unchanged —
		// `isActivityExpired` ignores inflight; the bookkeeping is diagnostics
		// + the no-progress watchdog still settles corpse pipes).
		const wakeIntent = request.headers.get(WAKE_INTENT_HEADER) === "1";

		const tcpPort = internals.container.getTcpPort(port);
		const target = request.url.replace("https:", "http:");

		internals.inflightRequests = (internals.inflightRequests ?? 0) + 1;
		if (wakeIntent) internals.renewActivityTimeout?.();
		let released = false;
		const release = () => {
			if (released) return;
			released = true;
			if (wakeIntent) {
				internals.decrementInflight?.();
				return;
			}
			// R3-A gate 2 (live-verified leak): the base `decrementInflight`
			// renews the idle timer whenever inflight hits 0 ("window starts
			// fresh from the last request completion") — right for wake
			// traffic, but it let every PASSIVE request re-arm the countdown
			// on release. Decrement manually so passive traffic keeps the F-4
			// accounting without ever touching the timer.
			internals.inflightRequests = Math.max(
				0,
				(internals.inflightRequests ?? 1) - 1,
			);
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
			// disconnects it drops to idle and `sleepAfter` starts.
			//
			// F-4 (idle sleep never fired): the previous hand-rolled pull/cancel
			// wrapper only released when the runtime called pull() or cancel() —
			// a client disconnect with no outstanding read left the stream
			// stalled, `release()` never ran, and `inflightRequests` stayed ≥ 1
			// forever. `isActivityExpired()` treats any inflight as activity and
			// RE-ARMS the timer on every alarm tick, so the container never
			// slept (observed: 55+ min active with zero traffic). Mirror the
			// SDK's own containerFetch pattern instead: pump the body through an
			// IdentityTransformStream and release in `finally` — the pipe
			// settles on upstream close, upstream error, OR downstream cancel,
			// so every disconnect path decrements exactly once.
			// Second layer (verified live): a SIGKILLed client does NOT reliably
			// propagate cancel into this pipe — the pipe stalls on backpressure,
			// `finally` never runs, and inflight stays pinned (observed: 4 leaked
			// connections kept the container awake 7h+). A no-progress watchdog
			// force-settles dead pipes: every healthy companion stream carries
			// keepalive pings (`/v1/stream` pings; RPC bodies finish fast), so a
			// pipe that moves ZERO bytes for this long is a corpse, not a quiet
			// stream.
			const PIPE_NO_PROGRESS_MS = 120_000;
			// Throttled liveness renewal: with `isActivityExpired` keyed only on
			// `sleepAfterMs` (see constructor), a long-running stream keeps the
			// container awake by actually MOVING BYTES — every healthy companion
			// stream carries keepalive pings, so this renews at most once per
			// minute while data flows and stops the moment the pipe dies.
			const RENEW_EVERY_MS = 60_000;
			let lastRenew = Date.now();
			let lastProgress = Date.now();
			// R3-A gate 2: a PASSIVE pipe still tracks progress (watchdog) but
			// its bytes never renew — a watch stream's keepalives feed corpse
			// detection only, so watching a session is free.
			const renew = wakeIntent
				? () => internals.renewActivityTimeout?.()
				: () => {};
			const progressTap = new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, controller) {
					const now = Date.now();
					lastProgress = now;
					if (now - lastRenew >= RENEW_EVERY_MS) {
						lastRenew = now;
						renew();
					}
					controller.enqueue(chunk);
				},
			});
			const abort = new AbortController();
			const watchdog = setInterval(() => {
				if (Date.now() - lastProgress > PIPE_NO_PROGRESS_MS) {
					abort.abort("companion pipe made no progress; force-settling");
				}
			}, 30_000);
			const { readable, writable } = new IdentityTransformStream();
			void response.body
				.pipeThrough(progressTap)
				.pipeTo(writable, { signal: abort.signal })
				.catch(() => {
					// Client disconnected / upstream dropped / watchdog abort —
					// release below.
				})
				.finally(() => {
					clearInterval(watchdog);
					release();
				});
			return new Response(readable, response);
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
		// destroy() (SIGKILL), NOT super/stop() (SIGTERM). `helmor serve` does NOT
		// exit on SIGTERM, so stop() leaves the VM running (health active:1) forever
		// — VERIFIED: the clean super/stop build stayed active:1 with the desktop
		// fully KILLED and zero traffic. destroy() force-kills the VM → it actually
		// stops (active:0 = scaled to zero, billing stops). backupBeforeSleep has
		// already snapshotted to R2, so a hard kill is safe — the next request
		// cold-starts and restores. (Do NOT revert this to super/stop.)
		await this.destroy();
	}

	private async backupBeforeSleep(): Promise<void> {
		// HARD rule: this must NEVER block the stop. `onActivityExpired` runs this
		// THEN calls `super` (the SIGTERM). If `createBackup` HANGS, `super` never
		// runs, the base renews the activity tracker, and the container never
		// sleeps — `@cloudflare/containers`: "if you don't stop the container here,
		// the activity tracker will be renewed, and this lifecycle hook will be
		// called again when the timer re-expires." The old try/catch only guarded
		// against THROWS, not hangs. Bound the whole backup: if it can't finish in
		// budget, skip it and let the stop proceed (cold start restores the prior
		// post-turn snapshot).
		const BACKUP_BUDGET_MS = 15_000;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				(async () => {
					const handle = await this.createBackup({
						dir: "/home/helmor",
						localBucket: true,
						name: `helmor-idle-${new Date().toISOString()}`,
						ttl: 259200, // 3 days
						// R2-F4a POST-MORTEM: keep this list IDENTICAL to
						// backupAndStore's. Nested "dir/sub" exclude patterns made
						// mksquashfs drop the ENTIRE .claude tree from idle backups
						// (verified by archive autopsy: the idle backup with nested
						// globs had no .claude at all, while the post-turn backup
						// with only these five top-level names carried the threads)
						// — which silently defeated the provider-state relocation.
						// Archives stay small (~75KB with threads); if provider
						// noise ever threatens the 15s budget, prune it container-
						// side instead of risking this exclude semantics again.
						excludes: ["workspaces", "cache", "logs", "run", "local-llm"],
					});
					await writeBackupHandle(this.helmorEnv, handle);
					// F-5 boundary, observable in `wrangler tail`: the idle path
					// backs up BEFORE destroy; /admin/destroy-sandbox intentionally
					// does not (a deliberate reset).
					console.log("[idle] backup-before-sleep done; destroying");
				})(),
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new Error("idle-sleep backup timed out")),
						BACKUP_BUDGET_MS,
					);
				}),
			]);
		} catch (error) {
			console.error("idle-sleep backup skipped", error);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}
}
// Likewise for the `CLAUDE_IDENTITY` binding (Claude subscription token broker).
export { ClaudeIdentity } from "./claude-identity";
// Re-export so workerd registers the Durable Object class named in
// wrangler.toml's `CODEX_IDENTITY` binding (Phase 1 Codex token broker).
export { CodexIdentity } from "./codex-identity";
export { ForgeIdentity } from "./forge-identity";
// Stage C event plane: the hibernating WebSocket relay hub (see team-hub.ts).
export { TeamHub } from "./team-hub";

export interface Env {
	Sandbox: DurableObjectNamespace<CloudflareSandbox>;
	/** Team event plane (Stage C): hibernating WS relay hub. Pure relay — no
	 *  secrets, no D1. Reached via idFromName(HELMOR_SANDBOX_ID). */
	TEAM_HUB: DurableObjectNamespace<import("./team-hub").TeamHub>;
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
/** R3-E: hard deadline for plain (non-stream) /rpc proxy hops. Generous —
 *  finalize/clone-scale work legitimately takes tens of seconds — but finite,
 *  so a stuck container handler surfaces as a typed 504 instead of a
 *  client-side forever-hang (WP2 contract on the plain-RPC face). */
const RPC_PROXY_TIMEOUT_MS = 60_000;

/** R3-E: race a plain /rpc proxy hop against the deadline; a breach returns a
 *  typed 504 (`ContainerRpcTimeout`) instead of hanging the client forever.
 *  Non-timeout rejections pass through untouched. */
export async function proxyPlainRpcWithDeadline(
	fetchPromise: Promise<Response>,
	pathname: string,
	timeoutMs: number = RPC_PROXY_TIMEOUT_MS,
): Promise<Response> {
	try {
		return await withTimeout(fetchPromise, timeoutMs, `rpc proxy ${pathname}`);
	} catch (error) {
		if (!String((error as Error).message).includes("timed out")) throw error;
		return new Response(
			JSON.stringify({
				code: "ContainerRpcTimeout",
				message: `${pathname} did not answer within ${timeoutMs}ms — the container may be stuck; retry or check its health.`,
			}),
			{ status: 504, headers: { "content-type": "application/json" } },
		);
	}
}
const START_PROCESS_TIMEOUT_MS = 90_000;
const IDENTITY_MINT_TIMEOUT_MS = 15_000;
const FORGE_INJECT_TIMEOUT_MS = 15_000;
const SERVE_READY_TIMEOUT_MS = 180_000;
const SERVE_POLL_INTERVAL_MS = 500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Agent-stream RPC path. After this stream closes, the in-container WAL
 *  checkpoint (gated by HELMOR_CLOUD_AUTOPUSH) has already folded helmor.db, so
 *  a backup taken now snapshots a consistent DB. */
const AGENT_STREAM_PATH = "/rpc-stream/send_agent_message_stream";

/** R3-A wake-intent marker (mirrors `WAKE_INTENT_HEADER` in `src/lib/ipc.ts`).
 *  Only requests carrying it may cold-start the container (gate 1, `route`) or
 *  renew its idle timer (gate 2, `fetchCompanionPort`). Cost governance, not a
 *  security boundary — the member token already authenticates the caller; this
 *  protects the wallet from our own passive traffic, not from attackers. */
export const WAKE_INTENT_HEADER = "X-Helmor-Wake-Intent";

/** The typed asleep answer for PASSIVE traffic while the container sleeps.
 *  The frontend maps `code: "ContainerAsleep"` to `CompanionAsleepError`:
 *  queries keep their previous data (no retry, no error dialog), micro-writes
 *  queue for the next wake. */
export function containerAsleepResponse(): Response {
	return new Response(
		JSON.stringify({
			code: "ContainerAsleep",
			asleep: true,
			message:
				"The sandbox is asleep; passive requests return stale data until an explicit action wakes it.",
		}),
		{ status: 503, headers: { "content-type": "application/json" } },
	);
}

/** R3-A gate 1: proxy a PASSIVE request WITHOUT ensureServe. An awake
 *  container answers normally (gate 2 keeps its idle timer untouched); a
 *  sleeping one — or one mid-cold-start whose serve isn't listening yet —
 *  yields the typed asleep response instead of a wake. */
export async function proxyWithoutWake(
	sandbox: CloudflareSandbox,
	forwarded: Request,
	port: number,
): Promise<Response> {
	try {
		return await containerFetchThroughPort(sandbox, forwarded, port);
	} catch (error) {
		console.log(
			`[wake-gate] passive proxy failed while not serving: ${(error as Error).message}`,
		);
		return containerAsleepResponse();
	}
}

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
			// R3-A: the wake-intent marker is a custom header, so every marked
			// request preflights — it MUST be allowed here or the browser blocks
			// the actual POST ("Can't reach the team cloud", live-verified).
			"Authorization, Content-Type, X-Helmor-Member-Id, X-Helmor-Wake-Intent",
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

/** WP6.1: force-DESTROY the running container so the NEXT request cold-starts
 *  fresh and picks up the just-rotated `HELMOR_COMPANION_TOKEN`. `stop()` (SIGTERM)
 *  can't do this — `helmor serve` ignores SIGTERM and the VM stays up caching the
 *  OLD token (see `onActivityExpired`), so a re-provision against a WARM container
 *  401s every proxied request until an idle sleep. `destroy()` (SIGKILL) scales it
 *  to zero. ADMIN-token only (provision holds it): the derived hop gives an admin
 *  bearer the companion token with NO member id, a member gets an
 *  `X-Helmor-Member-Id` — so we require companion-token AND no member id. */
export async function handleAdminDestroySandbox(
	forwarded: Request,
	env: Env,
	sandbox: { destroy: () => Promise<void> },
): Promise<Response> {
	const adminAuthed =
		forwarded.headers.get("Authorization") ===
			`Bearer ${env.HELMOR_COMPANION_TOKEN}` &&
		forwarded.headers.get("X-Helmor-Member-Id") === null;
	if (!adminAuthed) {
		return new Response(
			JSON.stringify({ code: "Unauthorized", message: "admin token required" }),
			{ status: 401, headers: { "content-type": "application/json" } },
		);
	}
	await sandbox.destroy();
	return new Response(
		JSON.stringify({
			ok: true,
			message: "sandbox destroyed; the next request cold-starts fresh",
		}),
		{ headers: { "content-type": "application/json" } },
	);
}

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

	// Event plane (Stage C): realtime lives on the hibernating TeamHub DO, NOT
	// the container — handle before the team registry + any ensureServe so these
	// never wake the sandbox.
	if (url.pathname === "/v1/ws") return handleTeamEventSubscribe(req, env);
	if (url.pathname === "/team/event" && req.method === "POST") {
		return handleTeamEventPublish(req, env);
	}

	const teamResp = await handleTeamRoute(req, env, url);
	if (teamResp) return teamResp;

	// Derive the member identity + companion-token swap for the proxied hop.
	// Unauthenticated calls pass through unswapped (the companion gates them:
	// /rpc -> 401, /v1/health stays public); unknown tokens -> 401 (see fn).
	const forwarded = await deriveForwardedRequest(req, env);
	if (forwarded instanceof Response) return forwarded;

	const port = Number(env.HELMOR_COMPANION_PORT ?? "8080");
	const sandboxId = env.HELMOR_SANDBOX_ID ?? "helmor-team-0";
	const sandbox = getSandbox(env.Sandbox, sandboxId);

	// WP5 (D2): the model catalog lives in the CONTROL PLANE. Answer
	// `list_agent_model_sections` from the D1 cache BEFORE ensureServe so the
	// composer + the team-readiness probe get models in milliseconds while the
	// container sleeps; only a real @agent send (`/rpc-stream/*`) wakes it. A
	// cache MISS falls through to the normal ensureServe+proxy path below (the
	// one legitimate non-@agent wake: brand-new/reset teams — provision's WP6
	// verify normally seeds the cache at setup) and the live response is
	// written through. Auth mirrors /admin/*: derived member or admin token —
	// the cached answer must never be weaker-gated than the container's own
	// /rpc 401.
	if (url.pathname === MODEL_CATALOG_RPC) {
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
		const cached = await readModelCatalog(env.DB, sandboxId);
		if (cached !== null) return cachedCatalogResponse(cached);
	}

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

	// Member/admin warm-up (Stage D): pre-wake the container in the BACKGROUND so
	// a subsequent @agent run is hot. Fire-and-forget (ctx.waitUntil) + 202 so the
	// caller (composer focus) never blocks on the ~cold start. Same auth as
	// /admin/restart-sandbox.
	if (url.pathname === "/admin/warm-up") {
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
		ctx.waitUntil(
			ensureServe(sandbox, env, port, { syncUrl: url.origin })
				// WP5: a warm-up cold start refreshes the catalog cache too.
				.then((r) =>
					r.coldStarted ? refreshModelCatalog(sandbox, env, port) : undefined,
				)
				.catch(() => {}),
		);
		return new Response(null, { status: 202 });
	}

	// Provision-time reset (WP6.1): force-destroy the warm container so the NEXT
	// request cold-starts and injects the just-rotated companion token. Handled
	// BEFORE ensureServe so it never triggers a cold start itself.
	if (url.pathname === "/admin/destroy-sandbox") {
		return handleAdminDestroySandbox(forwarded, env, sandbox);
	}

	// R3-A gate 1 (cold start): only wake-intent requests may ensureServe.
	// Everything else is proxied as-is — an awake container answers normally
	// (without renewing, gate 2), a sleeping one gets the typed asleep shape.
	// Path exemptions (both intentional wake-capable):
	//   - /v1/health: diagnostic endpoint — provision/WP6 verify depend on it
	//     performing a REAL cold-start check; no frontend code polls it.
	//   - MODEL_CATALOG_RPC: only reaches here on a D1 cache MISS — WP5's one
	//     legitimate non-@agent wake (brand-new/reset team seeds the catalog).
	const wakeIntent = req.headers.get(WAKE_INTENT_HEADER) === "1";
	if (
		!wakeIntent &&
		url.pathname !== "/v1/health" &&
		url.pathname !== MODEL_CATALOG_RPC
	) {
		return proxyWithoutWake(sandbox, forwarded, port);
	}

	try {
		const { coldStarted } = await ensureServe(sandbox, env, port, {
			syncUrl: url.origin,
		});
		// WP5 invalidation: EVERY cold start refreshes the catalog cache in the
		// background, so an image update (new/removed models) is picked up on the
		// first real wake after it — no TTL, no image-tag plumbing.
		if (coldStarted) {
			ctx.waitUntil(refreshModelCatalog(sandbox, env, port));
		}
	} catch (error) {
		// A PERMANENT container-start failure (bad image / limits / crash-loop) is
		// terminal: retries won't help. Surface it as a STRUCTURED `permanent` 503
		// (with the failing phase) so the desktop degrades FAST to a "re-run setup"
		// state instead of polling the 180s cold-start ceiling. Match both the typed
		// error (from ensureServe's probes) and a raw startProcess throw by message.
		if (
			error instanceof PermanentContainerError ||
			isPermanentContainerError(error)
		) {
			const phase =
				error instanceof PermanentContainerError ? error.phase : "startup";
			return new Response(
				JSON.stringify({
					code: "ContainerPermanentError",
					message: (error as Error).message,
					phase,
					permanent: true,
				}),
				{ status: 503, headers: { "content-type": "application/json" } },
			);
		}
		// R3-D: a failing backup restore is its own structured failure —
		// "your data snapshot can't be loaded" is actionable (check backup
		// size/health), unlike the generic not-ready shape below, and must
		// never be silently retried into an OOM wedge loop.
		if (error instanceof ContainerRestoreError) {
			return new Response(
				JSON.stringify({
					code: "ContainerRestoreFailed",
					message: error.message,
				}),
				{ status: 503, headers: { "content-type": "application/json" } },
			);
		}
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
	//
	// R3-E: plain /rpc calls get a hard deadline → typed 504. The WP2 error
	// contract was closed for the STREAM entry in R3-B; the plain-RPC face
	// (workspace creation among others) could still hang forever with the
	// client seeing nothing — no reject, no resolve (OBS-R3C-2). Streams
	// (`/rpc-stream/*`) are long-lived by design and stay un-deadlined.
	const response = url.pathname.startsWith("/rpc/")
		? await proxyPlainRpcWithDeadline(
				containerFetchThroughPort(sandbox, forwarded, port),
				url.pathname,
			)
		: await containerFetchThroughPort(sandbox, forwarded, port);

	// WP5 write-through: a LIVE pass of the model-catalog RPC (cache miss above,
	// or a pre-seed by provision's WP6 verify) stores the container's answer so
	// every later call — probe or composer — is a no-wake cache hit.
	if (url.pathname === MODEL_CATALOG_RPC && response.ok) {
		const clone = response.clone();
		ctx.waitUntil(
			(async () => {
				const payload = parseModelCatalogPayload(await clone.text());
				if (payload) await writeModelCatalog(env.DB, sandboxId, payload);
			})().catch((error) => {
				console.error("model-catalog write-through failed", error);
			}),
		);
	}

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

	// R3-E: the SDK checkout materializes the working tree but NOT the
	// remote-tracking refs (`origin/<branch>`), and the worktree finalize
	// path resolves its base as `origin/<default>` — without this fetch,
	// every team build-workspace finalize dies with "Base branch is missing
	// in source repo" (live-verified on a fresh clone). Fetch the full
	// refspec through the same (possibly token-authenticated) origin remote
	// the clone configured. A failure is fatal for the add: better a typed
	// error now than a repo that wedges every workspace create later.
	try {
		const refFetch = await sandbox.exec(
			`git -C '${targetDir}' fetch origin '+refs/heads/*:refs/remotes/origin/*'`,
		);
		if (refFetch.exitCode !== 0) {
			await sandbox.exec(`rm -rf '${targetDir}'`).catch(() => {});
			return jsonError(
				502,
				`git fetch (remote-tracking refs) failed after clone (exit ${refFetch.exitCode}): ${refFetch.stderr?.slice(0, 300) ?? ""}`,
			);
		}
	} catch (error) {
		await sandbox.exec(`rm -rf '${targetDir}'`).catch(() => {});
		return jsonError(
			502,
			`git fetch (remote-tracking refs) failed after clone: ${(error as Error).message}`,
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
 * DF-4 backup gate: does this NDJSON line represent work worth a snapshot?
 * NOT backup-worthy: keepalive blanks and `{"kind":"error"}` terminal events
 * (the companion emits them for ENTRY validation failures — nothing was
 * persisted, `persisted: false`). The two exclusions interlock with the DF-4
 * error-surface fix: a failed turn now carries an error event (visible), and
 * that event alone must NOT re-qualify the empty turn for a 48MB backup — a
 * byte-based predicate would. Serde emits the `kind` tag first, so a cheap
 * prefix check suffices; any other event (update/done/…) means the turn did
 * real work.
 */
export function isBackupWorthyLine(line: string): boolean {
	const trimmed = line.trim();
	if (trimmed.length === 0) return false; // keepalive
	return !trimmed.startsWith('{"kind":"error"');
}

/**
 * Wait for the agent-stream body to fully drain (so the in-container WAL
 * checkpoint + autopush that fire just before the terminal `done` have run),
 * then snapshot the data dir to R2 and persist the handle. Best-effort: a
 * backup failure must never surface to the client (the response already left).
 *
 * DF-4 backup gate: a stream that carried NO backup-worthy line (empty turn —
 * entry validation failed, only keepalives/error events flowed) skips the
 * snapshot entirely; dogfooding measured 48MB×3s per failed request. On a
 * mid-stream abort we back up anyway (a slightly-stale snapshot beats none).
 */
export async function backupAfterStream(
	body: ReadableStream<Uint8Array>,
	sandbox: CloudflareSandbox,
	env: Env,
): Promise<void> {
	let backupWorthy = false;
	try {
		// Drain to EOF — resolves when the companion closes the stream, i.e.
		// after the turn finalized (checkpoint folded helmor.db). Scan lines
		// until the first backup-worthy one, then just drain.
		const decoder = new TextDecoder();
		let tail = "";
		await body.pipeTo(
			new WritableStream({
				write(chunk) {
					if (backupWorthy) return;
					tail += decoder.decode(chunk, { stream: true });
					const lines = tail.split("\n");
					tail = lines.pop() ?? "";
					if (lines.some(isBackupWorthyLine)) backupWorthy = true;
					// A pathological unterminated line can't grow unbounded:
					// classify it conservatively as work and stop buffering.
					if (tail.length > 1_000_000) {
						backupWorthy = true;
						tail = "";
					}
				},
			}),
		);
		if (!backupWorthy && isBackupWorthyLine(tail)) backupWorthy = true;
	} catch {
		// A client disconnect can abort the tee; still attempt the backup with
		// whatever is on disk — a slightly-stale snapshot beats none.
		backupWorthy = true;
	}
	if (!backupWorthy) {
		console.log(
			"skipping post-stream backup: no persisted work on this stream (keepalives/error events only)",
		);
		return;
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
			excludes: BACKUP_EXCLUDES,
		});
		await writeBackupHandle(env, handle);
		await warnIfBackupOversized(env, handle);
	} catch (error) {
		console.error("Phase 2b backup failed", error);
	}
}

/** Trees excluded from the sleep backup. Workspaces are pushed to git by
 *  autopush; cache/logs/run/local-llm are disposable.
 *
 *  R3-D: `.codex/.tmp` is Codex's plugin-marketplace clone cache — fully
 *  regenerable and 76MB+ in practice. Backing it up inflated the archive
 *  ~700x (70KB → 48MB), and restoring that archive blew the Sandbox DO's
 *  isolate memory limit in `restoreBackup`, wedging EVERY subsequent wake
 *  (P0 OBS-R3C-3). Provider dirs live under the backed-up tree since F4a —
 *  any future cache they grow must be excluded here too (the size alarm
 *  below is the tripwire). */
export const BACKUP_EXCLUDES = [
	"workspaces",
	"cache",
	"logs",
	"run",
	"local-llm",
	".codex/.tmp",
];

/** R3-D: backup size budget alarm. Healthy backups (SQLite DB + provider
 *  state, caches excluded) are single-digit MB; the alarm threshold is ~10x
 *  that. A breach means something regenerable crept back into the archive —
 *  fix the excludes BEFORE the archive grows past what `restoreBackup` can
 *  hold in the DO isolate (the OOM-wedge failure mode this guards against). */
export const BACKUP_SIZE_WARN_BYTES = 50 * 1024 * 1024;

export async function warnIfBackupOversized(
	env: Env,
	handle: DirectoryBackup,
): Promise<void> {
	try {
		const head = await env.BACKUP_BUCKET?.head(
			`backups/${handle.id}/data.sqsh`,
		);
		if (head && head.size > BACKUP_SIZE_WARN_BYTES) {
			console.warn(
				`backup size budget exceeded: ${head.size} bytes (budget ${BACKUP_SIZE_WARN_BYTES}) — check createBackup excludes before restores start OOMing`,
			);
		}
	} catch {
		// Size check is best-effort telemetry; never fail the backup for it.
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

/** WS subprotocol marker carrying the bearer (browsers can't set Authorization
 *  on a WebSocket): the desktop offers `["helmor.v1", "<token>"]`. */
const TEAM_WS_MARKER = "helmor.v1";

/** GET /v1/ws — desktop subscribes to the team event stream over a hibernating
 *  WebSocket on the TeamHub DO. The bearer rides the WS subprotocol; we classify
 *  it exactly like an HTTP bearer and reject `unauthorized`. NEVER touches the
 *  container (the whole point: realtime survives sandbox sleep). */
async function handleTeamEventSubscribe(
	req: Request,
	env: Env,
): Promise<Response> {
	if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
		return new Response("Expected WebSocket upgrade", { status: 426 });
	}
	const token =
		(req.headers.get("Sec-WebSocket-Protocol") ?? "")
			.split(",")
			.map((p) => p.trim())
			.find((p) => p && p !== TEAM_WS_MARKER) ?? null;
	const store = createWorkerTeamGatewayStore(env, new URL(req.url));
	const auth = await store.classifyBearer(token);
	if (auth.caller === "unauthorized") {
		return new Response("Unauthorized", { status: 401 });
	}
	const stub = env.TEAM_HUB.get(
		env.TEAM_HUB.idFromName(env.HELMOR_SANDBOX_ID ?? "helmor-team-0"),
	);
	return stub.fetch("https://team-hub/ws", {
		headers: {
			Upgrade: "websocket",
			"X-Helmor-Member-Id": auth.memberId ?? "",
		},
	});
}

/** POST /team/event — the container/Worker pushes one already-shaped event line
 *  (`{"event","data"}`) to broadcast to every connected member. Companion token
 *  only (the container holds HELMOR_COMPANION_TOKEN ⇒ classifyBearer "admin").
 *  NEVER touches the container. */
/** R2-E (ruling, correction C): the ONLY ui-mutation kinds a MEMBER token may
 *  publish directly. Everything else stays companion-token-only — a member
 *  must never be able to forge arbitrary ui-mutations (cache-invalidation
 *  spoofing) or impersonate another member. */
const MEMBER_PUBLISHABLE_EVENT_TYPES = new Set(["roomPresenceChanged"]);

export async function handleTeamEventPublish(
	req: Request,
	env: Env,
): Promise<Response> {
	const bearer = (req.headers.get("Authorization") ?? "").replace(
		/^Bearer /,
		"",
	);
	const isCompanion = bearer === env.HELMOR_COMPANION_TOKEN;
	let memberId: string | null = null;
	if (!isCompanion) {
		memberId = bearer ? await lookupMemberId(env, bearer) : null;
		if (!memberId) return new Response("Unauthorized", { status: 401 });
	}
	let line = await req.text();
	if (!line) return new Response(null, { status: 204 });

	if (!isCompanion) {
		// Member-published events: whitelisted kinds only, and the server
		// STAMPS the member identity from the token — a body-asserted
		// memberId is overwritten, never trusted.
		let parsed: {
			event?: string;
			data?: { type?: string; memberId?: string; ts?: number };
		};
		try {
			parsed = JSON.parse(line);
		} catch {
			return new Response("Bad Request", { status: 400 });
		}
		const kind = parsed?.data?.type ?? "";
		if (
			parsed?.event !== "ui-mutation" ||
			!MEMBER_PUBLISHABLE_EVENT_TYPES.has(kind) ||
			!parsed.data
		) {
			return new Response("Forbidden", { status: 403 });
		}
		parsed.data.memberId = memberId ?? undefined;
		parsed.data.ts = Date.now();
		line = JSON.stringify(parsed);
	}

	const stub = env.TEAM_HUB.get(
		env.TEAM_HUB.idFromName(env.HELMOR_SANDBOX_ID ?? "helmor-team-0"),
	);
	return stub.fetch("https://team-hub/broadcast", {
		method: "POST",
		body: line,
	});
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
	/** Worker public origin, injected into the serve process as HELMOR_SYNC_URL
	 *  so the container can write session/message changes back to D1 via
	 *  PUT {syncUrl}/team/sync (Stage B data-plane mirror). Absent ⇒ no
	 *  write-through (e.g. local-dev, where the proxy mirrors directly). */
	syncUrl?: string;
}

/** A container-start failure the CF Sandbox SDK marks PERMANENT (bad image tag,
 *  resource limits, a boot that crash-loops) — retries won't fix it. We classify
 *  it so `ensureServe` FAST-FAILS with a stage-tagged error instead of burning
 *  the ~15s restore/mint + a 180s readiness poll on a backend that can't run; the
 *  Worker turns it into a structured `permanent` 503 the desktop maps to a
 *  "re-run setup" surface rather than an endless "connecting". */
/** R3-D: the cold start's backup restore failed (timeout, isolate OOM reset,
 *  R2/archive corruption). Terminal for THIS wake — route() surfaces it as a
 *  structured 503 (`ContainerRestoreFailed`) instead of silently cold-starting
 *  an empty DB against a possibly-reset DO. */
export class ContainerRestoreError extends Error {
	constructor(detail: string) {
		super(`Container backup restore failed: ${detail}`);
		this.name = "ContainerRestoreError";
	}
}

export class PermanentContainerError extends Error {
	readonly phase: string;
	constructor(phase: string, detail?: string) {
		super(
			`Container failed to start due to a permanent error (${phase}). Check the sandbox image tag + Cloudflare Containers plan/limits.${
				detail ? ` [${detail}]` : ""
			}`,
		);
		this.name = "PermanentContainerError";
		this.phase = phase;
	}
}

type ContainerProbe =
	| { state: "healthy" }
	| { state: "permanent"; phase: string; detail: string }
	| { state: "starting" };

/** Probe the container's `/v1/health` and CLASSIFY the outcome. The Sandbox SDK
 *  RETURNS (never throws) a proxied `500` with `context.phase === "startup"` for
 *  a permanent start failure, and a `503` for provisioning/transient. Reading the
 *  body lets `ensureServe` distinguish "permanently broken" (fast-fail) from
 *  "still cold-starting" (keep polling) instead of treating every non-200 as a
 *  cold start. Never throws — a network/timeout error is a transient "starting".
 *  Kept short (health-check timeout) so an asleep container just times out to
 *  "starting" while a known-failed instance returns its 500 well within it. */
async function probeContainer(
	sandbox: CloudflareSandbox,
	port: number,
	timeoutMs: number,
): Promise<ContainerProbe> {
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
		if (res.ok) return { state: "healthy" };
		return (await permanentFromResponse(res)) ?? { state: "starting" };
	} catch {
		return { state: "starting" };
	} finally {
		clearTimeout(timeout);
	}
}

/** Recognize the SDK's PERMANENT container-start error from a proxied Response
 *  (`500` + `context.phase === "startup"`, or the known message). Best-effort
 *  JSON parse; returns null for anything else (provisioning/transient/our own
 *  serve 5xx are all treated as "still starting"). */
async function permanentFromResponse(
	res: Response,
): Promise<{ state: "permanent"; phase: string; detail: string } | null> {
	if (res.status !== 500) return null;
	const body = (await res.json().catch(() => null)) as {
		message?: string;
		context?: { phase?: string; error?: string };
	} | null;
	const phase = body?.context?.phase ?? "startup";
	const message = body?.message ?? "";
	if (
		phase === "startup" ||
		message.toLowerCase().includes("permanent error")
	) {
		return { state: "permanent", phase, detail: body?.context?.error ?? "" };
	}
	return null;
}

/** WP5: whether `ensureServe` had to cold-start (vs found a warm serve). A cold
 *  start triggers a background model-catalog cache refresh — the "every wake
 *  refreshes" invalidation leg. */
export interface EnsureServeResult {
	coldStarted: boolean;
}

/** WP5 invalidation leg 2: after a cold start, re-pull the model catalog from
 *  the now-live container and upsert the D1 cache in the background, so an
 *  image update (new/removed models) is reflected after the first real wake.
 *  Best-effort — a failure just leaves the previous cache row. */
export async function refreshModelCatalog(
	sandbox: CloudflareSandbox,
	env: Env,
	port: number,
): Promise<void> {
	try {
		const res = await containerFetchThroughPort(
			sandbox,
			new Request(`http://localhost:${port}${MODEL_CATALOG_RPC}`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${env.HELMOR_COMPANION_TOKEN}`,
					"content-type": "application/json",
				},
				body: "{}",
			}),
			port,
		);
		if (!res.ok) return;
		const payload = parseModelCatalogPayload(await res.text());
		if (payload) {
			await writeModelCatalog(
				env.DB,
				env.HELMOR_SANDBOX_ID ?? "helmor-team-0",
				payload,
			);
		}
	} catch (error) {
		console.error("model-catalog refresh after wake failed", error);
	}
}

/** Belt-and-suspenders for `startProcess`, which THROWS (rather than returning a
 *  classified Response) when it hits the permanent-start error. */
function isPermanentContainerError(error: unknown): boolean {
	const m = error instanceof Error ? error.message : String(error);
	return m.toLowerCase().includes("permanent error");
}

export async function ensureServe(
	sandbox: CloudflareSandbox,
	env: Env,
	port: number,
	options: EnsureServeOptions = {},
): Promise<EnsureServeResult> {
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

	// Classify BEFORE the ~15s restore/mint: a healthy container returns; a
	// PERMANENT start failure fast-fails here (no wasted restore/mint/180s poll);
	// anything else falls through to the cold-start path below.
	const initial = await probeContainer(sandbox, port, healthCheckTimeoutMs);
	if (initial.state === "healthy") return { coldStarted: false };
	if (initial.state === "permanent") {
		throw new PermanentContainerError(initial.phase, initial.detail);
	}

	// Phase 2b sleep persistence: restore the last DB snapshot BEFORE serve binds.
	// Restore must precede serve (serve not yet running = no open handle on
	// helmor.db, safe to overwrite). A missing/failed restore is non-fatal — the
	// container cold-starts with an empty DB, like a brand-new team. Run it
	// CONCURRENTLY with the identity mints below: both must finish before
	// startProcess (the serve opens the DB + receives the tokens), but they hit
	// independent backends, so overlapping shaves the mint off the critical path.
	const restorePromise = (async () => {
		const handle = await readBackupHandle(env).catch((error) => {
			// D1 read failure: treat like "no backup" (cold-start empty) — the
			// data may still be fine on the next wake.
			console.error("Phase 2b backup-handle read failed", error);
			return null;
		});
		if (!handle) return;
		try {
			await withTimeout(
				sandbox.restoreBackup(handle),
				restoreBackupTimeoutMs,
				"restoreBackup",
			);
		} catch (error) {
			// R3-D: a FAILING restore must be LOUD, not a silent empty-DB
			// cold start. The live P0 (OBS-R3C-3) was an archive too big for
			// the DO isolate: restoreBackup OOM-reset the DO on every wake,
			// the old catch logged "cold-starting empty" and pressed on
			// against a dead DO, and the user saw an unexplained 503 loop
			// under a green "Connected". Throw typed instead — route() maps
			// it to a structured 503 so the desktop can surface "backup
			// restore failing" and readiness can degrade.
			console.error("Phase 2b restore failed", error);
			throw new ContainerRestoreError(
				error instanceof Error ? error.message : String(error),
			);
		}
	})();

	// Phase 1 token brokers: mint a fresh, short-lived Codex auth.json
	// (CODEX_AUTH_JSON) and the Claude OAuth token (CLAUDE_CODE_OAUTH_TOKEN) from
	// the team's identity DOs and inject them for THIS cold start (design §3.3 /
	// VERIFIED §1.5). Computed per startProcess — never static bindings — so a wake
	// never replays a stale token. The two mints run concurrently (independent DOs);
	// failures stay isolated (one null never sinks the other). A missing identity /
	// brick / refresh failure starts serve WITHOUT that agent's auth (it runs
	// un-authenticated until re-authorize); we log only a NON-SENSITIVE marker.
	const mintPromise = Promise.all([
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

	const [, [codexAuthJson, claudeToken]] = await Promise.all([
		restorePromise,
		mintPromise,
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
				// R2-F4a: provider SESSION STATE must live inside the backed-up
				// /home/helmor tree, or every idle-sleep destroys the threads and
				// the next same-thread turn fails with "empty response" (the
				// resume finds nothing — R2-F4, same root cause as R2-F3).
				// Both vars are first-class in their CLIs and already honored by
				// start-serve.sh's seeding paths: the codex auth.json write uses
				// $CODEX_HOME, and the Claude onboarding seed writes
				// `$CLAUDE_CONFIG_DIR/.claude.json`. HOME stays pinned to /root —
				// the VERIFIED auth env semantics (§2.6) are unchanged; only the
				// per-thread state relocates.
				CLAUDE_CONFIG_DIR: "/home/helmor/.claude",
				CODEX_HOME: "/home/helmor/.codex",
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
				// Stage B: the container POSTs session/message mirror writes to
				// PUT {HELMOR_SYNC_URL}/team/sync (companion-token-authed). Absent on
				// local-dev (the proxy mirrors directly), so the write-through is inert.
				...(options.syncUrl ? { HELMOR_SYNC_URL: options.syncUrl } : {}),
			},
		}),
		startProcessTimeoutMs,
		"startProcess",
	);

	// True per-member forge: snapshot every member's gh/glab creds from their
	// ForgeIdentity DOs and write them into the container (OUTSIDE the backed-up
	// /home tree, so plaintext tokens never land in an R2 backup). These creds are
	// needed only for a LATER git push/clone, NOT for the serve to bind — so fire
	// it WITHOUT awaiting and let it land while the readiness poll runs below,
	// rather than gating the cold start on it (~0.7s off the critical path). The
	// in-container loader reads the file lazily on the first forge op, so it's in
	// time; best-effort + timeout-bounded (so the dangling promise can't outlive
	// the request), and a failure/stall just leaves the repo-bound fallback.
	void withTimeout(
		injectForgeMembers(sandbox, env),
		FORGE_INJECT_TIMEOUT_MS,
		"forge members inject",
	).catch((error) => {
		console.error(
			"forge members inject failed",
			error instanceof Error ? error.message : "unknown",
		);
	});

	// Cold start: Xvfb + GTK/WebKit init + companion bind. Poll up to ~120s
	// (WebKitGTK init is heavy on a fresh container's first boot).
	const deadline = Date.now() + readyTimeoutMs;
	do {
		const probe = await probeContainer(sandbox, port, healthCheckTimeoutMs);
		if (probe.state === "healthy") return { coldStarted: true };
		// A container that flips to PERMANENT mid-poll won't recover — stop early
		// instead of waiting out the 180s ceiling.
		if (probe.state === "permanent") {
			throw new PermanentContainerError(probe.phase, probe.detail);
		}
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
