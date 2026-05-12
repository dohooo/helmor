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
	/**
	 * Whether this device has never run Helmor before. The caller decides
	 * what counts as "fresh" — usually "no other `helmor-*` localStorage
	 * key exists either".
	 *
	 * Disambiguates two `lastSeenVersion === null` cases that look
	 * identical in storage:
	 *   - true  → genuinely fresh install; the catalog is irrelevant
	 *             history, suppress the toast.
	 *   - false → existing user picking up the announcement system for
	 *             the first time (the storage key itself is new), so
	 *             replay the full catalog backlog into one toast.
	 */
	isFirstHelmorBoot: boolean;
	dismissedIds: ReadonlySet<string>;
}): ReleaseAnnouncement | null {
	const {
		catalog,
		published,
		currentVersion,
		isFirstHelmorBoot,
		dismissedIds,
	} = args;
	let { lastSeenVersion } = args;

	if (lastSeenVersion === null) {
		// Genuinely first time Helmor is opened — the catalog has nothing
		// to teach a user who hasn't even used the previous version.
		if (isFirstHelmorBoot) return null;
		// Existing user, but this is the first build that ships the
		// announcement system, so `helmor:last-seen-install-version` was
		// never written before. Pretend they were on a very old version
		// and replay every published entry up to `currentVersion`.
		lastSeenVersion = "0.0.0";
	}

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
