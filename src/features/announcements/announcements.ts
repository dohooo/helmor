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

/** What the UI consumes — the join of catalog content and the stamped version. */
export type ReleaseAnnouncement = {
	id: string;
	version: string;
	items: readonly ReleaseAnnouncementItem[];
};

/**
 * Pure selector. Returns the announcement to show on this boot, or null.
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

	// Same version since last boot — nothing new for the user to see.
	if (lastSeenVersion === currentVersion) return null;

	const match = published.find(
		(p) => p.releaseVersion === currentVersion && !dismissedIds.has(p.id),
	);
	if (!match) return null;

	const entry = catalog.find((c) => c.id === match.id);
	if (!entry) return null;

	return { id: entry.id, version: match.releaseVersion, items: entry.items };
}
