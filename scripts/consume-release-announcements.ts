import {
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

type ReleaseAnnouncementAction =
	| {
			type: "setRightSidebarMode";
			mode: string;
	  }
	| {
			type: "openSettings";
			section?: string;
	  };

type ReleaseAnnouncementItem = {
	text: string;
	action?: {
		label: string;
		value: ReleaseAnnouncementAction;
	};
};

type PendingAnnouncementFile = {
	items: ReleaseAnnouncementItem[];
};

type CatalogFile = {
	_readme?: string;
	items: Array<{
		releaseVersion: string;
		items: ReleaseAnnouncementItem[];
	}>;
	[extraField: string]: unknown;
};

export type ConsumeReleaseAnnouncementsResult = {
	version: string;
	consumedFiles: readonly string[];
	consumedItems: number;
};

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8"));
}

function assertItem(
	item: unknown,
	path: string,
): asserts item is ReleaseAnnouncementItem {
	if (!item || typeof item !== "object") {
		throw new Error(`${path} has an announcement item that is not an object`);
	}
	const candidate = item as ReleaseAnnouncementItem;
	if (
		typeof candidate.text !== "string" ||
		candidate.text.trim().length === 0
	) {
		throw new Error(`${path} has an announcement item with missing text`);
	}
	if (candidate.action === undefined) return;
	if (
		!candidate.action ||
		typeof candidate.action !== "object" ||
		typeof candidate.action.label !== "string" ||
		candidate.action.label.trim().length === 0 ||
		!candidate.action.value ||
		typeof candidate.action.value !== "object" ||
		typeof candidate.action.value.type !== "string"
	) {
		throw new Error(`${path} has an invalid action`);
	}
}

function readPending(path: string): PendingAnnouncementFile {
	const parsed = readJson(path) as Partial<PendingAnnouncementFile> & {
		id?: unknown;
		releaseVersion?: unknown;
	};
	if (parsed.id !== undefined || parsed.releaseVersion !== undefined) {
		throw new Error(`${path} must not include id or releaseVersion`);
	}
	if (!Array.isArray(parsed.items) || parsed.items.length === 0) {
		throw new Error(`${path} must include a non-empty items array`);
	}
	for (const item of parsed.items) assertItem(item, path);
	return { items: parsed.items };
}

function readCatalog(catalogPath: string): CatalogFile {
	const parsed = readJson(catalogPath) as CatalogFile;
	if (!Array.isArray(parsed.items)) {
		throw new Error(`${catalogPath} must include an items array`);
	}
	for (const entry of parsed.items) {
		if (
			typeof entry.releaseVersion !== "string" ||
			!Array.isArray(entry.items)
		) {
			throw new Error(`${catalogPath} has an invalid release entry`);
		}
		for (const item of entry.items) assertItem(item, catalogPath);
	}
	return parsed;
}

export function consumeReleaseAnnouncements(
	repoRoot = resolve(fileURLToPath(import.meta.url), "../.."),
): ConsumeReleaseAnnouncementsResult {
	const pkgPath = resolve(repoRoot, "package.json");
	const pendingDir = resolve(repoRoot, ".announcements");
	const catalogPath = resolve(
		repoRoot,
		"src/features/announcements/release-announcement-catalog.json",
	);

	const pkg = readJson(pkgPath) as { version?: string };
	if (!pkg.version) throw new Error("package.json version is missing");

	mkdirSync(pendingDir, { recursive: true });
	const pendingFiles = readdirSync(pendingDir)
		.filter((name) => name.endsWith(".json"))
		.sort();

	if (pendingFiles.length === 0) {
		return {
			version: pkg.version,
			consumedFiles: [],
			consumedItems: 0,
		};
	}

	const pendingItems = pendingFiles.flatMap(
		(file) => readPending(resolve(pendingDir, file)).items,
	);
	const catalog = readCatalog(catalogPath);
	const existing = catalog.items.find(
		(entry) => entry.releaseVersion === pkg.version,
	);
	if (existing) {
		existing.items.push(...pendingItems);
	} else {
		catalog.items.unshift({
			releaseVersion: pkg.version,
			items: pendingItems,
		});
	}

	writeFileSync(
		catalogPath,
		`${JSON.stringify(catalog, null, "\t")}\n`,
		"utf8",
	);
	for (const file of pendingFiles) {
		rmSync(resolve(pendingDir, file));
	}

	return {
		version: pkg.version,
		consumedFiles: pendingFiles,
		consumedItems: pendingItems.length,
	};
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
	const result = consumeReleaseAnnouncements();
	if (result.consumedFiles.length === 0) {
		console.log("[consume-release-announcements] nothing to consume.");
		process.exit(0);
	}
	console.log(
		`[consume-release-announcements] consumed ${result.consumedFiles.length} file(s) into v${result.version}.`,
	);
}
