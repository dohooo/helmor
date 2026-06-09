/** Proxy `SessionManager` for Cursor. The real `@cursor/sdk` work runs in a
 * Node child process (`cursor-worker/worker.ts`) because Bun's HTTP/2 client
 * throws `NGHTTP2_FRAME_SIZE_ERROR` on the larger frames Cursor sends inside a
 * git repo, which silently breaks every tool call. Node has no such bug.
 *
 * This proxy keeps the public `SessionManager` surface identical, spawns and
 * supervises the worker, forwards calls over JSON Lines, and replays the
 * worker's emitter calls onto the real `SidecarEmitter`. */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type {
	EmitMsg,
	FromWorker,
	ToWorker,
} from "./cursor-worker/protocol.js";
import type { SidecarEmitter } from "./emitter.js";
import { errorDetails, logger } from "./logger.js";
import type {
	GenerateTitleOptions,
	ListSlashCommandsParams,
	ProviderModelInfo,
	SendMessageParams,
	SessionManager,
	SlashCommandInfo,
	UserInputResolution,
} from "./session-manager.js";

/// Resolve the Node binary that runs the worker. Release passes an absolute
/// path; dev falls back to `node` on PATH.
function resolveNodeBin(): string {
	return process.env.HELMOR_NODE_BIN_PATH?.trim() || "node";
}

/// Resolve the built worker entry. Release passes an absolute path to the
/// staged `cursor-worker.mjs`; dev derives it from the sidecar root (cwd is
/// anchored to `sidecar/`, see sidecar.rs).
function resolveWorkerPath(): string | null {
	const override = process.env.HELMOR_CURSOR_WORKER_PATH?.trim();
	if (override) return override;
	const devPath = join(process.cwd(), "dist", "cursor-worker.mjs");
	return existsSync(devPath) ? devPath : null;
}

export class CursorSessionManager implements SessionManager {
	private worker: ChildProcess | null = null;
	private nextRpcId = 0;
	/// requestId → emitter, for routing the worker's emit calls back.
	private readonly emitters = new Map<string, SidecarEmitter>();
	/// requestId → resolver for the awaiting `sendMessage` promise.
	private readonly sendWaiters = new Map<string, () => void>();
	/// rpcId → resolvers for `listModels` / `listSlashCommands` / `generateTitle`.
	private readonly rpcWaiters = new Map<
		string,
		{ resolve: (value: unknown) => void; reject: (err: Error) => void }
	>();
	/// Last key the host (UI config) pushed; replayed on every fresh worker
	/// spawn. `null` = not configured / cleared → worker errors out (no env
	/// fallback exists anymore).
	private apiKey: string | null = null;

	setApiKey(apiKey: string | null): void {
		this.apiKey = apiKey;
		// Forward to a live worker too (incl. null = cleared takes effect now).
		if (this.worker) this.send({ t: "setApiKey", apiKey });
	}

	resolveUserInput(
		_userInputId: string,
		_resolution: UserInputResolution,
	): boolean {
		// SDK auto-handles permission prompts; no waiters to resolve.
		return false;
	}

	async sendMessage(
		requestId: string,
		params: SendMessageParams,
		emitter: SidecarEmitter,
	): Promise<void> {
		if (!this.ensureWorker(emitter, requestId)) return;
		this.emitters.set(requestId, emitter);
		const done = new Promise<void>((resolve) => {
			this.sendWaiters.set(requestId, resolve);
		});
		this.send({ t: "send", requestId, params });
		await done;
	}

	async generateTitle(
		requestId: string,
		userMessage: string,
		branchRenamePrompt: string | null,
		emitter: SidecarEmitter,
		timeoutMs?: number,
		options?: GenerateTitleOptions,
	): Promise<void> {
		if (!this.ensureWorker(emitter, requestId)) {
			throw new Error("Cursor worker unavailable");
		}
		// Route the worker's `titleGenerated` emit back through `emitter`.
		this.emitters.set(requestId, emitter);
		const rpcId = this.allocRpc();
		try {
			await this.rpc(rpcId, {
				t: "title",
				rpcId,
				requestId,
				userMessage,
				branchRenamePrompt,
				timeoutMs,
				options,
			});
		} finally {
			this.emitters.delete(requestId);
		}
	}

	async listSlashCommands(
		params: ListSlashCommandsParams,
	): Promise<readonly SlashCommandInfo[]> {
		if (!this.ensureWorker()) return [];
		const rpcId = this.allocRpc();
		try {
			return (await this.rpc(rpcId, {
				t: "slash",
				rpcId,
				params,
			})) as SlashCommandInfo[];
		} catch (err) {
			logger.error(
				`cursor listSlashCommands failed: ${err instanceof Error ? err.message : String(err)}`,
				errorDetails(err),
			);
			return [];
		}
	}

	async listModels(opts?: {
		apiKey?: string;
	}): Promise<readonly ProviderModelInfo[]> {
		if (!this.ensureWorker()) throw new Error("Cursor worker unavailable");
		const rpcId = this.allocRpc();
		return (await this.rpc(rpcId, {
			t: "models",
			rpcId,
			opts,
		})) as ProviderModelInfo[];
	}

	async stopSession(sessionId: string): Promise<void> {
		if (this.worker) this.send({ t: "stop", sessionId });
	}

	async steer(): Promise<boolean> {
		// SDK has no mid-turn injection; caller queues as a new turn.
		return false;
	}

