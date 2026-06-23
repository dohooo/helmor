// Owns ONE long-lived `<bin> serve` child + its SDK client (HTTP/SSE) for an
// opencode-protocol provider (opencode, or any protocol-compatible fork that
// keeps the same server/SDK protocol). Shared across all of that provider's
// sessions; the global SSE stream is demuxed by `sessionID` in the manager.
// Spawned ourselves (not the SDK helper) so we own the process group for tree
// kill.

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2";
import { errorDetails, logger } from "../logger.js";

const execFileAsync = promisify(execFile);

const STARTUP_TIMEOUT_MS = 20_000;
const HOSTNAME = "127.0.0.1";

/** Everything that differs between opencode and a protocol-compatible fork
 *  at the server-process layer. See `opencode.ts` for the instance. */
export interface ProtocolServerConfig {
	/** Provider id — log prefix and session-DB subdir (`<id>/<id>.db`). */
	readonly id: string;
	/** stdout line prefix that signals the server is ready
	 *  (e.g. "opencode server listening"). */
	readonly readyPrefix: string;
	/** Release env var holding the bundled binary path
	 *  (e.g. HELMOR_OPENCODE_BIN_PATH). */
	readonly binEnvVar: string;
	/** npm platform sub-package for a `darwin-arm64`-style suffix
	 *  (e.g. s => `opencode-${s}`). */
	readonly platformPkg: (platformShort: string) => string;
	/** Binary basename inside the platform package and on PATH. */
	readonly binName: string;
	/** Env var the server reads its API password from. */
	readonly passwordEnvVar: string;
	/** Env var overriding the server's session-DB path. */
	readonly dbEnvVar: string;
	/** Basic-auth username the server expects (e.g. opencode: "opencode"). */
	readonly authUsername: string;
}

function platformShort(): string {
	const arch = process.arch === "x64" ? "x64" : "arm64";
	if (process.platform === "darwin") return `darwin-${arch}`;
	if (process.platform === "linux") return `linux-${arch}`;
	if (process.platform === "win32") return `win32-${arch}`;
	return "";
}

// Resolution order: `config.binEnvVar` (release) → node_modules platform
// sub-package (dev/test) → `config.binName` on PATH.
export function resolveBinPath(config: ProtocolServerConfig): string {
	const override = process.env[config.binEnvVar];
	if (override) return override;
	const platformPkg = config.platformPkg(platformShort());
	try {
		const require = createRequire(import.meta.url);
		const pkgJson = require.resolve(`${platformPkg}/package.json`);
		const binName =
			process.platform === "win32" ? `${config.binName}.exe` : config.binName;
		const candidate = join(dirname(pkgJson), "bin", binName);
		if (existsSync(candidate)) return candidate;
	} catch {
		// Platform sub-package missing — fall through.
	}
	return config.binName;
}

// Session DB MUST be isolated from the user's global install: its schema
// migrates forward and a newer-written DB is unwritable by our bundled binary.
// (auth.json + the provider's jsonc config stay shared.) Parent of
// HELMOR_LOG_DIR is the Helmor data dir; fall back to home for
// standalone/test runs.
function resolveDbPath(id: string): string {
	const logDir = process.env.HELMOR_LOG_DIR;
	const base = logDir ? dirname(logDir) : join(homedir(), ".helmor");
	return join(base, id, `${id}.db`);
}

function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.unref();
		srv.on("error", reject);
		srv.listen(0, HOSTNAME, () => {
			const addr = srv.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			srv.close(() => (port ? resolve(port) : reject(new Error("no port"))));
		});
	});
}

export function parseServerUrl(
	buffer: string,
	readyPrefix: string,
): string | null {
	for (const line of buffer.split("\n")) {
		if (!line.startsWith(readyPrefix)) continue;
		const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
		if (match?.[1]) return match[1];
	}
	return null;
}

// ── Reaper ───────────────────────────────────────────────────────────────────
// `<bin> serve` can re-exec out of the process group we spawn it in, so
// `process.kill(-pid)` alone sometimes misses the real server. A `ps`-scan
// catches it. Two matchers, each with a discriminator that CANNOT hit a serve
// Helmor didn't start (so we never kill the user's own install):
//   • teardown: the exact ephemeral `--port` we just bound (unique system-wide)
//   • startup:  our full binary path AND ppid==1 (orphaned → parent already dead,
//               so never a live sibling Helmor's server)

interface ServeProcess {
	readonly pid: number;
	readonly ppid: number;
	readonly command: string;
}

/** serve-ish processes via `ps`. Unix-only; [] on Windows or any failure. */
async function listProcesses(): Promise<ReadonlyArray<ServeProcess>> {
	if (process.platform === "win32") return [];
	try {
		const { stdout } = await execFileAsync(
			"ps",
			["-axo", "pid=,ppid=,command="],
			// Bounded so a wedged `ps` can't stall server startup; on timeout
			// the reject is swallowed below and we just skip reaping.
			{ maxBuffer: 8 * 1024 * 1024, timeout: 2_000 },
		);
		const out: ServeProcess[] = [];
		for (const line of stdout.split("\n")) {
			const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
			const command = match?.[3];
			if (!match || command === undefined) continue;
			const pid = Number(match[1]);
			const ppid = Number(match[2]);
			if (Number.isInteger(pid) && pid > 0) out.push({ pid, ppid, command });
		}
		return out;
	} catch {
		return [];
	}
}

