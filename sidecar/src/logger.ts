/**
 * Structured JSON logger for the sidecar process.
 *
 * - NDJSON to a single file per day: `sidecar.YYYY-MM-DD.jsonl`.
 * - Dev stderr matches Rust tracing-subscriber's default format so both
 *   processes produce visually identical terminal output.
 * - stdout is NEVER touched — it is the exclusive JSON protocol channel.
 */

import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";

type Level = "debug" | "info" | "error";
const LEVELS: Record<Level, number> = { debug: 0, info: 1, error: 2 };

// ANSI codes matching Rust tracing-subscriber defaults.
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

// Local RFC 3339 timestamp matching Rust's ChronoLocal default output.
// Pads ms → µs (6 fractional digits) and appends the UTC offset.
function localTs(): string {
	const d = new Date();
	const off = -d.getTimezoneOffset();
	const sign = off >= 0 ? "+" : "-";
	const abs = Math.abs(off);
	const oh = String(Math.floor(abs / 60)).padStart(2, "0");
	const om = String(abs % 60).padStart(2, "0");
	const pad = (n: number, w = 2) => String(n).padStart(w, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}000${sign}${oh}:${om}`;
}
const LEVEL_FMT: Record<Level, { label: string; color: string }> = {
	error: { label: "ERROR", color: "\x1b[31m" }, // red
	info: { label: " INFO", color: "\x1b[32m" }, // green (right-padded to 5)
	debug: { label: "DEBUG", color: "\x1b[34m" }, // blue
};

function fmtValue(v: unknown): string {
	if (typeof v === "string") return `"${v}"`;
	if (v === null || v === undefined) return String(v);
	if (typeof v === "object") return JSON.stringify(v);
	return String(v);
}

export function errorDetails(err: unknown): Record<string, unknown> {
	if (err instanceof Error) {
		const details: Record<string, unknown> = {
			error: err.message,
			errorName: err.name,
		};
		if (err.stack) {
			details.errorStack = err.stack;
		}
		if ("cause" in err && err.cause !== undefined) {
			details.errorCause = String(err.cause);
		}
		return details;
	}

	if (typeof err === "object" && err !== null) {
		try {
			return { error: JSON.stringify(err) };
		} catch {
			return { error: String(err) };
		}
	}

	return { error: String(err) };
}

class Logger {
	private minLevel: number;
	private file: WriteStream | undefined;
	private devStderr: boolean;

	constructor() {
		const envLevel = process.env.HELMOR_LOG?.toLowerCase();
		const level: Level =
			envLevel === "debug" || envLevel === "trace"
				? "debug"
				: envLevel === "error"
					? "error"
					: "info";
		this.minLevel = LEVELS[level];
		this.devStderr = level === "debug";

		const logDir = process.env.HELMOR_LOG_DIR;
		if (logDir) {
			mkdirSync(logDir, { recursive: true });
			const today = localTs().slice(0, 10);
			this.file = createWriteStream(`${logDir}/sidecar.${today}.jsonl`, {
				flags: "a",
			});
		}
	}

	debug(msg: string, data?: Record<string, unknown>): void {
		this.emit("debug", msg, data);
	}
	info(msg: string, data?: Record<string, unknown>): void {
		this.emit("info", msg, data);
	}
	error(msg: string, data?: Record<string, unknown>): void {
		this.emit("error", msg, data);
	}

	/** Log a raw SDK event. Full payload → JSONL; compact summary → stderr. */
	sdkEvent(requestId: string, event: unknown): void {
		if (LEVELS.debug < this.minLevel) return;

		const ts = localTs();
		const evt =
			typeof event === "object" && event !== null
				? (event as Record<string, unknown>)
				: {};
		const type = String(evt.type ?? "unknown");

		const line = `${JSON.stringify({ ts, level: "debug", source: "sidecar", msg: "sdk_event", requestId, type, event })}\n`;
		this.file?.write(line);

		if (this.devStderr) {
			const { label, color } = LEVEL_FMT.debug;
			const json = JSON.stringify(event);
			process.stderr.write(
				`${DIM}${localTs()}${RESET} ${color}${label}${RESET} ${DIM}sidecar:${RESET} [${requestId}] ← sdk ${json}\n`,
			);
		}
	}

	private emit(
		level: Level,
		msg: string,
		data?: Record<string, unknown>,
	): void {
		if (LEVELS[level] < this.minLevel) return;

		const ts = localTs();
		const line = `${JSON.stringify({ ts, level, source: "sidecar", msg, ...data })}\n`;
		this.file?.write(line);

		// Human-readable stderr matching Rust tracing format
		if (this.devStderr) {
			const { label, color } = LEVEL_FMT[level];
			let fields = "";
			if (data) {
				for (const [k, v] of Object.entries(data)) {
					fields += ` ${k}=${fmtValue(v)}`;
				}
			}
			process.stderr.write(
				`${DIM}${localTs()}${RESET} ${color}${label}${RESET} ${DIM}sidecar:${RESET} ${msg}${fields}\n`,
			);
		}
	}
}

export const logger = new Logger();
