/**
 * Low-level JSON-RPC 2.0 handler for the Codex App Server process.
 *
 * Spawns `codex app-server` as a child process, communicates via
 * line-delimited JSON on stdin/stdout. Provides typed request/response
 * plumbing and notification/request callbacks.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import readline from "node:readline";
import { logger } from "./logger.js";

// ---------------------------------------------------------------------------
// JSON-RPC types
// ---------------------------------------------------------------------------

interface PendingRequest {
	method: string;
	timeout: ReturnType<typeof setTimeout>;
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}

export interface JsonRpcNotification {
	method: string;
	params?: unknown;
}

export interface JsonRpcRequest {
	id: string | number;
	method: string;
	params?: unknown;
}

interface JsonRpcResponse {
	id: string | number;
	result?: unknown;
	error?: { code?: number; message?: string };
}

export type OnNotification = (notification: JsonRpcNotification) => void;
export type OnRequest = (request: JsonRpcRequest) => void;
export type OnExit = (code: number | null, signal: string | null) => void;
export type OnError = (error: Error) => void;

// ---------------------------------------------------------------------------
// CodexAppServer
// ---------------------------------------------------------------------------

export interface CodexAppServerOptions {
	binaryPath: string;
	cwd: string;
	onNotification: OnNotification;
	onRequest: OnRequest;
	onExit: OnExit;
	onError: OnError;
	/** Fired when Codex's own SSE retry loop emits a "Reconnecting…"
	 *  line on stderr. The manager uses this to (a) pulse a synthetic
	 *  heartbeat keeping Rust's 45s watchdog satisfied, (b) forward a
	 *  non-terminal retry notice to the UI, and (c) record a recency
	 *  timestamp so a transient {method:"error"} notification arriving
	 *  inside the retry window can be suppressed. */
	onRetry?: (message: string) => void;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const CODEX_APP_SERVER_ARGS = [
	"app-server",
	// Helmor already owns session lifecycle + UI notifications. Inheriting the
	// user's global Codex `notify` config can launch SkyComputerUseClient from
	// the bundled computer-use plugin, which crashes on some macOS versions with
	// `CODESIGNING / Launch Constraint Violation`. Disable native notify hooks
	// for Helmor's embedded app-server process only.
	"-c",
	"notify=[]",
] as const;

export function buildCodexAppServerArgs(): string[] {
	return [...CODEX_APP_SERVER_ARGS];
}

/**
 * Codex ships ripgrep next to its binary and spawns it by name on PATH for
 * in-thread search. Two layouts to support:
 *   - dev (node_modules):  <pkg>/vendor/<triple>/codex/codex
 *                          <pkg>/vendor/<triple>/path/rg          ← parent's sibling
 *   - staged (release):    dist/vendor/codex/codex
 *                          dist/vendor/codex/path/rg              ← own sibling
 */
function buildCodexEnv(binaryPath: string): NodeJS.ProcessEnv {
	const env = { ...process.env };
	const candidates = [
		join(dirname(binaryPath), "..", "path"),
		join(dirname(binaryPath), "path"),
	];
	const pathDir = candidates.find((p) => existsSync(p));
	if (pathDir) {
		const sep = process.platform === "win32" ? ";" : ":";
		env.PATH = `${pathDir}${sep}${env.PATH ?? ""}`;
	}
	return env;
}

export class CodexAppServer {
	private child: ChildProcessWithoutNullStreams;
	private output: readline.Interface;
	private pending = new Map<string, PendingRequest>();
	private nextRequestId = 1;
	private stopping = false;
	/** Active request ID for logging context. */
	private activeRequestId = "(init)";

	private onNotification: OnNotification;
	private onRequest: OnRequest;