function commandBasename(path: string): string {
	return path.split(/[\\/]/).at(-1) ?? path;
}

/** Our serve process, pinned by the exact port it bound — a system-wide unique
 *  key, so this only ever matches the server we ourselves started. */
export function matchesServeOnPort(input: {
	command: string;
	binaryPath: string;
	hostname: string;
	port: number;
}): boolean {
	return (
		/\bserve\b/.test(input.command) &&
		input.command.includes(commandBasename(input.binaryPath)) &&
		input.command.includes(`--hostname=${input.hostname}`) &&
		input.command.includes(`--port=${input.port}`)
	);
}

/** An ORPHANED serve (ppid==1) launched from OUR exact binary path. Full path
 *  rules out a user's separate install; ppid==1 rules out a live sibling
 *  Helmor (whose server still has a live sidecar parent). Returns false for a
 *  bare (path-less) binary, where we can't tell ours apart — caller skips. */
export function matchesOrphanedServe(input: {
	command: string;
	ppid: number;
	binaryPath: string;
}): boolean {
	if (!/[\\/]/.test(input.binaryPath)) return false;
	return (
		input.ppid === 1 &&
		/\bserve\b/.test(input.command) &&
		input.command.includes(input.binaryPath)
	);
}

/** Signal every process matching `match` (skipping our own pid). Best-effort;
 *  never throws. Returns the count signaled. */
async function signalProcesses(
	match: (proc: ServeProcess) => boolean,
	signal: NodeJS.Signals,
): Promise<number> {
	if (process.platform === "win32") return 0;
	let count = 0;
	for (const proc of await listProcesses()) {
		if (proc.pid === process.pid || !match(proc)) continue;
		try {
			process.kill(proc.pid, signal);
			count++;
		} catch {
			// Exited between `ps` and `kill`.
		}
	}
	return count;
}

export interface ProtocolServerHandle {
	readonly client: OpencodeClient;
	readonly url: string;
}

/** One `<bin> serve` process + its SDK client. Memoized start. */
export class OpencodeProtocolServer {
	/** Resolved once per instance; release env override wins. */
	readonly binPath: string;
	private proc: ChildProcess | null = null;
	private handle: Promise<ProtocolServerHandle> | null = null;
	private proxyUrl: string | null = null;
	/** Port the live server bound; lets `kill()` reap a serve that escaped the group. */
	private lastPort: number | null = null;
	/** Startup orphan-reap runs once per process, before the first spawn. */
	private orphanReapDone = false;

	/**
	 * @param onProcessExit Fired whenever a spawned server process exits
	 *   (crash, kill, or restart). Lets the manager settle in-flight turns
	 *   bound to a now-dead server instead of waiting on an SSE event that
	 *   will never arrive.
	 */
	constructor(
		private readonly config: ProtocolServerConfig,
		private readonly onProcessExit?: () => void,
	) {
		this.binPath = resolveBinPath(config);
	}

	/** Idempotent. Restarts if the proxy in `env` changed. Only called at turn
	 *  start, so it never interrupts an in-flight stream. */
	start(env: NodeJS.ProcessEnv): Promise<ProtocolServerHandle> {
		const proxyUrl = env.HTTPS_PROXY ?? env.HTTP_PROXY ?? env.ALL_PROXY ?? null;
		if (this.handle && proxyUrl !== this.proxyUrl) {
			logger.info(`${this.config.id} proxy changed — restarting server`, {
				proxy: proxyUrl ?? "(none)",
			});
			void this.kill();
		}
		if (this.handle) return this.handle;
		this.proxyUrl = proxyUrl;
		this.handle = this.spawnAndConnect(env).catch((err) => {
			// Allow a later sendMessage to retry from scratch.
			this.handle = null;
			throw err;
		});
		return this.handle;
	}

