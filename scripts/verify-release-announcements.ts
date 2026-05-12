import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type AnnouncementAction =
	| { type: "openSettings"; section?: string }
	| { type: "setRightSidebarMode"; mode: string };

type AnnouncementItem = {
	text: string;
	action?: {
		label: string;
		value: AnnouncementAction;
	};
};

type AnnouncementEntry = {
	releaseVersion: string;
	items: AnnouncementItem[];
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pendingDir = resolve(repoRoot, ".announcements");
const catalogPath = resolve(
	repoRoot,
	"src/features/announcements/release-announcement-catalog.json",
);

function fail(message: string): never {
	throw new Error(`[verify-release-announcements] ${message}`);
}

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		fail(`${path} is not valid JSON: ${error}`);
	}
}

function assertItem(
	item: unknown,
	path: string,
): asserts item is AnnouncementItem {
	if (!item || typeof item !== "object") {
		fail(`${path} has an announcement item that is not an object`);
	}
	const candidate = item as AnnouncementItem;
	if (
		typeof candidate.text !== "string" ||
		candidate.text.trim().length === 0
	) {
		fail(`${path} has an announcement item with missing text`);
	}
	if (candidate.action === undefined) return;
	if (
		!candidate.action ||
		typeof candidate.action !== "object" ||
		typeof candidate.action.label !== "string" ||
		candidate.action.label.trim().length === 0 ||
		!candidate.action.value ||
		typeof candidate.action.value !== "object"
	) {
		fail(`${path} has an invalid action`);
	}
	const action = candidate.action.value;
	if (action.type === "openSettings") return;
	if (
		action.type === "setRightSidebarMode" &&
		typeof action.mode === "string" &&
		action.mode.length > 0
	) {
		return;
	}
	fail(`${path} has an unsupported action value`);
}

function assertItems(
	items: unknown,
	path: string,
): asserts items is AnnouncementItem[] {
	if (!Array.isArray(items) || items.length === 0) {
		fail(`${path} must include a non-empty items array`);
	}
	for (const item of items) assertItem(item, path);
}

mkdirSync(pendingDir, { recursive: true });

const catalog = readJson(catalogPath) as { items?: unknown };
if (!Array.isArray(catalog.items)) {
	fail(`${catalogPath} must include an items array`);
}

const seenVersions = new Set<string>();
for (const entry of catalog.items as AnnouncementEntry[]) {
	if (
		!entry ||
		typeof entry !== "object" ||
		typeof entry.releaseVersion !== "string" ||
		entry.releaseVersion.length === 0
	) {
		fail(`${catalogPath} has an invalid release entry`);
	}
	if (seenVersions.has(entry.releaseVersion)) {
		fail(`${catalogPath} has duplicate version ${entry.releaseVersion}`);
	}
	seenVersions.add(entry.releaseVersion);
	assertItems(entry.items, catalogPath);
}

for (const name of readdirSync(pendingDir).filter((file) =>
	file.endsWith(".json"),
)) {
	const path = resolve(pendingDir, name);
	const pending = readJson(path) as {
		id?: unknown;
		releaseVersion?: unknown;
		items?: unknown;
	};
	if (pending.id !== undefined || pending.releaseVersion !== undefined) {
		fail(`${path} must not include id or releaseVersion`);
	}
	assertItems(pending.items, path);
}

console.log("[verify-release-announcements] release announcements verified.");
