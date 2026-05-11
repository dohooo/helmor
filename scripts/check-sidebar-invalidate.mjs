#!/usr/bin/env node
// Static guard for the sidebar-mutation-gate contract:
//   No business code may call `queryClient.invalidateQueries({queryKey: …
//   workspaceGroups | archivedWorkspaces})` directly. The single legal
//   path is `requestSidebarReconcile(queryClient)` from
//   `@/lib/sidebar-mutation-gate`, which respects an in-flight mutation
//   and otherwise reconciles both lists. Direct invalidates would race
//   with optimistic state during archive / restore / pin / commit and
//   clobber the cache before the server-side write settles — the same
//   class of bug we fixed in the unarchive-flicker and the
//   merge-clobber issues.
//
// Allowlist:
//   - `src/lib/sidebar-mutation-gate.ts` (the gate itself)
//   - `*.test.ts` / `*.test.tsx` (assertions about the gate's behavior)
//
// Run as part of `bun run lint`; non-zero exit on any violation.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SRC_ROOT = path.join(REPO_ROOT, "src");

const ALLOWED_FILES = new Set([
	path.join(SRC_ROOT, "lib", "sidebar-mutation-gate.ts"),
]);

// Looks for `invalidateQueries({` (or multi-line variants) followed by
// `queryKey: ...workspaceGroups` or `archivedWorkspaces` inside the
// same call. Conservative — false positives are better than false
// negatives because we want this contract enforced loudly.
const PATTERN =
	/invalidateQueries\s*\(\s*\{[^}]*queryKey\s*:\s*[^,}]*?\b(?:workspaceGroups|archivedWorkspaces)\b/s;

async function* walk(dir) {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === "dist") continue;
			yield* walk(full);
		} else if (
			entry.isFile() &&
			(entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))
		) {
			yield full;
		}
	}
}

const violations = [];
for await (const file of walk(SRC_ROOT)) {
	if (ALLOWED_FILES.has(file)) continue;
	if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;
	const source = await readFile(file, "utf8");
	if (!PATTERN.test(source)) continue;
	// Pull the line number of the first match for a useful error.
	const lines = source.split("\n");
	let lineNumber = 0;
	for (let i = 0; i < lines.length; i += 1) {
		// Re-test per-line so we can point precisely; the multi-line
		// case is rare enough that the file path alone suffices.
		if (/invalidateQueries\s*\(\s*\{/.test(lines[i])) {
			// Look ahead a few lines for the queryKey to handle multi-line shape.
			const window = lines.slice(i, i + 6).join("\n");
			if (
				/queryKey\s*:\s*[^,}]*?\b(?:workspaceGroups|archivedWorkspaces)\b/.test(
					window,
				)
			) {
				lineNumber = i + 1;
				break;
			}
		}
	}
	violations.push({
		file: path.relative(REPO_ROOT, file),
		line: lineNumber || "?",
	});
}

if (violations.length === 0) {
	process.exit(0);
}

console.error(
	"\n[31mcheck-sidebar-invalidate: forbidden direct invalidateQueries against sidebar lists[0m",
);
console.error("");
console.error(
	"  Calling `queryClient.invalidateQueries({queryKey: workspaceGroups | archivedWorkspaces})`",
);
console.error(
	"  in business code bypasses the sidebar-mutation-gate and races with optimistic state.",
);
console.error("");
console.error(
	"  Use `requestSidebarReconcile(queryClient)` from `@/lib/sidebar-mutation-gate` instead.",
);
console.error(
	"  (Mutation owners that already hold the gate via `holdSidebarMutation` /",
);
console.error(
	"   `createScopedSidebarGate` don't need to invalidate — `endSidebarMutation` reconciles.)",
);
console.error("");
for (const { file, line } of violations) {
	console.error(`    [33m${file}:${line}[0m`);
}
console.error("");
process.exit(1);
