/**
 * Guards against re-introducing a `@(\/\S+)`-shaped regex anywhere in
 * the codebase. Such a regex truncates paths at the first whitespace,
 * which silently breaks attachments dropped from macOS Finder. Use the
 * structured `files` / `images` arrays via `splitTextWithFiles`
 * (frontend) or `split_user_text_with_files` (Rust) instead.
 */

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../..");
// Resolve `__filename` through `realpathSync` so symlinked checkouts
// (e.g., bun's hoisted node_modules in monorepos) still match against
// the same string we get back from `walk()`. Skipping this file by
// path-equality removes the self-match fragility of a hardcoded
// allowlist string — moving / renaming the test no longer breaks it.
const SELF_PATH = realpathSync(__filename);

// Patterns are matched against source TEXT so we catch both regex and
// string-literal occurrences. Escaped here to defeat self-match.
const FORBIDDEN_PATTERNS: ReadonlyArray<{
	readonly label: string;
	readonly regex: RegExp;
}> = [
	{ label: "@(\\/\\S+) generic", regex: /@\(\\\/\\S\+/ },
	{
		label: "@(\\/\\S+\\.(?:png|jpe?g|...)) image variant",
		regex: /@\(\\\/\\S\+\\\.\(\?:png/,
	},
];

const SCAN_DIRS = ["src", "src-tauri/src", "sidecar/src"] as const;
const SOURCE_EXTS = new Set([".ts", ".tsx", ".rs"]);
const IGNORE_DIRS = new Set([
	"node_modules",
	"target",
	"dist",
	"snapshots",
	".git",
]);

function* walk(dir: string): Generator<string> {
	for (const entry of readdirSync(dir)) {
		if (IGNORE_DIRS.has(entry)) continue;
		const full = join(dir, entry);
		const st = statSync(full);
		if (st.isDirectory()) {
			yield* walk(full);
		} else if (SOURCE_EXTS.has(extname(entry))) {
			yield full;
		}
	}
}

describe("forbidden regex invariant: @(\\/\\S+)", () => {
	it("no source file outside the allowlist contains the pattern", () => {
		const offenders: { file: string; pattern: string; line: number }[] = [];
		for (const dir of SCAN_DIRS) {
			const abs = resolve(REPO_ROOT, dir);
			for (const file of walk(abs)) {
				// Self-skip via realpath equality — robust to file moves.
				if (realpathSync(file) === SELF_PATH) continue;
				const content = readFileSync(file, "utf8");
				for (const { label, regex } of FORBIDDEN_PATTERNS) {
					const match = content.match(regex);
					if (match) {
						const idx = match.index ?? 0;
						const line = content.slice(0, idx).split("\n").length;
						offenders.push({ file, pattern: label, line });
					}
				}
			}
		}
		expect(offenders).toEqual([]);
	});
});
