/**
 * Transport shim for the backend IPC primitives (`invoke` / `Channel` /
 * `listen`).
 *
 * In the desktop Tauri webview (and in jsdom tests, where the suite mocks
 * `@tauri-apps/api/*`) these delegate verbatim to the real Tauri primitives —
 * behaviour is byte-for-byte unchanged.
 *
 * When the page is served by the mobile **companion** HTTP server, the same
 * frontend runs in a plain browser with no Tauri runtime. The companion server
 * injects `window.__HELMOR_COMPANION__` into the served `index.html` before the
 * app bundle loads; that marker flips these primitives onto HTTP/SSE against
 * the companion server (`/rpc/{cmd}`, `/rpc-stream/{cmd}`, `/v1/stream`).
 *
 * Why a marker and not just `!isTauriRuntime()`: jsdom is also "not Tauri", and
 * the test suite mocks `@tauri-apps/api/core`. Branching on the explicit
 * companion marker keeps every test on the mocked Tauri path.
 *
 * Only `src/lib/ipc.ts` knows about the transport. `src/lib/api.ts` imports
 * these names from here and is otherwise untouched.
 */

import {
	type InvokeArgs,
	type InvokeOptions,
	Channel as TauriChannel,
	convertFileSrc as tauriConvertFileSrc,
	invoke as tauriInvoke,
} from "@tauri-apps/api/core";
import {
	type EventCallback,
	type EventName,
	type Options as ListenOptions,
	listen as tauriListen,
	type UnlistenFn,
} from "@tauri-apps/api/event";
import {
	beginAgentStreamOpen,
	markAgentStreamOpened,
} from "./agent-stream-open";
import { isWakeCommand, LOCAL_ONLY_COMMANDS } from "./command-classes";
import {
	CompanionAsleepError,
	drainMicroWrites,
	isAsleepPayload,
	isQueueableMicroWrite,
	queueMicroWrite,
	setCompanionAsleep,
	shouldDropWhenAsleep,
} from "./companion-asleep";
import { isTauriRuntime } from "./platform";
import { getTeamConfig, isTeamModeActive } from "./team-mode";
import { reportWakeOutcome } from "./team-readiness";

export type { UnlistenFn };

// ---------------------------------------------------------------------------
// Companion detection + connection config
// ---------------------------------------------------------------------------

interface CompanionGlobal {
	/** Base origin of the companion server. Defaults to `location.origin`. */
	base?: string;
	/** Optional bootstrap token (pairing usually writes it to localStorage). */
	token?: string | null;
}

const TOKEN_KEY = "helmor.companion.pat";
// Staged (scanned-but-not-yet-confirmed) pairing token. Kept in sessionStorage,
// not localStorage, so it survives the confirm-screen reload but never becomes
// the active credential until the user explicitly confirms — and is dropped
// when the tab closes.
const PENDING_KEY = "helmor.companion.pending";

function companionConfig(): CompanionGlobal | null {
	if (typeof window === "undefined") return null;
	const w = window as Window & { __HELMOR_COMPANION__?: CompanionGlobal };
	return w.__HELMOR_COMPANION__ ?? null;
}

/** True only when this page is served by the companion server in a browser. */
export function isCompanionClient(): boolean {
	return !isTauriRuntime() && companionConfig() !== null;
}

// ---------------------------------------------------------------------------
// Transport mode (runtime-switchable for the desktop team ↔ local axis only)
// ---------------------------------------------------------------------------
//
// Replaces the former frozen `COMPANION` / `TEAM` / `REMOTE` module consts. The
// desktop-local path and the browser-companion path stay BYTE-EQUIVALENT to the
// old consts at a cold boot — `companion` is still resolved exactly once (a
// browser can never become a Tauri runtime, so it never changes), and `team` /
// `remote` start with the same value the old consts had. Only the *desktop
// TEAM* dimension becomes mutable: `applyTransportSwitch()` flips it in place so
// switching team ↔ local takes effect for subscriptions created after the
// switch, with NO `window.location.reload`.

interface TransportState {
	/** Browser served by the companion server. Resolved ONCE at module load —
	 *  a browser can never become a Tauri runtime, so this never changes. */
	readonly companion: boolean;
	/** Desktop Tauri app pointing at a remote Worker. MUTABLE: flipped by
	 *  {@link recomputeTransportMode} when the user switches, with no reload. */
	team: boolean;
	/** Derived: any remote HTTP transport. Recomputed whenever `team` flips. */
	remote: boolean;
}

const transport: TransportState = (() => {
	const companion = isCompanionClient();
	const team = isTauriRuntime() && isTeamModeActive();
	return { companion, team, remote: companion || team };
})();

/**
 * Re-derive `team` + `remote` from the current localStorage flag. Called by
 * {@link applyTransportSwitch} AFTER the switch action has persisted config +
 * flipped the mode flag. No-op in a companion browser (there is no local
 * transport to toggle to — `companion` is fixed remote).
 */
function recomputeTransportMode(): void {
	if (transport.companion) return; // browser companion is fixed remote
	transport.team = isTauriRuntime() && isTeamModeActive();
	transport.remote = transport.companion || transport.team;
}