	private async spawnAndConnect(
		env: NodeJS.ProcessEnv,
	): Promise<ProtocolServerHandle> {
		await this.reapOrphans();
		const port = await findFreePort();
		this.lastPort = port;
		const password = randomBytes(24).toString("hex");
		const dbPath = resolveDbPath(this.config.id);
		try {
			mkdirSync(dirname(dbPath), { recursive: true });
		} catch (err) {
			logger.debug(`${this.config.id} db dir create failed`, errorDetails(err));
		}
		const child = spawn(
			this.binPath,
			["serve", `--hostname=${HOSTNAME}`, `--port=${port}`],
			{
				stdio: ["ignore", "pipe", "pipe"],
				detached: process.platform !== "win32",
				env: {
					...env,
					[this.config.passwordEnvVar]: password,
					// Isolated DB — see resolveDbPath.
					[this.config.dbEnvVar]: dbPath,
				},
			},
		);
		this.proc = child;

		const url = await new Promise<string>((resolve, reject) => {
			let stdout = "";
			let stderr = "";
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				reject(
					new Error(
						`${this.config.id} server did not start within ${STARTUP_TIMEOUT_MS}ms`,
					),
				);
			}, STARTUP_TIMEOUT_MS);
			timer.unref?.();

			const onStdout = (chunk: Buffer): void => {
				stdout += chunk.toString();
				const parsed = parseServerUrl(stdout, this.config.readyPrefix);
				if (parsed && !settled) {
					settled = true;
					clearTimeout(timer);
					resolve(parsed);
				}
			};
			child.stdout?.on("data", onStdout);
			child.stderr?.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});
			child.on("error", (err) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				reject(err);
			});
			child.on("exit", (code, signal) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				reject(
					new Error(
						`${this.config.id} server exited before ready (code=${code} signal=${signal})\n${stderr.trim()}`,
					),
				);
			});
		}).catch((err) => {
			void this.kill();
			throw err;
		});

		const client = createOpencodeClient({
			baseUrl: url,
			throwOnError: true,
			headers: {
				Authorization: `Basic ${Buffer.from(`${this.config.authUsername}:${password}`, "utf8").toString("base64")}`,
			},
		});

		// A post-ready crash must drop the cached handle, or start() keeps
		// handing out a client bound to a dead connection. Guarded so a
		// kill()+respawn that already replaced `proc` doesn't clobber the new one.
		child.on("exit", () => {
			if (this.proc === child) {
				this.proc = null;
				this.handle = null;
			}
			// Notify regardless of whether a newer proc replaced this one — turns
			// bound to THIS (now-dead) server must be settled either way.
			this.onProcessExit?.();
		});

		logger.info(`${this.config.id} server ready at ${url}`);
		return { client, url };
	}

	get running(): boolean {
		return this.proc !== null && this.proc.exitCode === null;
	}

	onExit(
		cb: (code: number | null, signal: NodeJS.Signals | null) => void,
	): void {
		this.proc?.on("exit", cb);
	}

	/**
	 * SIGTERM then (1s later) SIGKILL. Three targets, since `<bin> serve` can
	 * re-exec out of the spawned group: the process group, the direct child, and
	 * any serve still bound to our exact port. Safe to call repeatedly. The
	 * promise resolves after the SIGTERM pass; SIGKILL escalates in the background.
	 */
	async kill(): Promise<void> {
		const child = this.proc;
		const port = this.lastPort;
		this.proc = null;
		this.handle = null;
		this.lastPort = null;
		if (
			(!child || child.exitCode !== null || child.pid === undefined) &&
			port === null
		) {
			return;
		}

		const signalAll = async (signal: NodeJS.Signals): Promise<void> => {
			if (child && child.exitCode === null && child.pid !== undefined) {
				try {
					if (process.platform === "win32") {
						child.kill(signal);
					} else {
						// Negative pid signals the whole detached `serve` group.
						process.kill(-child.pid, signal);
					}
				} catch (err) {
					logger.debug(
						`${this.config.id} server kill failed`,
						errorDetails(err),
					);
				}
				// Direct handle too, in case the group kill missed.
				try {
					child.kill(signal);
				} catch {
					// Already gone.
				}
			}
			// Reap a serve that escaped the group, keyed on our exact port.
			if (port !== null) {
				await signalProcesses(
					(p) =>
						matchesServeOnPort({
							command: p.command,
							binaryPath: this.binPath,
							hostname: HOSTNAME,
							port,
						}),
					signal,
				);
			}
		};

		await signalAll("SIGTERM");
		const killTimer = setTimeout(() => void signalAll("SIGKILL"), 1_000);
		killTimer.unref?.();
		child?.once("exit", () => clearTimeout(killTimer));
	}

	/** One-shot at first spawn: SIGTERM/SIGKILL serve processes orphaned by a
	 *  prior Helmor that died without a clean shutdown (dev rebuild, crash,
	 *  force-quit). Matches only our binary path + ppid==1, so it never hits a
	 *  user's own install or a live sibling Helmor's server. */
	private async reapOrphans(): Promise<void> {
		if (this.orphanReapDone || process.platform === "win32") return;
		this.orphanReapDone = true;
		const match = (p: ServeProcess): boolean =>
			matchesOrphanedServe({
				command: p.command,
				ppid: p.ppid,
				binaryPath: this.binPath,
			});
		const signaled = await signalProcesses(match, "SIGTERM");
		if (signaled > 0) {
			logger.info(
				`${this.config.id} reaper: SIGTERM ${signaled} orphaned serve process(es) from a prior run`,
			);
			const timer = setTimeout(
				() => void signalProcesses(match, "SIGKILL"),
				1_000,
			);
			timer.unref?.();
		}
	}
}
