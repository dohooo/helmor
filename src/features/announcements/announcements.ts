import type { SettingsSection } from "@/features/settings";
import type { WorkspaceRightSidebarMode } from "@/lib/settings";

export const GITHUB_RELEASES_URL = "https://github.com/dohooo/helmor/releases";

export type ReleaseAnnouncementAction =
	| {
			type: "setRightSidebarMode";
			mode: WorkspaceRightSidebarMode;
	  }
	| {
			type: "openSettings";
			section?: SettingsSection;
	  };

export type ReleaseAnnouncementItem = {
	text: string;
	action?: {
		label: string;
		value: ReleaseAnnouncementAction;
	};
};

/** A content-only entry maintained by hand in the catalog. */
export type ReleaseAnnouncementCatalogEntry = {
	id: string;
	items: readonly ReleaseAnnouncementItem[];
};

/** A catalog id stamped to a real release version by the release script. */
export type PublishedReleaseAnnouncement = {
	id: string;
	releaseVersion: string;
};

/**
 * What the UI consumes — the join of catalog content and the stamped
 * version, possibly merged across several releases if the user skipped
 * versions. `ids` carries every catalog id whose content is folded in,
 * so the toast can dismiss them all when the user closes it.
 */
export type ReleaseAnnouncement = {
	ids: readonly string[];
	/** The user's current app version. Used as the "New in vX" header. */
	version: string;
	items: readonly ReleaseAnnouncementItem[];
};

/**
 * Parse "X.Y.Z" into a tuple of numbers for ordering. Non-numeric or
 * missing parts collapse to 0 — defensive against malformed input from
 * the JSON file, but Helmor itself only ships plain three-part semver.
 */
function parseSemver(version: string): [number, number, number] {
	const parts = version.split(".");
	const major = Number.parseInt(parts[0] ?? "", 10) || 0;
	const minor = Number.parseInt(parts[1] ?? "", 10) || 0;
	const patch = Number.parseInt(parts[2] ?? "", 10) || 0;
	return [major, minor, patch];
}

function compareSemver(a: string, b: string): number {
	const [aMaj, aMin, aPat] = parseSemver(a);
	const [bMaj, bMin, bPat] = parseSemver(b);
	if (aMaj !== bMaj) return aMaj - bMaj;
	if (aMin !== bMin) return aMin - bMin;
	return aPat - bPat;
}

/**
 * Pure selector. Returns the announcement to show on this boot, or null.
 *
 * Folds every published entry in the half-open range
 * `(lastSeenVersion, currentVersion]` into a single announcement —
 * users who skip several versions still see what they missed. Within
 * the announcement, items are ordered newest-version first so the most
 * relevant content sits at the top of the toast (skipped-version
 * content trails below and is reachable by scrolling).
 *
 * The caller is responsible for advancing `lastSeenInstallVersion` to
 * `currentVersion` AFTER calling this — both on first launch (so we
 * never re-bootstrap) and on subsequent launches (so we don't re-check
 * the same version forever).
 */
export function selectReleaseAnnouncement(args: {
	catalog: readonly ReleaseAnnouncementCatalogEntry[];
	published: readonly PublishedReleaseAnnouncement[];
	currentVersion: string;
	lastSeenVersion: string | null;
	dismissedIds: ReadonlySet<string>;
}): ReleaseAnnouncement | null {
	const { catalog, published, currentVersion, lastSeenVersion, dismissedIds } =
		args;

	// First launch ever — no prior version recorded, so this is a fresh
	// install rather than an upgrade. Don't show anything.
	if (lastSeenVersion === null) return null;

	// Already at (or past) the current version — nothing new to surface.
	if (compareSemver(lastSeenVersion, currentVersion) >= 0) return null;

	const matches = published
		.filter(
			(p) =>
				compareSemver(p.releaseVersion, lastSeenVersion) > 0 &&
				compareSemver(p.releaseVersion, currentVersion) <= 0 &&
				!dismissedIds.has(p.id),
		)
		.slice()
		// Newest version first. Stable sort preserves the original
		// `published` ordering when two entries share a version, so
		// the per-release author still controls the in-version order.
		.sort((a, b) => compareSemver(b.releaseVersion, a.releaseVersion));

	if (matches.length === 0) return null;

	const ids: string[] = [];
	const items: ReleaseAnnouncementItem[] = [];
	for (const match of matches) {
		const entry = catalog.find((c) => c.id === match.id);
		if (!entry) continue;
		ids.push(entry.id);
		items.push(...entry.items);
	}

	if (items.length === 0) return null;

	return { ids, version: currentVersion, items };
}
