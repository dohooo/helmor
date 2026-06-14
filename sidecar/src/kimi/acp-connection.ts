/**
 * Low-level ACP (Agent Client Protocol) connection over a `kimi acp` child.
 *
 * ACP is newline-delimited JSON-RPC 2.0 over stdio. This is the Kimi analogue
 * of `codex-app-server.ts`: one long-lived child process, typed
 * request/response plumbing, plus notification/request callbacks for the
 * agent→client direction (`session/update`, `session/request_permission`,
 * `fs/*`). `start()` is memoized + idempotent (mirrors `OpencodeServer`) and
 * performs the `initialize` handshake exactly once per live child.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { errorDetails, logger } from "../logger.js";
import { ACP_PROTOCOL_VERSION, type AcpInitializeResult } from "./acp-types.js";

interface PendingRequest {
	method: string;
	/** null = no deadline (`session/prompt` legitimately runs for minutes). */
	timeout: ReturnType<typeof setTimeout> | null;
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

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const INITIALIZE_TIMEOUT_MS = 20_000;
/** Last stderr bytes kept for diagnostics on launch/handshake/exit failures. */
const STDERR_TAIL_BYTES = 2_048;

/**
 * Resolve the `kimi` binary, the spawn target for `kimi acp`.
 *
 * Order:
 *   1. `HELMOR_KIMI_BIN_PATH` — set by the Tauri host in release builds.
 *   2. Staged dev binary at `<sidecar>/dist/vendor/kimi/<bin>` — produced by
 *      `stage-vendor` (run via `bun run dev:prepare`). Kimi ships no npm
 *      sub-package, so unlike codex/opencode there is no node_modules fallback;
 *      without this probe `bun run dev` can't find the binary.
 *   3. Bare `"kimi"` from PATH — last resort.
 */
export function resolveKimiBinPath(): string {
	const override = process.env.HELMOR_KIMI_BIN_PATH;
	if (override) return override;
	const binName = process.platform === "win32" ? "kimi.exe" : "kimi";
	// This file lives at src/kimi/, so climb two levels to the sidecar root
	// (src/kimi → src → sidecar) before descending into dist/vendor.
	const staged = join(
		dirname(fileURLToPath(import.meta.url)),
		"..",
		"..",
		"dist",
		"vendor",
		"kimi",
		binName,
	);
	if (existsSync(staged)) return staged;
	return "kimi";
}

export interface KimiAcpConnectionOptions {
	readonly onNotification: OnNotification;
	readonly onRequest: OnRequest;
	/** Fired when the shared child dies — manager settles in-flight turns. */
	readonly onExit: OnExit;
}

interface LiveChild {
	child: ChildProcessWithoutNullStreams;
	output: readline.Interface;
	initialize: AcpInitializeResult;
}

export class KimiAcpConnection {
	private readonly opts: KimiAcpConnectionOptions;
	private readonly pending = new Map<string, PendingRequest>();
	private nextRequestId = 1;
	private startPromise: Promise<LiveChild> | null = null;
	private live: LiveChild | null = null;
	private stopping = false;
	private stderrTail = "";
	/** Current turn's requestId, for sdk-event log correlation only. */
	private activeRequestId: string | null = null;

	constructor(opts: KimiAcpConnectionOptions) {
		this.opts = opts;
	}

	setActiveRequestId(requestId: string | null): void {
		this.activeRequestId = requestId;
	}

	/** Spawn + handshake once; subsequent calls reuse the live child. */
	start(): Promise<AcpInitializeResult> {
		if (this.startPromise) {
			return this.startPromise.then((h) => h.initialize);
		}
		this.stopping = false;
		this.startPromise = this.spawnAndInitialize();
		// On failure, clear the memo so the next turn can retry a fresh spawn.
		this.startPromise.catch(() => {
			this.startPromise = null;
		});
		return this.startPromise.then((h) => h.initialize);
	}

	private async spawnAndInitialize(): Promise<LiveChild> {
		const binaryPath = resolveKimiBinPath();
		const env = { ...process.env };
		// `kimi acp` opens no browser; suppress just in case an auth path tries.
		env.NO_BROWSER = env.NO_BROWSER ?? "true";

		const child = spawn(binaryPath, ["acp"], {
			cwd: process.cwd(),
			stdio: ["pipe", "pipe", "pipe"],
			env,
		});

		const output = readline.createInterface({ input: child.stdout });
		output.on("line", (line) => this.handleLine(line));
		this.stderrTail = "";
		child.stderr.on("data", (chunk: Buffer) => {
			const text = chunk.toString();
			this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_BYTES);
			logger.debug("kimi acp stderr", { data: text.trim() });
		});

		// Surface a spawn failure (e.g. `kimi` not on PATH) as a rejected start.
		const spawnError = new Promise<never>((_, reject) => {
			child.once("error", (err) => reject(err));
		});

		child.on("exit", (code, signal) => {
			this.live = null;
			this.startPromise = null;
			this.rejectAllPending(this.withStderrTail("kimi acp process exited"));
			if (!this.stopping) this.opts.onExit(code, signal);
		});

		this.live = { child, output, initialize: {} };

