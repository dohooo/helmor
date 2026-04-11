/**
 * Structured JSON logger for the sidecar process.
 *
 * Outputs NDJSON to three level-specific files (inclusive routing):
 *   sidecar-debug.YYYY-MM-DD.jsonl  — all events
 *   sidecar-info.YYYY-MM-DD.jsonl   — info + error
 *   sidecar-error.YYYY-MM-DD.jsonl  — error only
 *
 * File rotation, compression, and retention are handled by the Rust host
 * (see src-tauri/src/logging.rs). The sidecar is a short-lived child process
 * and only needs to append.
 *
 * In dev (HELMOR_SIDECAR_DEBUG=1), also writes human-readable lines to stderr.
 * stdout is NEVER touched — it is the exclusive JSON protocol channel.
 *
 * NOTE: We intentionally avoid pino/winston because `bun build --compile`
 * breaks their worker-thread-based transports. This logger is ~40 lines of
 * logic and covers the exact requirements without external dependencies.
 */

import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";

type Level = "debug" | "info" | "error";
const LEVELS: Record<Level, number> = { debug: 0, info: 1, error: 2 };

class Logger {
	private minLevel: number;
	private files: Record<Level, WriteStream | undefined> = {
		debug: undefined,
		info: undefined,
		error: undefined,
	};
	private devStderr: boolean;

	constructor() {
		const debug =
			process.env.HELMOR_SIDECAR_DEBUG === "1" ||
			process.env.HELMOR_SIDECAR_DEBUG === "true";
		this.minLevel = debug ? LEVELS.debug : LEVELS.info;
		this.devStderr = debug;

		const logDir = process.env.HELMOR_LOG_DIR;
		if (logDir) {
			mkdirSync(logDir, { recursive: true });
			const today = new Date().toISOString().slice(0, 10);
			const path = (lvl: string) =>
				`${logDir}/sidecar-${lvl}.${today}.jsonl`;
			this.files.debug = createWriteStream(path("debug"), { flags: "a" });
			this.files.info = createWriteStream(path("info"), { flags: "a" });
			this.files.error = createWriteStream(path("error"), { flags: "a" });
		}
	}

	debug(msg: string, data?: Record<string, unknown>): void {
		this.write("debug", msg, data);
	}
	info(msg: string, data?: Record<string, unknown>): void {
		this.write("info", msg, data);
	}
	error(msg: string, data?: Record<string, unknown>): void {
		this.write("error", msg, data);
	}

	private write(
		level: Level,
		msg: string,
		data?: Record<string, unknown>,
	): void {
		if (LEVELS[level] < this.minLevel) return;

		const line = `${JSON.stringify({ ts: new Date().toISOString(), level, source: "sidecar", msg, ...data })}\n`;

		// Inclusive file routing
		this.files.debug?.write(line);
		if (LEVELS[level] >= LEVELS.info) this.files.info?.write(line);
		if (LEVELS[level] >= LEVELS.error) this.files.error?.write(line);

		// Human-readable stderr for dev
		if (this.devStderr) {
			process.stderr.write(`[sidecar:${level}] ${msg}\n`);
		}
	}
}

export const logger = new Logger();