	constructor(opts: CodexAppServerOptions) {
		this.onNotification = opts.onNotification;
		this.onRequest = opts.onRequest;

		this.child = spawn(opts.binaryPath, buildCodexAppServerArgs(), {
			cwd: opts.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env: buildCodexEnv(opts.binaryPath),
		});

		this.output = readline.createInterface({ input: this.child.stdout });
		this.output.on("line", (line) => this.handleLine(line));

		this.child.stderr.on("data", (chunk: Buffer) => {
			const text = chunk.toString();
			logger.debug("codex app-server stderr", { data: text.trim() });
			const retryMessage = extractReconnectNotice(text);
			if (retryMessage) {
				try {
					opts.onRetry?.(retryMessage);
				} catch (err) {
					logger.error("onRetry handler threw", { err: String(err) });
				}
			}
		});

		this.child.on("error", (err) => {
			if (!this.stopping) opts.onError(err);
		});

		this.child.on("exit", (code, signal) => {
			if (!this.stopping) opts.onExit(code, signal);
			this.rejectAllPending("App server process exited");
		});
	}

	// -- Public API ----------------------------------------------------------

	async sendRequest<T = unknown>(
		method: string,
		params: unknown,
		timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
	): Promise<T> {
		const id = this.nextRequestId++;
		const key = String(id);

		return new Promise<T>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(key);
				reject(new Error(`Timed out waiting for ${method}`));
			}, timeoutMs);

			this.pending.set(key, {
				method,
				timeout,
				resolve: resolve as (v: unknown) => void,
				reject,
			});

			this.writeMessage({ id, method, params });
		});
	}

	writeNotification(method: string, params?: unknown): void {
		this.writeMessage(params !== undefined ? { method, params } : { method });
	}

	/** Swap notification/request handlers without recreating the process. */
	setHandlers(onNotification: OnNotification, onRequest: OnRequest): void {
		this.onNotification = onNotification;
		this.onRequest = onRequest;
	}

	/** Set the active request ID for log context. */
	setActiveRequestId(id: string): void {
		this.activeRequestId = id;
	}

	/** Send a JSON-RPC response (for server-initiated requests like approvals). */
	sendResponse(requestId: string | number, result: unknown): void {
		this.writeMessage({ id: requestId, result });
	}

	kill(): void {
		this.stopping = true;
		this.rejectAllPending("Session stopped");
		this.output.close();
		if (!this.child.killed) {
			killChildProcess(this.child);
		}
	}

	get killed(): boolean {
		return this.child.killed;
	}

	// -- Private -------------------------------------------------------------

	private writeMessage(message: unknown): void {
		if (!this.child.stdin.writable) return;
		const json = JSON.stringify(message);
		logger.debug(`[${this.activeRequestId}] codex → stdin`, {
			data: json.length > 500 ? `${json.slice(0, 500)}…` : json,
		});
		this.child.stdin.write(`${json}\n`);
	}

	private handleLine(line: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			logger.error("Invalid JSON from codex app-server", {
				line: line.slice(0, 200),
			});
			return;
		}

		if (!parsed || typeof parsed !== "object") return;

		// Log raw App Server output — mirrors Claude's logger.sdkEvent()
		logger.sdkEvent(this.activeRequestId, parsed);

		const msg = parsed as Record<string, unknown>;

		if (isResponse(msg)) {
			this.handleResponse(msg as unknown as JsonRpcResponse);
		} else if (isRequest(msg)) {
			this.onRequest(msg as unknown as JsonRpcRequest);
		} else if (isNotification(msg)) {
			this.onNotification(msg as unknown as JsonRpcNotification);
		}
	}

	private handleResponse(response: JsonRpcResponse): void {
		const key = String(response.id);
		const pending = this.pending.get(key);
		if (!pending) return;

		clearTimeout(pending.timeout);
		this.pending.delete(key);

		if (response.error?.message) {
			pending.reject(
				new Error(`${pending.method} failed: ${response.error.message}`),
			);
		} else {
			pending.resolve(response.result);
		}
	}

	private rejectAllPending(reason: string): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timeout);
			pending.reject(new Error(reason));
		}
		this.pending.clear();
	}
}

function extractReconnectNotice(text: string): string | null {
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (/Reconnecting/i.test(trimmed)) return trimmed;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isNotification(msg: Record<string, unknown>): boolean {
	return typeof msg.method === "string" && msg.id === undefined;
}

function isRequest(msg: Record<string, unknown>): boolean {
	return typeof msg.method === "string" && msg.id !== undefined;
}

function isResponse(msg: Record<string, unknown>): boolean {
	return msg.id !== undefined && msg.method === undefined;
}

function killChildProcess(child: ChildProcessWithoutNullStreams): void {
	child.kill();
}