		const handshake = (async (): Promise<AcpInitializeResult> => {
			const result = await this.sendRequest<AcpInitializeResult>(
				"initialize",
				{
					protocolVersion: ACP_PROTOCOL_VERSION,
					clientCapabilities: {
						fs: { readTextFile: true, writeTextFile: true },
						terminal: false,
					},
					clientInfo: { name: "Helmor", version: helmorVersion() },
				},
				INITIALIZE_TIMEOUT_MS,
			);
			// Spec: the agent answers with the latest version it supports; the
			// client should disconnect on a version it doesn't speak.
			if (result?.protocolVersion !== ACP_PROTOCOL_VERSION) {
				throw new Error(
					`kimi acp answered with unsupported protocol version ${result?.protocolVersion ?? "unknown"} (expected ${ACP_PROTOCOL_VERSION})`,
				);
			}
			return result;
		})();

		try {
			const initialize = await Promise.race([handshake, spawnError]);
			if (this.live) this.live.initialize = initialize;
			return this.live ?? { child, output, initialize };
		} catch (error) {
			this.stopping = true;
			if (!child.killed) child.kill();
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(this.withStderrTail(message));
		}
	}

	get initializeResult(): AcpInitializeResult | null {
		return this.live?.initialize ?? null;
	}

	get isLive(): boolean {
		return this.live !== null;
	}

	async sendRequest<T = unknown>(
		method: string,
		params: unknown,
		timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
	): Promise<T> {
		// Fail fast on a dead/stopped child — registering a pending entry that
		// nobody will ever settle would hang the caller forever (the exit
		// handler only rejects entries that exist when the child dies).
		const child = this.live?.child;
		if (this.stopping || !child || child.killed || !child.stdin.writable) {
			throw new Error(
				this.withStderrTail(`kimi acp is not running (${method})`),
			);
		}
		const id = this.nextRequestId++;
		const key = String(id);
		return new Promise<T>((resolve, reject) => {
			const timeout =
				timeoutMs > 0
					? setTimeout(() => {
							this.pending.delete(key);
							reject(new Error(`Timed out waiting for ${method}`));
						}, timeoutMs)
					: null;
			this.pending.set(key, {
				method,
				timeout,
				resolve: resolve as (v: unknown) => void,
				reject,
			});
			this.writeMessage({ jsonrpc: "2.0", id, method, params });
		});
	}

	writeNotification(method: string, params?: unknown): void {
		this.writeMessage({
			jsonrpc: "2.0",
			method,
			...(params !== undefined ? { params } : {}),
		});
	}

	/** Answer an agent→client request (e.g. permission / fs read). */
	sendResponse(requestId: string | number, result: unknown): void {
		this.writeMessage({ jsonrpc: "2.0", id: requestId, result });
	}

	/** Reject an agent→client request with a JSON-RPC error. */
	sendError(requestId: string | number, code: number, message: string): void {
		this.writeMessage({
			jsonrpc: "2.0",
			id: requestId,
			error: { code, message },
		});
	}

	kill(): void {
		this.stopping = true;
		this.rejectAllPending("kimi acp stopped");
		const live = this.live;
		this.live = null;
		this.startPromise = null;
		if (live) {
			live.output.close();
			if (!live.child.killed) live.child.kill();
		}
	}

	private writeMessage(message: unknown): void {
		const child = this.live?.child;
		if (!child?.stdin.writable) return;
		const json = JSON.stringify(message);
		logger.debug("kimi → stdin", {
			data: json.length > 500 ? `${json.slice(0, 500)}…` : json,
		});
		child.stdin.write(`${json}\n`);
	}

	private handleLine(line: string): void {
		const trimmed = line.trim();
		if (!trimmed) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			// Tolerate the occasional non-JSON banner line; don't crash the stream.
			logger.debug("kimi acp: skipping non-JSON line", {
				line: trimmed.slice(0, 200),
			});
			return;
		}
		if (!parsed || typeof parsed !== "object") return;
		logger.sdkEvent(this.activeRequestId ?? "kimi", parsed);
		const msg = parsed as Record<string, unknown>;
		if (msg.id !== undefined && msg.method === undefined) {
			this.handleResponse(msg as unknown as JsonRpcResponse);
		} else if (typeof msg.method === "string" && msg.id !== undefined) {
			try {
				this.opts.onRequest(msg as unknown as JsonRpcRequest);
			} catch (error) {
				logger.error("kimi onRequest handler threw", errorDetails(error));
			}
		} else if (typeof msg.method === "string") {
			try {
				this.opts.onNotification(msg as unknown as JsonRpcNotification);
			} catch (error) {
				logger.error("kimi onNotification handler threw", errorDetails(error));
			}
		}
	}

	private handleResponse(response: JsonRpcResponse): void {
		const key = String(response.id);
		const pending = this.pending.get(key);
		if (!pending) return;
		if (pending.timeout) clearTimeout(pending.timeout);
		this.pending.delete(key);
		if (response.error) {
			const err = new Error(
				response.error.message || `${pending.method} failed`,
			) as Error & { code?: number };
			err.code = response.error.code;
			pending.reject(err);
		} else {
			pending.resolve(response.result);
		}
	}

	private rejectAllPending(reason: string): void {
		for (const pending of this.pending.values()) {
			if (pending.timeout) clearTimeout(pending.timeout);
			pending.reject(new Error(reason));
		}
		this.pending.clear();
	}

	/** Launch/handshake/exit failures carry the recent stderr so the user sees
	 *  WHY (`kimi` prints auth/config errors there and exits). */
	private withStderrTail(message: string): string {
		const tail = this.stderrTail.trim();
		return tail ? `${message}\n${tail}` : message;
	}
}

function helmorVersion(): string {
	return process.env.HELMOR_APP_VERSION || "0.0.0";
}