// On first companion load, a pairing link may carry the token in the URL hash
// (`#pair=<token>`). Persist it, then strip it so the secret doesn't linger in
// history or get shared.
if (transport.companion && typeof window !== "undefined") {
	stagePairingFromHash();
	syncCompanionCookie();
	// A pairing link opened in the *same* tab (e.g. pasted into the address bar)
	// only changes the hash — the SPA never reloads, so `stagePairingFromHash`
	// (which runs once at module load) would never see it. Reload on a pairing
	// hash so module init re-runs and the confirm screen appears, for every
	// navigation mode rather than only a fresh tab.
	window.addEventListener("hashchange", () => {
		if (/(?:^#|&)(?:pair|token)=/.test(window.location.hash)) {
			window.location.reload();
		}
	});
}

/**
 * Handle a pairing token carried in the URL hash (`#pair=<token>`).
 *
 * Token lifecycle:
 *   scanned (in URL) ──▶ staged (sessionStorage, URL KEPT) ──▶ confirmed
 *   (localStorage, URL consumed).  Commit happens in {@link confirmCompanionPairing}.
 *
 * Two deliberate choices, both important — please don't "simplify" them back:
 *
 * 1. We do NOT strip the hash on load. The token stays in the address bar while
 *    the confirm screen is shown, so the user can "Add to Home Screen" right
 *    then and the saved shortcut keeps the full `#pair=<token>` URL. Re-opening
 *    that shortcut re-enters pairing (or goes straight in — see #2) without the
 *    token having to survive in some other storage. The hash is consumed only
 *    once the token is actually committed: on confirm, or here when we find
 *    we're already paired with it.
 *    Trade-off (intentional, user-chosen): the token then lives in that saved
 *    URL. Fine for a personal device; the risk is only that the saved address,
 *    if screenshotted/forwarded, lets someone else pair.
 *
 * 2. If localStorage already holds this exact token, there's nothing to confirm:
 *    strip the hash and let the app boot authenticated. This is what makes a
 *    saved home-screen shortcut tap *straight* into the app after the first
 *    pairing, instead of re-prompting every single time.
 *
 * Forward-looking — the eventual native shell:
 *   This `#pair=<token>` URL is also the intended deep-link contract for a future
 *   native (React Native) Helmor app whose main content area is a single WebView.
 *   The plan: scanning a code opens that app directly; the app hands the
 *   `#pair=` URL to its WebView, which pairs through exactly this code path. In
 *   a WebView there's only one storage context (no Safari-vs-standalone split),
 *   so this gets simpler, not harder. Keeping the token in the URL — rather than
 *   stripping it at load — is precisely what lets the deep link carry the token
 *   inward. So: do NOT move the strip back to load time.
 */
function stagePairingFromHash(): void {
	const match = window.location.hash.match(/(?:^#|&)(?:pair|token)=([^&]+)/);
	if (!match) return;
	const token = decodeURIComponent(match[1]);
	try {
		if (localStorage.getItem(TOKEN_KEY) === token) {
			// Already paired with this exact token — nothing to confirm. Consume
			// the hash and let the app boot authed from localStorage.
			stripPairingHash();
			return;
		}
		// Not yet paired: stage for the confirm screen, but leave the token in
		// the URL so an "Add to Home Screen" now captures it (see #1 above).
		sessionStorage.setItem(PENDING_KEY, token);
	} catch {
		// Storage unavailable; the confirm screen just won't appear.
	}
}

/** Remove the `#pair=`/`#token=` fragment from the live URL (keeps path + query). */
function stripPairingHash(): void {
	const clean = window.location.pathname + window.location.search;
	window.history.replaceState(null, "", clean);
}

/** The scanned-but-unconfirmed pairing token, if any. */
export function getPendingPairingToken(): string | null {
	if (!transport.companion) return null;
	try {
		return sessionStorage.getItem(PENDING_KEY);
	} catch {
		return null;
	}
}

/**
 * Commit the staged pairing token as the active credential and reload into the
 * authenticated app. Invoked by the confirm screen's button. This is the only
 * place the token in the URL is "consumed" for a fresh pairing — see
 * {@link stagePairingFromHash} for why we wait until here.
 */
export function confirmCompanionPairing(): void {
	const token = getPendingPairingToken();
	if (!token) return;
	try {
		localStorage.setItem(TOKEN_KEY, token);
		sessionStorage.removeItem(PENDING_KEY);
	} catch {
		// Storage unavailable — the reload below just re-prompts.
	}
	// Consume the token from the *live* URL now that it's committed. A home-screen
	// shortcut saved earlier keeps its own copy of the `#pair=` URL, so this only
	// cleans the current session — re-opening the shortcut still works (and, being
	// already paired now, skips straight in).
	stripPairingHash();
	window.location.reload();
}

/**
 * Mirror the PAT into a same-origin cookie so `<img src="/v1/asset?…">` requests
 * authenticate — an `<img>` element can't send an `Authorization` header. The
 * PAT is `hlm_<base64url>`, which is cookie-value-safe (no `;` / `=`).
 */
function syncCompanionCookie(): void {
	const token = authToken();
	if (!token) return;
	try {
		// biome-ignore lint/suspicious/noDocumentCookie: Cookie Store API is unsupported in Safari (iPhone); document.cookie is the cross-browser path.
		document.cookie = `helmor_companion_pat=${token}; path=/; SameSite=Strict`;
	} catch {
		// Cookies unavailable (rare embedded contexts) — `<img>` assets just
		// won't load; everything else still works via the localStorage token.
	}
}

function baseUrl(): string {
	// Team mode targets the configured Worker URL directly.
	if (transport.team) return getTeamConfig()?.url ?? "";
	const configured = companionConfig()?.base;
	if (configured) return configured.replace(/\/$/, "");
	return typeof location !== "undefined" ? location.origin : "";
}

function authToken(): string | null {
	// Team mode authenticates with the manually entered team token.
	if (transport.team) return getTeamConfig()?.token || null;
	try {
		if (typeof localStorage !== "undefined") {
			const stored = localStorage.getItem(TOKEN_KEY);
			if (stored) return stored;
		}
	} catch {
		// localStorage can throw in some embedded contexts; fall through.
	}
	return companionConfig()?.token ?? null;
}

function authHeaders(): Record<string, string> {
	const token = authToken();
	return token ? { Authorization: `Bearer ${token}` } : {};
}

// ---------------------------------------------------------------------------
// Companion auth state
// ---------------------------------------------------------------------------
//
// A browser with no pairing token — or a stale/revoked one — gets 401 on every
// `/rpc` call. Without a gate the app boots into the onboarding flow (which
// renders demo workspaces), so an unpaired visitor sees fake data instead of a
// reason. Track auth state here, where every request already passes, and let
// the shell render a dedicated "pair this browser" screen instead.

type CompanionAuthState = "ok" | "unknown" | "unauthed";

function initialCompanionAuthState(): CompanionAuthState {
	// Native desktop is always authed; a companion browser with no token can't
	// be, so skip the doomed request round-trip and gate immediately. The
	// browser "pair this device" gate is companion-only — desktop team mode
	// validates its token via the Settings health check, not this gate — so we
	// key on `companion`, never `team`.
	if (!transport.companion) return "ok";
	return authToken() ? "unknown" : "unauthed";
}

let companionAuthState: CompanionAuthState = initialCompanionAuthState();
const companionAuthListeners = new Set<() => void>();

function setCompanionAuthState(next: CompanionAuthState): void {
	if (companionAuthState === next) return;
	companionAuthState = next;
	for (const listener of companionAuthListeners) listener();
}

/** Current companion auth state. Always `"ok"` in the native desktop runtime. */
export function getCompanionAuthState(): CompanionAuthState {
	return companionAuthState;
}

/** Subscribe to companion auth-state changes (for `useSyncExternalStore`). */
export function subscribeCompanionAuth(listener: () => void): () => void {
	companionAuthListeners.add(listener);
	return () => {
		companionAuthListeners.delete(listener);
	};
}

// ---------------------------------------------------------------------------
// Connection state (remote transports only)
// ---------------------------------------------------------------------------
//
// A team / companion sandbox can go to sleep; the next request wakes it via a
// cold start the Worker blocks on (~120s) while it restores from R2 and serves.
// During that window the shared `/v1/stream` SSE channel ({@link runEventStream})
// drops and keeps retrying. We surface that as a *loading* state — never an
// error and never a local fallback — so the shell can show a banner instead of
// a frozen UI. Mirrors the {@link CompanionAuthState} store idiom.
//
// Three states:
//   "online"       — a stream is open; the shell shows real data.
//   "connecting"   — a fresh entry into a remote transport (the user just
//                    switched to team, or a companion tab just loaded). The new
//                    Worker is presumed cold; the banner shows "Connecting to
//                    your team workspace…" up front, before the first connect.
//   "reconnecting" — a previously-online stream dropped and is retrying (a
//                    sleeping sandbox cold-starting mid-session, a network blip).
// Both non-online states render the loading banner; only the copy differs.

export type CompanionConnectionState = "online" | "connecting" | "reconnecting";

let companionConnectionState: CompanionConnectionState = "online";
const companionConnectionListeners = new Set<() => void>();

function setCompanionConnectionState(next: CompanionConnectionState): void {
	if (companionConnectionState === next) return;
	companionConnectionState = next;
	for (const listener of companionConnectionListeners) listener();
}

/**
 * Current transport connection state. Always `"online"` on a native (non-remote)
 * transport — {@link runEventStream} only runs under a remote transport, so the
 * desktop Tauri path never flips this.
 */
export function getCompanionConnectionState(): CompanionConnectionState {
	return companionConnectionState;
}

/** Subscribe to connection-state changes (for `useSyncExternalStore`). */
export function subscribeCompanionConnection(listener: () => void): () => void {
	companionConnectionListeners.add(listener);
	return () => {
		companionConnectionListeners.delete(listener);
	};
}

/** True when the request transport is a remote HTTP one (team mode or a
 *  browser companion). Lets team-gated UI render only where reconnect can
 *  actually happen; single-user / native desktop is always `false`. Reads the
 *  LIVE transport, so it reflects an in-place team↔local switch immediately. */
export function isRemoteTransport(): boolean {
	return transport.remote;
}

function jsonHeaders(): Record<string, string> {
	return { "Content-Type": "application/json", ...authHeaders() };
}

/** R3-A wake-intent marker. Only requests carrying this header may cold-start
 *  the container or renew its idle timer (the Worker enforces both gates);
 *  everything else observes for free. Cost governance, not a security
 *  boundary — the member token already authenticates the caller. */
export const WAKE_INTENT_HEADER = "X-Helmor-Wake-Intent";

/** Headers for a `/rpc` / `/rpc-stream` request: JSON + auth, plus the
 *  wake-intent marker when the registry (or an explicit call-site override)
 *  says this command is allowed to spend money. */
function rpcHeaders(cmd: string, wakeIntent?: boolean): Record<string, string> {
	const wake = wakeIntent ?? isWakeCommand(cmd);
	return wake ? { ...jsonHeaders(), [WAKE_INTENT_HEADER]: "1" } : jsonHeaders();
}

/**
 * Parse a non-OK HTTP response into the `{ code, message }` shape the frontend
 * expects from native IPC errors (see `src/lib/errors.ts#extractError`).
 */
async function parseHttpError(res: Response): Promise<unknown> {
	const text = await res.text().catch(() => "");
	if (text) {
		try {
			return JSON.parse(text);
		} catch {
			return { code: "Unknown", message: text };
		}
	}
	return { code: "Unknown", message: `Request failed (${res.status})` };
}

// ---------------------------------------------------------------------------
// Channel
// ---------------------------------------------------------------------------

/**
 * Browser stand-in for Tauri's `Channel`. Structurally compatible with how
 * `api.ts` uses it (`new Channel<T>()` + assigning `.onmessage`). When passed
 * to {@link invoke} in companion mode it is detected and upgraded to a
 * streaming request.
 */
class CompanionChannel<T = unknown> {
	onmessage: ((message: T) => void) | null = null;
	/**
	 * Aborts the underlying streaming `fetch`, if this channel was routed to a
	 * `/rpc-stream` endpoint. Set by {@link companionInvoke}. Closing the fetch
	 * is what tells the server the client disconnected (so it frees the
	 * subscription) AND releases the browser's per-origin connection slot — a
	 * long-lived stream that is never aborted leaks a connection, and once the
	 * ~6-connection cap is hit new streams hang forever. Native Tauri channels
	 * don't carry this; {@link closeChannel} no-ops on them.
	 */
	close: (() => void) | null = null;
}

/**
 * Tear down a streaming subscription's transport. On a companion channel this
 * aborts the underlying `fetch` (freeing the server subscription + the browser
 * connection slot); on a native Tauri channel it's a no-op (the matching
 * `unsubscribe_*` command owns native teardown). Call this from any `api.ts`
 * unlisten that opened a long-lived stream.
 */
export function closeChannel(channel: unknown): void {
	if (channel instanceof CompanionChannel) {
		channel.close?.();
	}
}

// Mirror Tauri's `Channel`, which is both a value (constructor) and a type.
// `api.ts` uses both forms (`new Channel<T>()` and `channel: Channel<T>`).
export type Channel<T = unknown> = TauriChannel<T>;

/**
 * A constructor Proxy that picks the concrete Channel class at `new` time from
 * the LIVE transport mode — not at module load. This is what lets an in-place
 * transport switch (team ↔ local) take effect for streaming subscriptions
 * created AFTER the switch, with no reload: before the switch
 * `new Channel<T>()` returns a real `TauriChannel`; after a switch into a remote
 * transport it returns a `CompanionChannel`.
 *
 * On the NATIVE Tauri path the construct trap returns
 * `Reflect.construct(TauriChannel, args)`, which is observably identical to
 * `new TauriChannel(...args)`: with no `newTarget` argument, `Reflect.construct`
 * uses the target constructor itself as `new.target`, so the produced instance
 * has `TauriChannel.prototype` and the constructor sees the same `this`. The
 * Rust streaming round-trip snapshots (`pipeline_streams.rs`) are the contract
 * check that this stays byte-equivalent.
 *
 * `instanceof` against this Proxy still works (the default `getPrototypeOf` /
 * `has` traps forward to the target `TauriChannel`), but every internal check in
 * this module tests `value instanceof CompanionChannel` against the concrete
 * class directly, so they are unaffected by the Proxy.
 *
 * Why a Proxy and not `export let Channel` reassigned on switch: `export const`
 * can't be reassigned, and `export let` live-binding semantics across the
 * `import { Channel }` boundary are bundler-fragile. The Proxy is the minimal,
 * robust choice.
 */
export const Channel = new Proxy(TauriChannel, {
	construct(_target, args) {
		const Ctor = transport.remote ? CompanionChannel : TauriChannel;
		return Reflect.construct(Ctor as new (...a: unknown[]) => object, args);
	},
}) as unknown as typeof TauriChannel;

/**
 * Convert a local file path to a webview-loadable asset URL.
 *
 * In the Tauri webview this is the real `convertFileSrc`. In the companion
 * browser there is no Tauri asset protocol — and the real implementation reads
 * `window.__TAURI_INTERNALS__` SYNCHRONOUSLY and THROWS when it's absent, which
 * (called during render, e.g. avatars) tears down the whole React tree into a
 * blank screen. So return an empty string: the `<img>` renders blank instead of
 * crashing. (Streaming desktop files to the phone would need a companion asset
 * endpoint; until then these images just don't load.)
 */
export function convertFileSrc(filePath: string, protocol?: string): string {
	if (!transport.remote) return tauriConvertFileSrc(filePath, protocol);
	// Serve the file through the companion's restricted `/v1/asset` endpoint
	// (avatar / generated-image / paste-cache dirs only). The PAT cookie set in
	// `syncCompanionCookie` authenticates the `<img>` request. Files outside
	// those dirs (e.g. workspace images) 403 and render blank — no crash.
	if (!filePath) return "";
	return `${baseUrl()}/v1/asset?path=${encodeURIComponent(filePath)}`;
}

/**
 * Convert a path that is known to live on THIS desktop machine.
 *
 * Desktop team mode is remote for app commands, but local-only commands such
 * as `cache_forge_avatar` still return local filesystem paths. Those must be
 * served through Tauri's local asset protocol, not through the team Worker.
 */
export function convertLocalFileSrc(
	filePath: string,
	protocol?: string,
): string {
	if (isTauriRuntime()) return tauriConvertFileSrc(filePath, protocol);
	return convertFileSrc(filePath, protocol);
}

// ---------------------------------------------------------------------------
// invoke
// ---------------------------------------------------------------------------

/**
 * Commands that ALWAYS run on the local Tauri backend, even in team/companion
 * mode (e.g. `authorize_cloud_codex_identity` runs `codex login` on THIS Mac;
 * the query-cache trio is desktop disk state; local-llm is this Mac's llama.cpp).
 * R3-A: derived from the wake-intent registry — `src/lib/command-classes.ts`
 * is the single source of truth (per-command reasons live there). Keep the
 * dispatch-absent subset in sync with `LOCAL_ONLY` in
 * `src-tauri/tests/companion_dispatch_coverage.rs`.
 */
const LOCAL_ONLY_INVOKES = LOCAL_ONLY_COMMANDS;

/** Tauri's `InvokeOptions` plus the R3-A escape hatch: a PASSIVE-classified
 *  command explicitly upgraded to wake for one call (e.g. a user-facing
 *  refresh button on data that is normally observed for free). */
export type HelmorInvokeOptions = Partial<InvokeOptions> & {
	wakeIntent?: boolean;
};

export function invoke<T>(
	cmd: string,
	args?: InvokeArgs,
	options?: HelmorInvokeOptions,
): Promise<T> {
	if (!transport.remote || (isTauriRuntime() && LOCAL_ONLY_INVOKES.has(cmd))) {
		// Preserve the original call arity so tests asserting
		// `invoke).toHaveBeenCalledWith("cmd")` (no trailing undefineds) keep
		// matching. `wakeIntent` is remote-transport metadata — never Tauri's.
		const { wakeIntent: _wakeIntent, ...tauriOptions } = options ?? {};
		if (options !== undefined && "headers" in tauriOptions) {
			return tauriInvoke<T>(cmd, args, tauriOptions as InvokeOptions);
		}
		if (args !== undefined) return tauriInvoke<T>(cmd, args);
		return tauriInvoke<T>(cmd);
	}
	return companionInvoke<T>(cmd, args, options?.wakeIntent);
}

async function companionInvoke<T>(
	cmd: string,
	args?: InvokeArgs,
	wakeIntent?: boolean,
): Promise<T> {
	const record = isPlainArgs(args) ? args : undefined;

	// UI-mutation subscription rides the SHARED, reconnecting `/v1/stream` SSE
	// (which emits `ui-mutation` events) instead of a one-shot `/rpc-stream`
	// subscription. The rpc-stream had no reconnect and the proxy idle-closes it
	// after ~10s, so workspace-state events (e.g. finalize) were silently dropped
	// and the composer stayed gated. `/v1/stream` already keepalive-pings and the
	// loop reconnects, so events keep flowing.
	if (cmd === "subscribe_ui_mutations" && record) {
		const channel = Object.values(record).find(
			(value) => value instanceof CompanionChannel,
		) as CompanionChannel<unknown> | undefined;
		if (channel) {
			const unlisten = companionListen("ui-mutation", (event) => {
				channel.onmessage?.(event.payload);
			});
			channel.close = () => void unlisten.then((un) => un());
			return undefined as T;
		}
	}
	// The matching teardown: the listener was already dropped via
	// `closeChannel` → `channel.close`, so there's nothing to unsubscribe
	// server-side (the SSE body drop auto-unsubscribes the UiSyncManager).
	if (cmd === "unsubscribe_ui_mutations") return undefined as T;

	// A `Channel` argument means this is a streaming command — route it to the
	// streaming endpoint and resolve once the stream closes.
	if (record) {
		const channelEntry = Object.entries(record).find(
			([, value]) => value instanceof CompanionChannel,
		);
		if (channelEntry) {
			const [, channel] = channelEntry;
			const chan = channel as CompanionChannel<unknown>;
			const rest = Object.fromEntries(
				Object.entries(record).filter(
					([, value]) => !(value instanceof CompanionChannel),
				),
			);
			// Wire an AbortController so the subscription can close its fetch on
			// teardown (see `closeChannel`). Without this, every stream leaks a
			// connection until the per-origin cap stalls all new streams.
			const controller = new AbortController();
			chan.close = () => controller.abort();
			// WP8: expose the open as a per-session signal so the streaming footer
			// can flip "Waking the container…" → "Thinking…" the moment the
			// container accepts the turn (well before the first token).
			// NOTE: the UI keys sessions by the HELMOR session id
			// (`request.helmorSessionId`) — `request.sessionId` is the PROVIDER
			// session id and can be null on a fresh session.
			const isAgentStream = cmd === "send_agent_message_stream";
			const agentSessionId = isAgentStream
				? (rest as { request?: { helmorSessionId?: unknown } }).request
						?.helmorSessionId
				: undefined;
			if (typeof agentSessionId === "string") {
				beginAgentStreamOpen(agentSessionId);
			}
			// WP2: AWAIT the stream OPEN (HTTP status), bounded by a client timeout.
			// A non-2xx (e.g. 503 "serve host not ready") or a wedged open now
			// REJECTS to the caller instead of being swallowed, so use-streaming's
			// catch can roll the message back to a draft + surface the error. The
			// @agent open waits on ensureServe (normally ~6s; the Worker's own
			// ceiling is 180s) — but we never block unbounded: openCompanionStream
			// aborts + rejects a retryable error after STREAM_OPEN_TIMEOUT_MS.
			const body = await openCompanionStream(cmd, rest, controller);
			if (typeof agentSessionId === "string") {
				markAgentStreamOpened(agentSessionId);
			}
			// Open OK → pump the body in the BACKGROUND (mirroring Tauri's immediate
			// invoke resolve). A mid-stream drop (throw) synthesizes a NON-persisted
			// terminal error event (aligned with the api.ts watchdog) so the
			// dispatcher clears `sending` + surfaces it — never a silent stall. An
			// abort is teardown (closeChannel), not a failure.
			// Only the agent stream always terminates with a done/error event; room
			// chat closes silently on success (its Update goes to the hub), so don't
			// synthesize a "closed early" error for it.
			let sawTerminal = false;
			void pumpNdjson(body, (event) => {
				const kind = (event as { kind?: string }).kind;
				if (kind === "done" || kind === "aborted" || kind === "error") {
					sawTerminal = true;
				}
				chan.onmessage?.(event);
			})
				.then(() => {
					if (controller.signal.aborted) return;
					// R2-A: a watch stream whose body closed WITHOUT teardown died
					// silently (edge drop, container sleep). Tell the subscriber
					// (api.ts subscribeSessionStream) so it can resubscribe —
					// otherwise a watching client stops receiving teammates' turns
					// with zero signal. Internal marker, never rendered.
					if (cmd === "subscribe_session_stream") {
						chan.onmessage?.({ kind: "watchClosed" });
						return;
					}
					// Body closed WITHOUT a terminal event → the container-side task
					// failed / ended abnormally (the agent run errored and dropped the
					// channel). Synthesize a NON-persisted terminal error so the
					// dispatcher clears `sending` + surfaces it, instead of waiting out
					// the api.ts first-event watchdog.
					if (sawTerminal || !isAgentStream) {
						return;
					}
					chan.onmessage?.({
						kind: "error",
						message:
							"The message stream ended before completing. Please try again.",
						persisted: false,
						internal: false,
					});
				})
				.catch((error) => {
					if (controller.signal.aborted) return;
					// R2-A: a mid-stream watch failure is the same silent death as a
					// clean close — signal resubscribe instead of surfacing an error.
					if (cmd === "subscribe_session_stream") {
						chan.onmessage?.({ kind: "watchClosed" });
						return;
					}
					chan.onmessage?.({
						kind: "error",
						message: streamErrorMessage(error),
						persisted: false,
						internal: false,
					});
				});
			return undefined as T;
		}
	}

	// R3-D: is this request allowed to (and expected to) wake the sandbox?
	// Its outcome feeds the readiness wake-health counter — the catalog probe
	// alone can report "Connected" over a container that can't start.
	const isWakeRequest = wakeIntent ?? isWakeCommand(cmd);
	let res: Response;
	try {
		res = await fetch(`${baseUrl()}/rpc/${encodeURIComponent(cmd)}`, {
			method: "POST",
			headers: rpcHeaders(cmd, wakeIntent),
			body: JSON.stringify(record ?? args ?? {}),
		});
	} catch (error) {
		if (isWakeRequest) reportWakeOutcome(false);
		throw error;
	}
	if (!res.ok) {
		// The browser "pair this device" gate is companion-only; a team-mode
		// 401 surfaces as a normal error (the Settings health check is the
		// place to validate the token), not the pairing screen.
		if (res.status === 401 && transport.companion)
			setCompanionAuthState("unauthed");
		const error = await parseHttpError(res);
		// R3-D: a WAKE request that came back 5xx means the container failed
		// to start for us (restore failure, permanent error, not-ready) —
		// feed the readiness wake-health counter. 4xx (auth/validation) says
		// nothing about container health.
		if (isWakeRequest && res.status >= 500) {
			reportWakeOutcome(
				false,
				typeof (error as { message?: unknown })?.message === "string"
					? (error as { message: string }).message
					: undefined,
			);
		}
		// R3-A typed asleep: a PASSIVE request while the sandbox sleeps. Reads
		// throw the typed error (React Query: no retry, keep previous data);
		// micro-writes queue for replay on the next wake; ephemeral signals
		// (presence) drop — replaying them stale would be wrong.
		if (isAsleepPayload(error)) {
			setCompanionAsleep(true);
			if (shouldDropWhenAsleep(cmd)) return undefined as T;
			if (isQueueableMicroWrite(cmd) && isPlainArgs(record)) {
				queueMicroWrite(cmd, record);
				return undefined as T;
			}
			throw new CompanionAsleepError();
		}
		throw error;
	}
	setCompanionAuthState("ok");
	if (isWakeRequest) reportWakeOutcome(true);
	// Any successful container answer proves it is awake: clear the staleness
	// indicator and replay queued micro-writes (guarded against re-entry — a
	// replay that finds the sandbox asleep again just re-queues).
	setCompanionAsleep(false);
	flushMicroWrites();
	const text = await res.text();
	return (text ? JSON.parse(text) : undefined) as T;
}

/** Replay the asleep micro-write queue. Sequential + re-entrancy-guarded so a
 *  burst of successful responses triggers exactly one replay pass, and the
 *  replays' own successes don't recurse. */
let flushingMicroWrites = false;
function flushMicroWrites(): void {
	if (flushingMicroWrites) return;
	const queued = drainMicroWrites();
	if (queued.length === 0) return;
	flushingMicroWrites = true;
	void (async () => {
		try {
			for (const { cmd, args } of queued) {
				// Still PASSIVE: a replay must never wake the sandbox. If it went
				// back to sleep mid-flush, companionInvoke re-queues the rest.
				await companionInvoke(cmd, args).catch(() => {});
			}
		} finally {
			flushingMicroWrites = false;
		}
	})();
}

function isPlainArgs(args?: InvokeArgs): args is Record<string, unknown> {
	return (
		typeof args === "object" &&
		args !== null &&
		!Array.isArray(args) &&
		!(args instanceof ArrayBuffer) &&
		!(args instanceof Uint8Array)
	);
}

/** Client-side bound on the stream OPEN. A cold @agent open waits on the
 *  Worker's ensureServe (normally ~6s; its own ceiling is 180s) — we never block
 *  the caller unbounded: after this we abort the fetch + reject a retryable error
 *  so the message rolls back to a draft and the user can retry. */
const STREAM_OPEN_TIMEOUT_MS = 30_000;

/**
 * POST a streaming command and AWAIT only the OPEN (HTTP status), bounded by
 * {@link STREAM_OPEN_TIMEOUT_MS}. Returns the response body for the caller to
 * pump in the background. Throws on a non-2xx open OR the client timeout, so the
 * caller can reject to ITS caller instead of swallowing a failed stream start
 * (WP2).
 */
async function openCompanionStream(
	cmd: string,
	args: Record<string, unknown>,
	controller: AbortController,
): Promise<ReadableStream<Uint8Array>> {
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, STREAM_OPEN_TIMEOUT_MS);
	try {
		// Per-pipe wake polarity (R3-A): the OPEN request's header decides the
		// whole pipe. A turn stream (`send_agent_message_stream`, WAKE) renews
		// the container's idle timer while bytes flow; a watch stream
		// (`subscribe_session_stream`, PASSIVE) is forwarded but NEVER renews —
		// its 30s keepalives only feed the corpse watchdog, so watching a
		// session is free and the sandbox sleeps on schedule.
		const res = await fetch(
			`${baseUrl()}/rpc-stream/${encodeURIComponent(cmd)}`,
			{
				method: "POST",
				headers: rpcHeaders(cmd),
				body: JSON.stringify(args),
				signal: controller.signal,
			},
		);
		if (!res.ok || !res.body) {
			const error = await parseHttpError(res);
			if (isAsleepPayload(error)) {
				setCompanionAsleep(true);
				throw new CompanionAsleepError();
			}
			throw error;
		}
		// A successful open proves the container is awake (a WAKE pipe may have
		// just cold-started it) — clear staleness + replay queued micro-writes.
		setCompanionAsleep(false);
		flushMicroWrites();
		return res.body;
	} catch (error) {
		if (timedOut) {
			throw new Error(
				"The cloud sandbox didn't respond in time — it may still be waking up. Please try again.",
			);
		}
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

/** Normalize a stream-pump failure into a user-facing message (never the
 *  `[object Object]` you get from stringifying a plain IPC error object). */
function streamErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	return "The message stream was interrupted. Please try again.";
}

// ---------------------------------------------------------------------------
// listen (backend → frontend events)
// ---------------------------------------------------------------------------

type CompanionEventHandler = (event: {
	event: string;
	payload: unknown;
}) => void;
const eventListeners = new Map<string, Set<CompanionEventHandler>>();

// The shared SSE loop is cancellable + re-startable so an in-place transport
// switch can kill the old loop (bound to the old `baseUrl()`/`authToken()`) and
// start a fresh one against the new backend. `eventStreamController` is the
// abort handle for the live loop (null when no loop is running);
// `eventStreamGeneration` is a monotonic guard so a late-resolving fetch from a
// torn-down loop can't flip connection state or reopen a stream after teardown.
let eventStreamController: AbortController | null = null;
let eventStreamGeneration = 0;

export function listen<T>(
	event: EventName,
	handler: EventCallback<T>,
	options?: ListenOptions,
): Promise<UnlistenFn> {
	if (!transport.remote) return tauriListen<T>(event, handler, options);
	return companionListen(event, handler as CompanionEventHandler);
}

function companionListen(
	event: string,
	handler: CompanionEventHandler,
): Promise<UnlistenFn> {
	let set = eventListeners.get(event);
	if (!set) {
		set = new Set();
		eventListeners.set(event, set);
	}
	set.add(handler);
	ensureEventStream();
	const unlisten: UnlistenFn = () => {
		eventListeners.get(event)?.delete(handler);
	};
	return Promise.resolve(unlisten);
}

function dispatchEvent(name: string, payload: unknown): void {
	const set = eventListeners.get(name);
	if (!set) return;
	for (const handler of set) {
		handler({ event: name, payload });
	}
}

/** Single shared SSE connection to `/v1/stream`, reconnecting on drop. Started
 *  lazily by the first `companionListen`; re-armed by the next `companionListen`
 *  from the remounted tree after {@link teardownEventStream}. */
function ensureEventStream(): void {
	if (eventStreamController) return; // already running for the current transport
	startEventStream();
}

function startEventStream(): void {
	const controller = new AbortController();
	eventStreamController = controller;
	const generation = ++eventStreamGeneration;
	void runEventStream(controller.signal, generation);
}

/**
 * Tear down the live SSE loop: abort its in-flight fetch (cancelling the
 * long-lived ~120s cold-start request instead of orphaning it) and stop its
 * retry loop. Idempotent. Called by {@link applyTransportSwitch} before
 * repointing the transport. Bumping the generation makes any in-flight
 * `runEventStream` iteration that races past the abort check exit on its next
 * guard, so it can't reopen a stream or flip connection state after teardown.
 */
function teardownEventStream(): void {
	eventStreamController?.abort();
	eventStreamController = null;
	eventStreamGeneration++;
}

/**
 * Idle-suspend the shared `/v1/stream` (TEAM transport only) so a remote sandbox
 * can idle-sleep while the app is hidden/idle. Drops the SSE WITHOUT surfacing
 * the reconnecting banner — it's an intentional pause, not a drop. No-op on the
 * native transport (no companion stream) or when already suspended. Listeners
 * are preserved, so {@link resumeEventStream} reconnects in place.
 */
export function suspendEventStream(): void {
	if (!transport.remote || !eventStreamController) return;
	// R2-E: the TEAM transport's event plane is the hibernating TeamHub
	// WebSocket — it never touches (or wakes) the container, so dropping it on
	// idle-suspend saves nothing and costs everything: it is the ONLY free
	// wake-up signal while the sandbox sleeps (a teammate's turn arrives as
	// `activeStreamsChanged` over this socket and re-attaches the watch).
	// Keep it. Container-bound streams/polls are suspended elsewhere
	// (focusManager pause + companion-suspend watch detach).
	if (transport.team) return;
	teardownEventStream();
	setCompanionConnectionState("online");
}

/**
 * Resume the shared `/v1/stream` after {@link suspendEventStream} (e.g. the
 * window regained focus). The wake cold-start surfaces the normal reconnecting
 * banner. No-op on the native transport.
 */
export function resumeEventStream(): void {
	if (!transport.remote) return;
	ensureEventStream();
}

// Reconnect backoff: full-jitter exponential, base 1s, ×2 per attempt, capped
// at 30s. No attempt ceiling — a sleeping sandbox legitimately takes ~120s to
// cold-start (the `fetch` itself blocks that long inside the Worker's
// `ensureServe`), so giving up would be wrong. The backoff only paces the gap
// *between* attempts; `attempt` resets to 0 the moment a stream (re)opens.
const RECONNECT_BASE_MS = 1000;
const RECONNECT_CEIL_MS = 30000;

function reconnectDelayMs(attempt: number): number {
	const windowMs = Math.min(
		RECONNECT_CEIL_MS,
		RECONNECT_BASE_MS * 2 ** attempt,
	);
	return Math.random() * windowMs;
}

// Team-mode event transport: a single shared WebSocket to the Worker's `/v1/ws`,
// relayed by the hibernating TeamHub Durable Object, so an open connection no
// longer pins the compute container. (The phone-companion browser keeps the SSE
// path — it talks to the desktop's own companion server, which has no TeamHub.)
const TEAM_WS_MARKER = "helmor.v1";
const WS_PING = JSON.stringify({ t: "ping" });
const WS_PING_INTERVAL_MS = 20_000;

/**
 * Open the team event WebSocket and pump messages into {@link dispatchEvent}
 * until it closes. Resolves on a clean close, rejects on error/abort — both
 * drive the reconnect loop in {@link runEventStream}. The bearer rides the WS
 * subprotocol (browsers can't set Authorization); the hub echoes the marker.
 */
function pumpWebSocket(
	signal: AbortSignal,
	isCurrent: () => boolean,
	onOpen: () => void,
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (signal.aborted) {
			reject(new Error("aborted"));
			return;
		}
		const url = `${baseUrl().replace(/^http/, "ws")}/v1/ws`;
		const ws = new WebSocket(url, [TEAM_WS_MARKER, authToken() ?? ""]);
		let settled = false;
		let pinger: ReturnType<typeof setInterval> | undefined;
		let awaitingPong = false;
		const closeQuietly = () => {
			try {
				ws.close();
			} catch {
				/* already closed */
			}
		};
		const finish = (run: () => void) => {
			if (settled) return;
			settled = true;
			if (pinger) clearInterval(pinger);
			signal.removeEventListener("abort", onAbort);
			run();
		};
		function onAbort() {
			closeQuietly();
			finish(() => reject(new Error("aborted")));
		}
		signal.addEventListener("abort", onAbort, { once: true });

		ws.onopen = () => {
			// A teardown that raced the open must not flip state or keep the socket.
			if (!isCurrent()) {
				closeQuietly();
				return;
			}
			onOpen();
			// Liveness: ping every interval; the hub auto-replies `pong` WITHOUT
			// waking from hibernation. A missing pong by the next tick ⇒ dead → close
			// → reconnect (parity with the old SSE stall watchdog).
			pinger = setInterval(() => {
				if (awaitingPong) {
					closeQuietly();
					return;
				}
				awaitingPong = true;
				try {
					ws.send(WS_PING);
				} catch {
					closeQuietly();
				}
			}, WS_PING_INTERVAL_MS);
		};
		ws.onmessage = (event: MessageEvent) => {
			if (typeof event.data !== "string") return;
			const msg = safeJson(event.data) as {
				event?: string;
				data?: unknown;
				t?: string;
			} | null;
			if (msg?.t === "pong") {
				awaitingPong = false;
				return;
			}
			// Drop-in with the old SSE frame: `{event, data}` → dispatchEvent.
			if (msg && typeof msg.event === "string") {
				dispatchEvent(msg.event, msg.data);
			}
		};
		ws.onclose = () => finish(() => resolve());
		ws.onerror = () => {
			closeQuietly();
			finish(() => reject(new Error("websocket error")));
		};
	});
}

/**
 * Phone-companion transport: open the desktop companion server's `/v1/stream`
 * SSE and pump frames into {@link dispatchEvent}. Same signature as
 * {@link pumpWebSocket} so {@link runEventStream} can pick either by transport.
 */
async function pumpServerSentEvents(
	signal: AbortSignal,
	isCurrent: () => boolean,
	onOpen: () => void,
): Promise<void> {
	const res = await fetch(`${baseUrl()}/v1/stream`, {
		headers: authHeaders(),
		signal,
	});
	if (!isCurrent()) return; // switched away while the fetch resolved
	if (!res.ok || !res.body) {
		if (res.status === 401 && transport.companion) {
			setCompanionAuthState("unauthed");
		}
		throw new Error(`stream status ${res.status}`);
	}
	onOpen();
	// `pumpSse` returns on a clean close too, not only on throw — both are a
	// "drop" that must trigger a reconnect.
	await pumpSse(res.body, dispatchEvent);
}

async function runEventStream(
	signal: AbortSignal,
	generation: number,
): Promise<void> {
	// True while this loop owns the connection state: a torn-down loop must not
	// flip `online`/`reconnecting` on the new transport, so every state write is
	// gated on `isCurrent()` (signal + generation) checked AFTER each await.
	const isCurrent = () =>
		!signal.aborted && generation === eventStreamGeneration;
	let attempt = 0;
	for (;;) {
		if (!isCurrent()) return;
		try {
			// Team mode rides the hibernating TeamHub WebSocket (so the container
			// stays asleep); the phone-companion browser talks to the desktop's own
			// companion server, which only serves SSE. Both resolve on a clean drop
			// and reject on error/abort → back off + reconnect. `onOpen` clears the
			// connecting/reconnecting state + resets backoff when the connection opens.
			const pump = transport.team ? pumpWebSocket : pumpServerSentEvents;
			await pump(signal, isCurrent, () => {
				setCompanionConnectionState("online");
				attempt = 0;
			});
		} catch {
			// Connection dropped (sleeping sandbox cold start, backgrounded tab,
			// network blip) — fall through to back off and reconnect. A switch-away
			// aborts the fetch, which lands here too: exit silently.
			if (!isCurrent()) return;
		}
		if (!isCurrent()) return;
		// We only reach here after a drop (throw or clean return). Surface the
		// loading state on the first drop — not on the initial healthy connect,
		// which would flash the banner — then wait out the jittered backoff.
		setCompanionConnectionState("reconnecting");
		await delay(reconnectDelayMs(attempt), signal);
		if (!isCurrent()) return;
		attempt += 1;
	}
}

// ---------------------------------------------------------------------------
// In-place transport switch (team ↔ local, no reload)
// ---------------------------------------------------------------------------

/**
 * Drop every companion event handler. The remounting app subtree re-registers
 * fresh handlers via `companionListen` as its effects mount, so this isn't
 * strictly required (the remount churns handlers). We do it defensively so a
 * handler from a component that fails to unmount cleanly can't survive the
 * switch and double-fire against the new transport's stream.
 */
function resetCompanionListeners(): void {
	eventListeners.clear();
}

/**
 * Repoint the live transport after the team-mode flag + config have been
 * persisted to localStorage (by `switchTeamMode` in `team-mode.ts`). Keeping the
 * transport mutation inside `ipc.ts` preserves this module's invariant that only
 * it knows about the transport.
 *
 * Order:
 *   1. Tear down the old SSE loop (abort its fetch, stop its retries) and drop
 *      companion listeners.
 *   2. Recompute the transport mode from the now-updated localStorage flag.
 *   3. Reset companion auth state for the new transport (native is always "ok";
 *      a fresh team backend hasn't been probed, but team mode doesn't use the
 *      pairing gate so it resolves "ok" too).
 *   4. Seed the connection state: "connecting" when switching INTO a remote
 *      transport (the new Worker is presumed cold — the shell shows the loading
 *      banner immediately, before the remounted tree's first SSE connect),
 *      "online" when switching to local (synchronous native backend, no wait).
 *
 * Native ↔ native is impossible (companion is fixed remote); this only ever
 * flips the desktop team axis. The caller bumps the remount generation AFTER
 * this returns, so the remounted subtree reads the already-updated transport.
 */
export function applyTransportSwitch(): void {
	teardownEventStream();
	resetCompanionListeners();
	recomputeTransportMode();
	companionAuthState = initialCompanionAuthState();
	for (const listener of companionAuthListeners) listener();
	// WP1: entering a remote transport always seeds "connecting" — the
	// team-readiness probe (team-switch.ts) decides ready vs degraded, so a stale
	// config or a previously-established team can no longer skip the connect check
	// (the "instant connect" of S1). Local is synchronous → "online".
	setCompanionConnectionState(transport.remote ? "connecting" : "online");
}

// ---------------------------------------------------------------------------
// Stream parsing helpers
// ---------------------------------------------------------------------------

async function pumpNdjson(
	body: ReadableStream<Uint8Array>,
	onEvent: (event: unknown) => void,
): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let newline = buffer.indexOf("\n");
		while (newline !== -1) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (line) onEvent(safeJson(line));
			newline = buffer.indexOf("\n");
		}
	}
	const tail = buffer.trim();
	if (tail) onEvent(safeJson(tail));
}

