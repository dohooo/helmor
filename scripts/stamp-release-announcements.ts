/**
 * Stamps every catalog entry that does not yet have a published binding
 * with the current `package.json` version. Runs after `changeset version`
 * inside `release:version`. Re-running with the same version is a no-op.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASE_ANNOUNCEMENT_CATALOG } from "../src/features/announcements/release-announcement-catalog";

/**
 * Partial view of `published-release-announcements.json` — only the fields
 * the stamper actively reads or mutates. Any other top-level keys (e.g.
 * `_readme`) survive the parse → mutate → stringify round-trip verbatim
 * because we mutate `file.items` in place on the parsed object instead of
 * rebuilding it field-by-field. Index signature is `unknown` (not
 * `string`) to keep that "I don't know the shape" honest at the type
 * level.
 */
type PublishedFile = {
	items: Array<{ id: string; releaseVersion: string }>;
	[extraField: string]: unknown;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = resolve(repoRoot, "package.json");
const jsonPath = resolve(
	repoRoot,
	"src/features/announcements/published-release-announcements.json",
);

const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
const version = pkg.version;
if (!version) {
	throw new Error("package.json version is missing");
}

const file = JSON.parse(readFileSync(jsonPath, "utf8")) as PublishedFile;
if (!Array.isArray(file.items)) {
	throw new Error(
		`published-release-announcements.json is malformed: expected { items: [...] }`,
	);
}

const known = new Set(file.items.map((item) => item.id));
const additions = RELEASE_ANNOUNCEMENT_CATALOG.filter(
	(entry) => !known.has(entry.id),
).map((entry) => ({ id: entry.id, releaseVersion: version }));

if (additions.length === 0) {
	console.log("[stamp-release-announcements] nothing to stamp.");
	process.exit(0);
}

file.items = [...file.items, ...additions];
writeFileSync(jsonPath, `${JSON.stringify(file, null, "\t")}\n`, "utf8");
console.log(
	`[stamp-release-announcements] stamped ${additions.length} entry(s) under v${version}: ${additions
		.map((a) => a.id)
		.join(", ")}`,
);
