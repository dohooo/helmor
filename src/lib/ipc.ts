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
 * app bundle loads; that marker flips these primitives onto HTTP/WebSocket
 * against the companion server (`/rpc/{cmd}`, `/rpc-stream/{cmd}`, `/v1/ws`).
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
import { isTauriRuntime } from "./platform";

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

function isNativeCompanionWebView(): boolean {
	if (typeof window === "undefined") return false;
	const w = window as Window & { __HELMOR_NATIVE_APP__?: unknown };
	return w.__HELMOR_NATIVE_APP__ !== undefined;
}

/** True only when this page is served by the companion server in a browser. */
export function isCompanionClient(): boolean {
	return !isTauriRuntime() && companionConfig() !== null;
}

// Resolved once at module load; the runtime never switches mid-session.
const COMPANION = isCompanionClient();

// On first companion load, a pairing link may carry the token in the URL hash
// (`#pair=<token>`). Persist it, then strip it so the secret doesn't linger in
// history or get shared.
if (COMPANION && typeof window !== "undefined") {
	installCompanionCryptoRandomUUIDFallback();
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

function installCompanionCryptoRandomUUIDFallback(): void {
	if (
		typeof crypto !== "undefined" &&
		typeof crypto.randomUUID === "function"
	) {
		return;
	}

	const randomUUID =
		(): `${string}-${string}-${string}-${string}-${string}` => {
			const bytes = new Uint8Array(16);
			if (
				typeof crypto !== "undefined" &&
				typeof crypto.getRandomValues === "function"
			) {
				crypto.getRandomValues(bytes);
			} else {
				for (let index = 0; index < bytes.length; index += 1) {
					bytes[index] = Math.floor(Math.random() * 256);
				}
			}
			bytes[6] = (bytes[6] & 0x0f) | 0x40;
			bytes[8] = (bytes[8] & 0x3f) | 0x80;
			const hex = Array.from(bytes, (byte) =>
				byte.toString(16).padStart(2, "0"),
			).join("");
			return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
		};

	try {
		if (typeof crypto !== "undefined") {
			Object.defineProperty(crypto, "randomUUID", {
				configurable: true,
				value: randomUUID,
			});
		}
	} catch {
		// If the host exposes a sealed Crypto object, calls that require
		// `crypto.randomUUID` will still fail and surface through WebView logs.
	}
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
		if (isNativeCompanionWebView()) {
			// The React Native shell already parsed and verified the pairing link
			// before loading this WebView, so there is no extra browser-confirm
			// step here. Commit immediately and boot the companion app.
			localStorage.setItem(TOKEN_KEY, token);
			sessionStorage.removeItem(PENDING_KEY);
			stripPairingHash();
			return;
		}
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
	if (!COMPANION) return null;
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
	const configured = companionConfig()?.base;
	if (configured) return configured.replace(/\/$/, "");
	return typeof location !== "undefined" ? location.origin : "";
}

function authToken(): string | null {
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
	// be, so skip the doomed request round-trip and gate immediately.
	if (!COMPANION) return "ok";
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

function jsonHeaders(): Record<string, string> {
	return { "Content-Type": "application/json", ...authHeaders() };
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
export const Channel = (COMPANION
	? CompanionChannel
	: TauriChannel) as unknown as typeof TauriChannel;

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
	if (!COMPANION) return tauriConvertFileSrc(filePath, protocol);
	// Serve the file through the companion's restricted `/v1/asset` endpoint
	// (avatar / generated-image / paste-cache dirs only). The PAT cookie set in
	// `syncCompanionCookie` authenticates the `<img>` request. Files outside
	// those dirs (e.g. workspace images) 403 and render blank — no crash.
	if (!filePath) return "";
	return `${baseUrl()}/v1/asset?path=${encodeURIComponent(filePath)}`;
}

// ---------------------------------------------------------------------------
// invoke
// ---------------------------------------------------------------------------

export function invoke<T>(
	cmd: string,
	args?: InvokeArgs,
	options?: InvokeOptions,
): Promise<T> {
	if (!COMPANION) {
		// Preserve the original call arity so tests asserting
		// `invoke).toHaveBeenCalledWith("cmd")` (no trailing undefineds) keep
		// matching.
		if (options !== undefined) return tauriInvoke<T>(cmd, args, options);
		if (args !== undefined) return tauriInvoke<T>(cmd, args);
		return tauriInvoke<T>(cmd);
	}
	return companionInvoke<T>(cmd, args);
}

function findCompanionChannel(
	record: Record<string, unknown>,
): CompanionChannel<unknown> | null {
	for (const value of Object.values(record)) {
		if (value instanceof CompanionChannel) {
			return value as CompanionChannel<unknown>;
		}
	}
	return null;
}

async function companionInvoke<T>(cmd: string, args?: InvokeArgs): Promise<T> {
	const record = isPlainArgs(args) ? args : undefined;

	// Passive live-update subscriptions ride the shared, reconnecting /v1/ws
	// WebSocket (multiplexed by event name) instead of a dedicated /rpc-stream
	// fetch, which never reconnects — the root cause of "mobile stops updating
	// after a background/lock". They attach a handler to the multiplexer and
	// return immediately, mirroring Tauri's fire-and-forget Channel semantics.
	if (
		record &&
		(cmd === "subscribe_ui_mutations" || cmd === "subscribe_session_stream")
	) {
		const channel = findCompanionChannel(record);
		if (channel) {
			if (cmd === "subscribe_ui_mutations") {
				const handler: CompanionPayloadHandler = (payload) =>
					channel.onmessage?.(payload);
				uiMutationHandlers.add(handler);
				channel.close = () => uiMutationHandlers.delete(handler);
				ensureEventStream();
				return undefined as T;
			}
			const sessionId =
				typeof record.sessionId === "string" ? record.sessionId : null;
			if (sessionId) {
				let set = sessionHandlers.get(sessionId);
				if (!set) {
					set = new Set();
					sessionHandlers.set(sessionId, set);
				}
				const handlerSet = set;
				const handler: CompanionPayloadHandler = (payload) =>
					channel.onmessage?.(payload);
				handlerSet.add(handler);
				channel.close = () => {
					handlerSet.delete(handler);
					if (handlerSet.size === 0) sessionHandlers.delete(sessionId);
					// Last watcher gone → drop `?watch=` so the server frees the
					// session mirror (the socket keeps running for ui-mutation).
					if (sessionHandlers.size === 0) setWatchedSession(null);
				};
				setWatchedSession(sessionId);
				return undefined as T;
			}
		}
	}
	// The matching unsubscribes are no-ops here: teardown already ran via
	// closeChannel(onEvent) -> channel.close. Swallow so no /rpc request fires.
	if (
		cmd === "unsubscribe_ui_mutations" ||
		cmd === "unsubscribe_session_stream"
	) {
		return undefined as T;
	}

	// A `Channel` argument means this is a streaming command — route it to the
	// streaming endpoint and resolve once the stream closes.
	if (record) {
		const channelEntry = Object.entries(record).find(
			([, value]) => value instanceof CompanionChannel,
		);
		if (channelEntry) {
			const [, channel] = channelEntry;
			const rest = Object.fromEntries(
				Object.entries(record).filter(
					([, value]) => !(value instanceof CompanionChannel),
				),
			);
			// Wire an AbortController so the subscription can close its fetch on
			// teardown (see `closeChannel`). Without this, every stream leaks a
			// connection until the per-origin cap stalls all new streams.
			const controller = new AbortController();
			(channel as CompanionChannel<unknown>).close = () => controller.abort();
			// Tauri's invoke resolves immediately while the channel emits
			// asynchronously — mirror that. Failures (e.g. a streaming endpoint
			// not wired yet) degrade to "no events" rather than rejecting.
			void companionStream(
				cmd,
				rest,
				channel as CompanionChannel<unknown>,
				controller.signal,
			).catch(() => {});
			return undefined as T;
		}
	}

	const res = await fetch(`${baseUrl()}/rpc/${encodeURIComponent(cmd)}`, {
		method: "POST",
		headers: jsonHeaders(),
		body: JSON.stringify(record ?? args ?? {}),
	});
	if (!res.ok) {
		if (res.status === 401) setCompanionAuthState("unauthed");
		throw await parseHttpError(res);
	}
	setCompanionAuthState("ok");
	const text = await res.text();
	return (text ? JSON.parse(text) : undefined) as T;
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

/**
 * POST a streaming command and feed each newline-delimited JSON event to the
 * channel's `onmessage`, resolving when the stream closes.
 */
async function companionStream(
	cmd: string,
	args: Record<string, unknown>,
	channel: CompanionChannel<unknown>,
	signal?: AbortSignal,
): Promise<void> {
	const res = await fetch(
		`${baseUrl()}/rpc-stream/${encodeURIComponent(cmd)}`,
		{
			method: "POST",
			headers: jsonHeaders(),
			body: JSON.stringify(args),
			signal,
		},
	);
	if (!res.ok || !res.body) throw await parseHttpError(res);

	await pumpNdjson(res.body, (event) => {
		channel.onmessage?.(event);
	});
}

// ---------------------------------------------------------------------------
// listen (backend → frontend events)
// ---------------------------------------------------------------------------

type CompanionEventHandler = (event: {
	event: string;
	payload: unknown;
}) => void;
const eventListeners = new Map<string, Set<CompanionEventHandler>>();
let eventStreamStarted = false;

// --- Companion live-update multiplexer -------------------------------------
//
// The single reconnecting `/v1/ws` WebSocket carries every passive live-update
// feed, demultiplexed by each frame's `event` field: `ui-mutation` (cache
// invalidations, always), `session` (the watched session's live turn, gated by
// `?watch=`), `hello` (each (re)connect — drives resync), `ping` (keep-alive).
// `subscribe_ui_mutations` / `subscribe_session_stream` attach here instead of
// opening their own non-reconnecting `/rpc-stream` fetch. WebSocket (not SSE)
// because cloudflare quick tunnels buffer streaming HTTP responses indefinitely.
type CompanionPayloadHandler = (payload: unknown) => void;
const uiMutationHandlers = new Set<CompanionPayloadHandler>();
const sessionHandlers = new Map<string, Set<CompanionPayloadHandler>>();
const streamReconnectListeners = new Set<() => void>();
/** Session the NEXT socket open should request via `?watch=` (null → none). */
let watchedSessionId: string | null = null;
/** Watch target the CURRENTLY-OPEN socket was opened for. `session` frames route
 *  by this (not `watchedSessionId`), so a frame in flight during a session
 *  switch can never be delivered to the newly-selected session's handler. */
let activeConnectionWatch: string | null = null;
/** Closes the in-flight `/v1/ws` socket to force an immediate reconnect. */
let currentStreamAbort: AbortController | null = null;
let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
let companionStreamListenersBound = false;
// Server pings every 15s; missing ~2 means the link is silently dead (a frozen
// mobile tab whose fetch never errors) — force a reconnect.
const STREAM_WATCHDOG_MS = 35_000;

export function listen<T>(
	event: EventName,
	handler: EventCallback<T>,
	options?: ListenOptions,
): Promise<UnlistenFn> {
	if (!COMPANION) return tauriListen<T>(event, handler, options);
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

/**
 * Subscribe to companion stream (re)connects. The callback fires on every
 * `hello` frame — i.e. each time the shared `/v1/ws` connection (re)establishes —
 * so callers can backfill state missed while disconnected (the stream carries
 * no `Last-Event-ID` replay). Companion-only: on the desktop Tauri runtime this
 * returns an inert unsubscribe and never fires.
 */
export function onCompanionStreamReconnect(callback: () => void): () => void {
	if (!COMPANION) return () => {};
	streamReconnectListeners.add(callback);
	return () => {
		streamReconnectListeners.delete(callback);
	};
}

function dispatchEvent(name: string, payload: unknown): void {
	// Any frame — including `ping`/`hello` — proves the link is alive.
	noteStreamFrame();
	if (name === "hello") {
		// (Re)connect handshake: backfill anything missed while disconnected.
		for (const listener of streamReconnectListeners) listener();
		return;
	}
	if (name === "ui-mutation") {
		for (const handler of uiMutationHandlers) handler(payload);
		return;
	}
	if (name === "session") {
		const set = activeConnectionWatch
			? sessionHandlers.get(activeConnectionWatch)
			: undefined;
		if (set) for (const handler of set) handler(payload);
		return;
	}
	if (name === "ping") return;
	// Legacy named-event path (e.g. the `listen()` consumers). Unchanged.
	const set = eventListeners.get(name);
	if (!set) return;
	for (const handler of set) {
		handler({ event: name, payload });
	}
}

/** Single shared WebSocket to `/v1/ws`, reconnecting on drop. */
function ensureEventStream(): void {
	if (eventStreamStarted) return;
	eventStreamStarted = true;
	bindCompanionStreamListeners();
	void runEventStream();
}

function wsStreamUrl(): string {
	// `https://…` → `wss://…`, `http://…` → `ws://…`. A browser WebSocket can't
	// set an Authorization header, so the companion authenticates this via the
	// same-origin `helmor_companion_pat` cookie (set in `syncCompanionCookie`).
	const base = `${baseUrl().replace(/^http/, "ws")}/v1/ws`;
	return watchedSessionId
		? `${base}?watch=${encodeURIComponent(watchedSessionId)}`
		: base;
}

/** Point the stream at a different watched session (or null to clear). */
function setWatchedSession(sessionId: string | null): void {
	if (watchedSessionId === sessionId) return;
	watchedSessionId = sessionId;
	if (eventStreamStarted) {
		// Already streaming with the old `?watch=` — reconnect to apply the new
		// one (the deliberate abort skips the backoff, so it reopens at once).
		currentStreamAbort?.abort();
	} else {
		// Not streaming yet — open directly with the new `?watch=`.
		ensureEventStream();
	}
}

async function runEventStream(): Promise<void> {
	for (;;) {
		const abort = new AbortController();
		currentStreamAbort = abort;
		// Snapshot which session THIS connection serves so `session` frames route
		// correctly even while a switch is mid-flight.
		activeConnectionWatch = watchedSessionId;
		try {
			await openCompanionSocket(abort.signal);
		} catch {
			// Dropped / aborted (session switch, visibility, watchdog, network
			// blip) — reconnect.
		}
		clearStreamWatchdog();
		// A deliberate abort (switch / forced reconnect) skips the backoff so the
		// new connection attaches immediately; genuine failures back off.
		if (!abort.signal.aborted) await delay(2000);
	}
}

/**
 * Open one `/v1/ws` WebSocket and resolve when it closes (or when `signal`
 * aborts, which closes it — the deliberate-reconnect path used by session
 * switch / watchdog / visibility). WebSocket, not SSE/fetch, because cloudflare
 * quick tunnels buffer long-lived streaming HTTP responses but pass WebSocket
 * frames live. Each text frame is a `{ event, data }` envelope routed by name.
 */
function openCompanionSocket(signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		let socket: WebSocket;
		try {
			socket = new WebSocket(wsStreamUrl());
		} catch {
			resolve();
			return;
		}
		const onAbort = () => socket.close();
		signal.addEventListener("abort", onAbort);
		socket.onopen = () => noteStreamFrame(); // arm the watchdog once connected
		socket.onmessage = (event) => {
			if (typeof event.data !== "string") return;
			const frame = safeJson(event.data);
			if (frame && typeof frame === "object" && "event" in frame) {
				const { event: name, data } = frame as { event: string; data: unknown };
				dispatchEvent(name, data);
			}
		};
		socket.onerror = () => socket.close();
		socket.onclose = () => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		};
	});
}

// --- Reconnect robustness: watchdog + visibility/online triggers -----------

function noteStreamFrame(): void {
	if (watchdogTimer) clearTimeout(watchdogTimer);
	watchdogTimer = setTimeout(forceStreamReconnect, STREAM_WATCHDOG_MS);
}

function clearStreamWatchdog(): void {
	if (watchdogTimer) {
		clearTimeout(watchdogTimer);
		watchdogTimer = null;
	}
}

function forceStreamReconnect(): void {
	// Aborting the in-flight fetch makes runEventStream loop and reopen at once.
	currentStreamAbort?.abort();
}

function reconnectStreamIfVisible(): void {
	if (
		typeof document === "undefined" ||
		document.visibilityState === "visible"
	) {
		forceStreamReconnect();
	}
}

/** Bind visibility/focus/online reconnect triggers once. The mobile failure
 *  mode is a frozen tab whose fetch never errors; returning to it (or regaining
 *  network) must proactively rebuild the stream. */
function bindCompanionStreamListeners(): void {
	if (companionStreamListenersBound || typeof window === "undefined") return;
	companionStreamListenersBound = true;
	document.addEventListener("visibilitychange", reconnectStreamIfVisible);
	window.addEventListener("focus", reconnectStreamIfVisible);
	window.addEventListener("online", forceStreamReconnect);
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

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