	async shutdown(): Promise<void> {
		const worker = this.worker;
		if (!worker) return;
		this.send({ t: "shutdown" });
		// Give it a beat to exit cleanly, then make sure it's gone.
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				try {
					worker.kill("SIGTERM");
				} catch {
					/* ignore */
				}
				resolve();
			}, 1000);
			worker.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
		});
	}

	// --- worker lifecycle --------------------------------------------------

	/// Spawn the worker if needed. Returns false (and reports an error on
	/// `emitter`, when given) if the worker can't be located/launched.
	private ensureWorker(emitter?: SidecarEmitter, requestId?: string): boolean {
		if (this.worker) return true;
		const workerPath = resolveWorkerPath();
		if (!workerPath) {
			const msg =
				"Cursor worker not found. Set HELMOR_CURSOR_WORKER_PATH or build sidecar/dist/cursor-worker.mjs.";
			logger.error(msg);
			if (emitter && requestId) {
				emitter.error(requestId, msg);
				emitter.end(requestId);
			}
			return false;
		}
		try {
			this.spawnWorker(workerPath);
			return true;
		} catch (err) {
			const msg = `Cursor worker failed to start: ${err instanceof Error ? err.message : String(err)}`;
			logger.error(msg, errorDetails(err));
			if (emitter && requestId) {
				emitter.error(requestId, msg);
				emitter.end(requestId);
			}
			return false;
		}
	}

	private spawnWorker(workerPath: string): void {
		const node = resolveNodeBin();
		const child = spawn(node, [workerPath], {
			stdio: ["pipe", "pipe", "pipe"],
			env: process.env,
		});
		this.worker = child;
		logger.info("Cursor worker spawned", { node, workerPath, pid: child.pid });

		const rl = createInterface({ input: child.stdout! });
		rl.on("line", (line) => this.onWorkerLine(line));

		const errRl = createInterface({ input: child.stderr! });
		errRl.on("line", (line) => {
			if (line.trim()) logger.info(`[cursor-worker] ${line}`);
		});

		child.on("error", (err) => {
			logger.error(`Cursor worker process error: ${err.message}`, {
				...errorDetails(err),
			});
			this.handleWorkerGone();
		});
		child.on("exit", (code, signal) => {
			logger.info("Cursor worker exited", { code, signal });
			this.handleWorkerGone();
		});

		// Hand the fresh worker the UI-configured key. A null (cleared / never
		// set) needs no replay — the worker defaults to null = not configured.
		if (this.apiKey !== null) {
			this.send({ t: "setApiKey", apiKey: this.apiKey });
		}
	}

	private onWorkerLine(line: string): void {
		const trimmed = line.trim();
		if (!trimmed) return;
		let msg: FromWorker;
		try {
			msg = JSON.parse(trimmed) as FromWorker;
		} catch {
			// Stray non-protocol output — log and ignore.
			logger.info(`[cursor-worker] ${trimmed}`);
			return;
		}
		switch (msg.t) {
			case "ready":
				return;
			case "log":
				logger[msg.level]?.(`[cursor-worker] ${msg.message}`);
				return;
			case "emit":
				this.replayEmit(msg.e);
				return;
			case "sendDone": {
				const waiter = this.sendWaiters.get(msg.requestId);
				this.sendWaiters.delete(msg.requestId);
				this.emitters.delete(msg.requestId);
				waiter?.();
				return;
			}
			case "rpcOk": {
				const w = this.rpcWaiters.get(msg.rpcId);
				this.rpcWaiters.delete(msg.rpcId);
				w?.resolve(msg.value);
				return;
			}
			case "rpcErr": {
				const w = this.rpcWaiters.get(msg.rpcId);
				this.rpcWaiters.delete(msg.rpcId);
				w?.reject(new Error(msg.message));
				return;
			}
		}
	}

	private replayEmit(e: EmitMsg): void {
		const emitter = e.requestId ? this.emitters.get(e.requestId) : undefined;
		if (!emitter) {
			// No live emitter (e.g. requestId === null error) — log it.
			if (e.m === "error") logger.error(`[cursor-worker] ${e.message}`);
			return;
		}
		switch (e.m) {
			case "error":
				emitter.error(e.requestId, e.message, e.internal);
				return;
			case "end":
				emitter.end(e.requestId);
				return;
			case "aborted":
				emitter.aborted(e.requestId, e.reason);
				return;
			case "passthrough":
				emitter.passthrough(e.requestId, e.message);
				return;
			case "planCaptured":
				emitter.planCaptured(e.requestId, e.toolUseId, e.plan);
				return;
			case "titleGenerated":
				emitter.titleGenerated(e.requestId, e.title, e.branchName);
				return;
		}
	}

	/// Worker died: fail every in-flight send + rpc so no stream hangs.
	private handleWorkerGone(): void {
		if (!this.worker) return;
		this.worker = null;
		for (const [requestId, emitter] of this.emitters) {
			emitter.error(requestId, "Cursor worker exited unexpectedly", true);
			emitter.end(requestId);
			this.sendWaiters.get(requestId)?.();
			this.sendWaiters.delete(requestId);
		}
		this.emitters.clear();
		for (const [, w] of this.rpcWaiters) {
			w.reject(new Error("Cursor worker exited unexpectedly"));
		}
		this.rpcWaiters.clear();
	}

	private allocRpc(): string {
		this.nextRpcId += 1;
		return `rpc-${this.nextRpcId}`;
	}

	private rpc(rpcId: string, msg: ToWorker): Promise<unknown> {
		return new Promise((resolve, reject) => {
			this.rpcWaiters.set(rpcId, { resolve, reject });
			this.send(msg);
		});
	}

	private send(msg: ToWorker): void {
		const stdin = this.worker?.stdin;
		if (!stdin) {
			logger.error("Cursor worker stdin unavailable; dropping message", {
				kind: msg.t,
			});
			return;
		}
		stdin.write(`${JSON.stringify(msg)}\n`);
	}
}
