/** Filesystem scan for Cursor skills (https://cursor.com/cn/docs/skills),
 * mirroring what Cursor itself does. Roots: `.agents/skills`,
 * `.cursor/skills`, plus legacy `.claude/skills` / `.codex/skills`, at
 * project + user scope. Output shape matches `SlashCommandInfo`. */

import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { logger } from "./logger.js";
import type {
	ListSlashCommandsParams,
	SlashCommandInfo,
} from "./session-manager.js";

/// Symlink-loop cap.
const MAX_DEPTH = 6;

const SKILL_FILENAME = "SKILL.md";

/// Earlier entries win on duplicate skill names.
const PROJECT_ROOTS = [
	".agents/skills",
	".cursor/skills",
	".claude/skills",
	".codex/skills",
] as const;

const USER_ROOTS = [
	".agents/skills",
	".cursor/skills",
	".claude/skills",
	".codex/skills",
] as const;

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export interface ScanCursorSkillsOptions {
	/** Override `$HOME`. Tests use this to sandbox user-scope scans;
	 *  production leaves it unset so `os.homedir()` is used. */
	readonly homeDir?: string;
}

export async function scanCursorSkills(
	params: ListSlashCommandsParams,
	options?: ScanCursorSkillsOptions,
): Promise<SlashCommandInfo[]> {
	const roots = collectRoots(params, options?.homeDir ?? homedir());
	const visited = new Set<string>();

	// Parallel scan, but preserve root priority for deterministic dedupe.
	const perRoot = await Promise.all(
		roots.map(async (root) => {
			const found: SlashCommandInfo[] = [];
			await walk(root, 0, found, visited);
			return found;
		}),
	);

	const byName = new Map<string, SlashCommandInfo>();
	for (const found of perRoot) {
		for (const skill of found) {
			if (!byName.has(skill.name)) byName.set(skill.name, skill);
		}
	}

	const out = Array.from(byName.values());
	out.sort((a, b) => a.name.localeCompare(b.name));
	return out;
}

function collectRoots(
	params: ListSlashCommandsParams,
	homeDir: string,
): string[] {
	const projectDirs = new Set<string>();
	if (params.cwd) projectDirs.add(resolve(params.cwd));
	for (const extra of params.additionalDirectories ?? []) {
		if (extra) projectDirs.add(resolve(extra));
	}

	const roots: string[] = [];
	for (const dir of projectDirs) {
		for (const sub of PROJECT_ROOTS) roots.push(join(dir, sub));
	}
	for (const sub of USER_ROOTS) roots.push(join(homeDir, sub));

	// Dedupe by absolute path — `cwd === $HOME` would otherwise scan twice.
	return Array.from(new Set(roots));
}

async function walk(
	dir: string,
	depth: number,
	out: SlashCommandInfo[],
	visited: Set<string>,
): Promise<void> {
	if (depth > MAX_DEPTH) return;
	if (visited.has(dir)) return;
	visited.add(dir);

	// `readdir(..., { withFileTypes: true })` overloads have shifted with
	// recent @types/node toward `Dirent<NonSharedBuffer>` when the encoding
	// arg is omitted. Pin `encoding: "utf8"` so `name` stays a string and
	// the rest of this function can use it without runtime conversions.
	let entries: Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true, encoding: "utf8" });
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		// ENOENT is the common case — most users won't have all eight roots.
		if (code !== "ENOENT" && code !== "ENOTDIR") {
			logger.debug(
				`cursor skill scan: skip ${dir} (${code ?? (err as Error).message})`,
			);
		}
		return;
	}

	const skillFile = entries.find(
		(e) => e.isFile() && e.name === SKILL_FILENAME,
	);
	if (skillFile) {
		const skill = await readSkill(dir);
		if (skill) out.push(skill);
		// A skill leaf may legitimately contain `scripts/`, `references/`,
		// `assets/` subdirs per the docs — those aren't skills themselves,
		// so stop descending here.
		return;
	}

	// Recurse into subdirectories only. Skip dotfiles to avoid wandering
	// into `.git`, `node_modules`-like nests, or accidental nested roots.
	await Promise.all(
		entries
			.filter((e) => e.isDirectory() && !e.name.startsWith("."))
			.map((e) => walk(join(dir, e.name), depth + 1, out, visited)),
	);
}

