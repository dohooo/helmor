// Per-tick scratch directory for triage. Source tools write fetched data as
// Markdown files here; the agent reads/greps them via scratch tools instead
// of having raw API JSON pasted into its context window.

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { logger } from "../logger";

function resolveScratchRoot(): string {
	const logDir = process.env.HELMOR_LOG_DIR;
	if (logDir) {
		// log dir is <data_dir>/logs; place scratch beside it.
		return join(dirname(logDir), "triage", "scratch");
	}
	return join(tmpdir(), "helmor-triage", "scratch");
}

export class ScratchSession {
	readonly root: string;

	constructor(public readonly tickId: string) {
		this.root = join(resolveScratchRoot(), tickId);
	}

	async init(): Promise<void> {
		await mkdir(this.root, { recursive: true });
		logger.info(`scratch[${this.tickId}] init`, { root: this.root });
	}

	async write(filename: string, content: string): Promise<string> {
		const safe = sanitizeFilename(filename);
		const path = join(this.root, safe);
		await writeFile(path, content, "utf8");
		return safe;
	}

	async list(): Promise<
		Array<{ file: string; bytes: number; lines: number; title: string | null }>
	> {
		const entries = await readdir(this.root, { withFileTypes: true });
		const out: Array<{
			file: string;
			bytes: number;
			lines: number;
			title: string | null;
		}> = [];
		for (const entry of entries) {
			if (!entry.isFile()) continue;
			const path = join(this.root, entry.name);
			const text = await readFile(path, "utf8").catch(() => "");
			const lines = text.length === 0 ? 0 : text.split("\n").length;
			const title = extractTitle(text);
			out.push({ file: entry.name, bytes: text.length, lines, title });
		}
		out.sort((a, b) => a.file.localeCompare(b.file));
		return out;
	}

	async read(
		filename: string,
		opts: { offset?: number; limit?: number } = {},
	): Promise<{
		content: string;
		startLine: number;
		endLine: number;
		totalLines: number;
	}> {
		const path = this.resolveSafe(filename);
		const text = await readFile(path, "utf8");
		const lines = text.split("\n");
		const offset = Math.max(0, Math.floor(opts.offset ?? 0));
		const limit = Math.max(1, Math.min(2000, Math.floor(opts.limit ?? 400)));
		const slice = lines.slice(offset, offset + limit);
		return {
			content: slice.join("\n"),
			startLine: offset + 1,
			endLine: Math.min(offset + slice.length, lines.length),
			totalLines: lines.length,
		};
	}

	async grep(
		pattern: string,
		opts: {
			file?: string;
			context?: number;
			maxMatches?: number;
			ignoreCase?: boolean;
		} = {},
	): Promise<{
		matches: GrepMatch[];
		truncated: boolean;
		filesScanned: number;
	}> {
		const ctx = Math.max(0, Math.min(10, Math.floor(opts.context ?? 2)));
		const max = Math.max(1, Math.min(200, Math.floor(opts.maxMatches ?? 50)));
		const flags = `g${opts.ignoreCase ? "i" : ""}`;
		let re: RegExp;
		try {
			re = new RegExp(pattern, flags);
		} catch (error) {
			throw new Error(
				`Invalid regex: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		const entries = await this.list();
		const targets = opts.file
			? entries.filter((e) => e.file === opts.file)
			: entries;
		const matches: GrepMatch[] = [];
		let truncated = false;

		for (const entry of targets) {
			if (matches.length >= max) {
				truncated = true;
				break;
			}
			const path = join(this.root, entry.file);
			const text = await readFile(path, "utf8");
			const lines = text.split("\n");
			for (let i = 0; i < lines.length; i++) {
				if (matches.length >= max) {
					truncated = true;
					break;
				}
				const line = lines[i] ?? "";
				re.lastIndex = 0;
				if (!re.test(line)) continue;
				const start = Math.max(0, i - ctx);
				const end = Math.min(lines.length, i + ctx + 1);
				matches.push({
					file: entry.file,
					line: i + 1,
					match: line,
					context: lines
						.slice(start, end)
						.map((l, idx) => `${start + idx + 1}: ${l ?? ""}`)
						.join("\n"),
				});
			}
		}

		return { matches, truncated, filesScanned: targets.length };
	}

	async dispose(): Promise<void> {
		try {
			await rm(this.root, { recursive: true, force: true });
		} catch (error) {
			logger.info(`scratch[${this.tickId}] dispose failed (non-fatal)`, {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private resolveSafe(filename: string): string {
		const safe = sanitizeFilename(filename);
		const path = resolve(this.root, safe);
		if (
			!path.startsWith(`${resolve(this.root)}/`) &&
			path !== resolve(this.root)
		) {
			throw new Error(`Path escapes scratch root: ${filename}`);
		}
		return path;
	}
}

export interface GrepMatch {
	file: string;
	line: number;
	match: string;
	context: string;
}

const FILENAME_CHARS = /[^a-zA-Z0-9._\-#]/g;

function sanitizeFilename(name: string): string {
	const trimmed = name.trim().replace(/^\/+/, "").replace(/\.\.+/g, "");
	const cleaned = trimmed.replace(FILENAME_CHARS, "_");
	return cleaned.length > 0 ? cleaned.slice(0, 180) : "untitled.md";
}

function extractTitle(text: string): string | null {
	for (const line of text.split("\n", 10)) {
		const m = line.match(/^#\s+(.+)$/);
		if (m?.[1]) return m[1].trim();
	}
	return null;
}

/// Sweep scratch dirs older than `maxAgeMs` from prior crashes. Safe to call
/// on every tick.
export async function sweepStaleScratch(
	maxAgeMs = 24 * 60 * 60 * 1000,
): Promise<void> {
	const root = resolveScratchRoot();
	let entries: import("node:fs").Dirent[];
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch {
		return;
	}
	const cutoff = Date.now() - maxAgeMs;
	const { stat } = await import("node:fs/promises");
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const path = join(root, entry.name);
		const st = await stat(path).catch(() => null);
		if (st && st.mtimeMs < cutoff) {
			await rm(path, { recursive: true, force: true }).catch(() => {});
		}
	}
}
