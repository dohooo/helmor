/**
 * Low-level JSON-RPC 2.0 handler for the Codex App Server process.
 *
 * Spawns `codex app-server` as a child process, communicates via
 * line-delimited JSON on stdin/stdout. Provides typed request/response
 * plumbing and notification/request callbacks.
 */

import {
	type ChildProcessWithoutNullStreams,
	spawn,
	spawnSync,
} from "node:child_process";
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
}

const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

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

		this.child = spawn(opts.binaryPath, ["app-server"], {
			cwd: opts.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			shell: process.platform === "win32",
		});

		this.output = readline.createInterface({ input: this.child.stdout });
		this.output.on("line", (line) => this.handleLine(line));

		this.child.stderr.on("data", (chunk: Buffer) => {
			logger.debug("codex app-server stderr", {
				data: chunk.toString().trim(),
			});
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
	if (process.platform === "win32" && child.pid !== undefined) {
		try {
			spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
				stdio: "ignore",
			});
			return;
		} catch {
			// fall through
		}
	}
	child.kill();
}
