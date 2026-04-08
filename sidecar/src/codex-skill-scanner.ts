/**
 * Filesystem scanner for Codex skills.
 *
 * Codex CLI loads skills from a documented set of directories — see
 * https://developers.openai.com/codex/skills. Each skill is a directory
 * containing a `SKILL.md` file with YAML frontmatter that names and
 * describes the skill. We surface those entries to the composer popup so
 * that Codex sessions get the same `/<name>` autocomplete experience as
 * Claude, even though the Codex SDK itself exposes no command-discovery
 * API.
 *
 * Precedence (first match wins for duplicate names):
 *   1. `$CWD/.agents/skills`
 *   2. `$CWD/../.agents/skills`
 *   3. `<git root>/.agents/skills` (only if different from the above)
 *   4. `$HOME/.agents/skills`
 *   5. `/etc/codex/skills`
 *
 * Built-in skills bundled inside the Codex CLI binary are not enumerated
 * here — they are not exposed on the filesystem.
 */

import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { SlashCommandInfo } from "./session-manager.js";

const SKILL_FILENAME = "SKILL.md";

/**
 * Walk parents from `start` looking for a `.git` directory. Returns the
 * directory containing `.git`, or `null` if none found before the
 * filesystem root. Synchronous `existsSync` is fine here — we only walk
 * a few levels and the result is cached for the lifetime of the call.
 */
function findGitRoot(start: string): string | null {
	let current = path.resolve(start);
	while (true) {
		if (existsSync(path.join(current, ".git"))) {
			return current;
		}
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

/**
 * Build the ordered, deduplicated list of skill root directories to scan
 * for the given workspace `cwd`. We dedupe by absolute path so a workspace
 * whose `cwd` is also the git root doesn't get scanned twice.
 */
function skillRoots(cwd: string | undefined): readonly string[] {
	const roots: string[] = [];
	const seen = new Set<string>();
	const push = (p: string | null | undefined): void => {
		if (!p) return;
		const abs = path.resolve(p);
		if (seen.has(abs)) return;
		seen.add(abs);
		roots.push(abs);
	};

	if (cwd) {
		push(path.join(cwd, ".agents/skills"));
		push(path.join(cwd, "..", ".agents/skills"));
		const gitRoot = findGitRoot(cwd);
		if (gitRoot) {
			push(path.join(gitRoot, ".agents/skills"));
		}
	}
	push(path.join(homedir(), ".agents/skills"));
	push("/etc/codex/skills");

	return roots;
}

/**
 * Parse the YAML-ish frontmatter at the top of a `SKILL.md` file and pull
 * out `name` and `description`. We don't pull in a full YAML parser because
 * we only care about top-level scalar string fields. The supported subset:
 *
 *   - `key: value`              — flow scalar (the common case)
 *   - `key: "value"` / `'value'` — quoted flow scalar
 *   - `key: >` followed by indented continuation lines — folded block scalar
 *   - `key: |` followed by indented continuation lines — literal block scalar
 *
 * That's enough to read every Codex/Claude skill we've seen in the wild.
 * Nested mappings are skipped (their value parses as empty, which simply
 * causes the field to be ignored downstream).
 *
 * Returns `null` if the file has no frontmatter, no `name`, or no
 * `description` — those are not loadable as commands.
 */
function parseFrontmatter(source: string): {
	name: string;
	description: string;
	argumentHint: string | undefined;
} | null {
	if (!source.startsWith("---")) return null;
	const end = source.indexOf("\n---", 3);
	if (end === -1) return null;
	const block = source.slice(3, end);

	const lines = block.split(/\r?\n/);
	const fields: Record<string, string> = {};
	let i = 0;
	while (i < lines.length) {
		const rawLine = lines[i] ?? "";
		i++;
		const line = rawLine.replace(/\s+$/, "");
		if (!line || line.startsWith("#")) continue;
		// Only top-level keys (no leading indentation).
		if (/^\s/.test(line)) continue;
		const colon = line.indexOf(":");
		if (colon === -1) continue;
		const key = line.slice(0, colon).trim();
		let value = line.slice(colon + 1).trim();

		if (value === ">" || value === "|") {
			const folded = value === ">";
			const collected: string[] = [];
			while (i < lines.length) {
				const next = lines[i] ?? "";
				// Block scalar ends at the first non-blank line that isn't
				// indented. Blank lines inside the block stay as paragraph
				// breaks for the literal form / spaces for the folded form.
				if (next.length > 0 && !/^\s/.test(next)) break;
				collected.push(next.replace(/^\s+/, ""));
				i++;
			}
			// Drop trailing empty lines that the dedent introduced.
			while (collected.length > 0 && collected[collected.length - 1] === "") {
				collected.pop();
			}
			value = folded ? collected.join(" ").trim() : collected.join("\n").trim();
		} else if (
			(value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
			(value.startsWith("'") && value.endsWith("'") && value.length >= 2)
		) {
			value = value.slice(1, -1);
		}
		fields[key] = value;
	}

	const name = fields.name;
	const description = fields.description;
	if (!name || !description) return null;

	return {
		name,
		description,
		argumentHint: fields["argument-hint"] || fields.argumentHint || undefined,
	};
}

async function readSkillDir(
	skillDir: string,
): Promise<SlashCommandInfo | null> {
	try {
		const skillFile = path.join(skillDir, SKILL_FILENAME);
		const source = await readFile(skillFile, "utf8");
		const parsed = parseFrontmatter(source);
		if (!parsed) return null;
		return {
			name: parsed.name,
			description: parsed.description,
			argumentHint: parsed.argumentHint,
			source: "skill",
		};
	} catch {
		return null;
	}
}

/**
 * Scan all configured Codex skill roots and return the deduped list of
 * skills, in precedence order. Earlier roots win on name collisions.
 *
 * Never throws — missing or unreadable directories are silently skipped
 * so a misconfigured `/etc/codex/skills` can't break the popup for the
 * common case where the user only has skills under `~/.agents/skills`.
 */
export async function scanCodexSkills(
	cwd: string | undefined,
): Promise<readonly SlashCommandInfo[]> {
	const out: SlashCommandInfo[] = [];
	const seen = new Set<string>();

	for (const root of skillRoots(cwd)) {
		let entries: string[];
		try {
			const st = await stat(root);
			if (!st.isDirectory()) continue;
			entries = await readdir(root);
		} catch {
			continue;
		}

		for (const entry of entries) {
			const skillDir = path.join(root, entry);
			let isDir = false;
			try {
				isDir = (await stat(skillDir)).isDirectory();
			} catch {
				continue;
			}
			if (!isDir) continue;

			const info = await readSkillDir(skillDir);
			if (!info) continue;
			if (seen.has(info.name)) continue;
			seen.add(info.name);
			out.push(info);
		}
	}

	// Sort alphabetically by name for stable popup ordering.
	out.sort((a, b) => a.name.localeCompare(b.name));
	return out;
}
