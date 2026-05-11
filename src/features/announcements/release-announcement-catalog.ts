import type { ReleaseAnnouncementCatalogEntry } from "./announcements";

/**
 * Release Announcement Catalog
 * ----------------------------
 * Each entry below becomes a one-time toast on app launch when the
 * release that ships this entry's `id` matches the user's current
 * version. You write content here; the release pipeline writes the
 * version number for you.
 *
 * WHEN TO ADD AN ENTRY
 *   Only when a release deserves an in-app toast (a new user-visible
 *   feature with a CTA). Bug fixes, refactors, and perf changes
 *   belong in changesets only.
 *
 * HOW TO ADD AN ENTRY
 *   1. Append a new object to `RELEASE_ANNOUNCEMENT_CATALOG` below.
 *   2. Pick a stable, unique `id` (kebab-case, no version prefix).
 *   3. Write a changeset as usual (`bun run changeset`).
 *   4. On the next `bun run release:version`, the stamping script
 *      auto-binds your id to the bumped version inside
 *      `published-release-announcements.json`. Do NOT write a
 *      version anywhere in this file.
 *
 * STABILITY RULES
 *   - Once an id has been stamped, NEVER rename it. Renaming detaches
 *     the toast from its dismissal record and orphans the JSON entry.
 *   - Editing `items` (text/action) on an already-stamped id is fine;
 *     the runtime joins by id, not by content snapshot.
 *   - Deleting an entry is fine: the toast simply stops surfacing on
 *     fresh launches. Users who already saw it are unaffected.
 *
 * SKIPPED-VERSION BEHAVIOR
 *   If a user jumps several versions (e.g. 0.19.1 → 0.21.0), the runtime
 *   merges every entry in the half-open range (lastSeen, current] into a
 *   single toast — they see what they missed, newest version first
 *   (older content scrolls below). Dismissing the toast dismisses every
 *   id rolled into it.
 */
export const RELEASE_ANNOUNCEMENT_CATALOG: readonly ReleaseAnnouncementCatalogEntry[] =
	[
		// One entry per release. The runtime only surfaces one toast per
		// upgraded version (it picks the first matching `published` entry),
		// so bundle a release's user-visible highlights as items here rather
		// than splitting into multiple entries that would silently get
		// dropped. The id intentionally omits a version number — the stamp
		// script will bind it to whatever the next `release:version` run
		// produces.
		{
			id: "release-announcements-launch",
			items: [
				{
					text: "Group workspaces in the sidebar by repository instead of status — handy when you juggle many repos.",
					action: {
						label: "Open General",
						value: { type: "openSettings", section: "general" },
					},
				},
				{
					text: "Add Context now lists GitLab issues and merge requests when the current project lives on GitLab.",
					action: {
						label: "Open Context",
						value: { type: "setRightSidebarMode", mode: "context" },
					},
				},
				{
					text: "Pick how Claude returns thinking under General → Claude Code Thinking Display. Choosing Omitted lets the final text stream sooner.",
					action: {
						label: "Open General",
						value: { type: "openSettings", section: "general" },
					},
				},
				{
					text: "Inbox: 'Newest' now actually sorts by creation date, and pagination no longer silently drops items.",
				},
			],
		},
	];