async function readSkill(dir: string): Promise<SlashCommandInfo | null> {
	const file = join(dir, SKILL_FILENAME);
	let raw: string;
	try {
		raw = await readFile(file, "utf8");
	} catch (err) {
		logger.debug(
			`cursor skill scan: cannot read ${file}: ${(err as Error).message}`,
		);
		return null;
	}

	const fm = parseFrontmatter(raw) ?? {};
	// Per Cursor docs the `name` MUST match the parent folder name. When
	// they disagree (or the YAML omits it), the folder name is the source
	// of truth — that's what the user types after `/`.
	const folderName = sanitizeSkillName(basename(dir));
	const declared = sanitizeSkillName(fm.name);
	const name = declared ?? folderName;
	if (!name) return null;

	const description =
		typeof fm.description === "string" ? fm.description.trim() : "";

	return {
		name,
		description,
		argumentHint: undefined,
		source: "skill",
	};
}

function sanitizeSkillName(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return SKILL_NAME_RE.test(trimmed) ? trimmed : null;
}

/**
 * Parse the leading `---`-fenced YAML block of a Markdown file. We only
 * care about a flat scalar/string view, so this is intentionally a small
 * subset of YAML — enough for `name`, `description: |`, and the other
 * scalar fields Cursor's SKILL.md spec defines. Anything we don't
 * understand is ignored rather than failing the whole scan.
 */
export function parseFrontmatter(
	source: string,
): Record<string, unknown> | null {
	const stripped = source.replace(/^﻿/, "");
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(stripped);
	if (!match) return null;
	return parseYamlSubset(match[1] ?? "");
}

function parseYamlSubset(body: string): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	const lines = body.split(/\r?\n/);
	let i = 0;
	while (i < lines.length) {
		const line = lines[i] ?? "";
		if (!line.trim() || /^\s*#/.test(line)) {
			i++;
			continue;
		}
		const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
		if (!m) {
			i++;
			continue;
		}
		const key = m[1] as string;
		const rest = (m[2] ?? "").trim();
		if (rest === "|" || rest === ">") {
			i++;
			const collected: string[] = [];
			let baseIndent = -1;
			while (i < lines.length) {
				const cur = lines[i] ?? "";
				if (cur.trim() === "") {
					collected.push("");
					i++;
					continue;
				}
				const indent = /^(\s+)/.exec(cur);
				const indentStr = indent?.[1];
				if (!indentStr) break;
				if (baseIndent < 0) baseIndent = indentStr.length;
				if (indentStr.length < baseIndent) break;
				collected.push(cur.slice(baseIndent));
				i++;
			}
			const joined =
				rest === "|" ? collected.join("\n") : collected.join(" ").trim();
			out[key] = joined;
		} else {
			out[key] = parseScalar(rest);
			i++;
		}
	}
	return out;
}

function parseScalar(raw: string): string | number | boolean | null {
	const t = raw.trim();
	if (!t) return "";
	const noComment = t.replace(/\s+#.*$/, "").trim();
	const dq = /^"((?:[^"\\]|\\.)*)"$/.exec(noComment);
	if (dq?.[1] !== undefined)
		return dq[1].replace(/\\"/g, '"').replace(/\\n/g, "\n");
	const sq = /^'((?:[^'])*)'$/.exec(noComment);
	if (sq?.[1] !== undefined) return sq[1];
	if (noComment === "true") return true;
	if (noComment === "false") return false;
	if (noComment === "null" || noComment === "~") return null;
	return noComment;
}