/** No SSE bytes for this long means the connection is dead even if the OS
 *  hasn't surfaced a TCP error yet — the server pings every ~15s, so a longer
 *  gap is a silent drop. pumpSse cancels + throws so runEventStream flips to
 *  `reconnecting` promptly instead of waiting out a (possibly minutes-long)
 *  TCP timeout.
 *
 *  CONTRACT: that ~15s cadence is the companion server's keepalive (Rust
 *  `server.rs` `/v1/stream`). This is the PHONE-companion transport only — team
 *  mode rides the TeamHub WebSocket. Keep this comfortably above the upstream
 *  ping interval or healthy streams false-trip a reconnect. */
const SSE_STALL_TIMEOUT_MS = 22_000;

/**
 * Minimal SSE frame parser: accumulates `event:` / `data:` lines and emits on
 * the blank-line frame boundary. Used by the phone-companion transport (the
 * desktop's own companion server serves SSE); team mode uses the WebSocket.
 */
async function pumpSse(
	body: ReadableStream<Uint8Array>,
	onEvent: (name: string, payload: unknown) => void,
): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let eventName = "message";
	let data = "";

	const flush = () => {
		if (data) onEvent(eventName, safeJson(data));
		eventName = "message";
		data = "";
	};

	for (;;) {
		// Heartbeat watchdog: no bytes for SSE_STALL_TIMEOUT_MS (> the ~15s server
		// ping interval) means the stream is dead even without a TCP error. Cancel
		// the reader (closes the connection) and throw so runEventStream reconnects.
		let stallTimer: ReturnType<typeof setTimeout> | undefined;
		let chunk: Awaited<ReturnType<typeof reader.read>>;
		try {
			chunk = await Promise.race([
				reader.read(),
				new Promise<never>((_, reject) => {
					stallTimer = setTimeout(
						() => reject(new Error("sse heartbeat stall")),
						SSE_STALL_TIMEOUT_MS,
					);
				}),
			]);
		} catch (error) {
			await reader.cancel().catch(() => {});
			throw error;
		} finally {
			clearTimeout(stallTimer);
		}
		const { done, value } = chunk;
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let newline = buffer.indexOf("\n");
		while (newline !== -1) {
			const rawLine = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			const line = rawLine.replace(/\r$/, "");
			if (line === "") {
				flush();
			} else if (line.startsWith("event:")) {
				eventName = line.slice(6).trim();
			} else if (line.startsWith("data:")) {
				data += line.slice(5).trim();
			}
			// `:` comment lines (keep-alive pings) are ignored.
			newline = buffer.indexOf("\n");
		}
	}
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

/**
 * A `setTimeout` Promise that also short-circuits on abort, so a transport
 * teardown completes promptly instead of waiting out a (possibly 30s) reconnect
 * backoff. Resolves (never rejects) on either the timer or the abort.
 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const id = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(id);
				resolve();
			},
			{ once: true },
		);
	});
}
