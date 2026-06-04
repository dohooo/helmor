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

function companionConfig(): CompanionGlobal | null {
	if (typeof window === "undefined") return null;
	const w = window as Window & { __HELMOR_COMPANION__?: CompanionGlobal };
	return w.__HELMOR_COMPANION__ ?? null;
}

/** True only when this page is served by the companion server in a browser. */
export function isCompanionClient(): boolean {
	return !isTauriRuntime() && companionConfig() !== null;
}

// Resolved once at module load; the runtime never switches mid-session.
const COMPANION = isCompanionClient();

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
}

// Mirror Tauri's `Channel`, which is both a value (constructor) and a type.
// `api.ts` uses both forms (`new Channel<T>()` and `channel: Channel<T>`).
export type Channel<T = unknown> = TauriChannel<T>;
export const Channel = (COMPANION
	? CompanionChannel
	: TauriChannel) as unknown as typeof TauriChannel;

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

async function companionInvoke<T>(cmd: string, args?: InvokeArgs): Promise<T> {
	const record = isPlainArgs(args) ? args : undefined;

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
			await companionStream(cmd, rest, channel as CompanionChannel<unknown>);
			return undefined as T;
		}
	}

	const res = await fetch(`${baseUrl()}/rpc/${encodeURIComponent(cmd)}`, {
		method: "POST",
		headers: jsonHeaders(),
		body: JSON.stringify(record ?? args ?? {}),
	});
	if (!res.ok) throw await parseHttpError(res);
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
): Promise<void> {
	const res = await fetch(
		`${baseUrl()}/rpc-stream/${encodeURIComponent(cmd)}`,
		{
			method: "POST",
			headers: jsonHeaders(),
			body: JSON.stringify(args),
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

function dispatchEvent(name: string, payload: unknown): void {
	const set = eventListeners.get(name);
	if (!set) return;
	for (const handler of set) {
		handler({ event: name, payload });
	}
}

/** Single shared SSE connection to `/v1/stream`, reconnecting on drop. */
function ensureEventStream(): void {
	if (eventStreamStarted) return;
	eventStreamStarted = true;
	void runEventStream();
}

async function runEventStream(): Promise<void> {
	for (;;) {
		try {
			const res = await fetch(`${baseUrl()}/v1/stream`, {
				headers: authHeaders(),
			});
			if (!res.ok || !res.body) throw new Error(`stream status ${res.status}`);
			await pumpSse(res.body, dispatchEvent);
		} catch {
			// Connection dropped (backgrounded tab, network blip) — reconnect.
		}
		await delay(2000);
	}
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

/**
 * Minimal SSE frame parser: accumulates `event:` / `data:` lines and emits on
 * the blank-line frame boundary.
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
		const { done, value } = await reader.read();
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

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
