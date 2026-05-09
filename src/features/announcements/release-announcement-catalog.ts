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
 * SKIPPED-VERSION BEHAVIOR (intentional)
 *   The runtime matches the user's CURRENT version exactly. If a user
 *   jumps 0.19.1 to 0.21.0, any 0.20.0 toast is silently skipped. We
 *   prefer this over queuing every missed release.
 */
export const RELEASE_ANNOUNCEMENT_CATALOG: readonly ReleaseAnnouncementCatalogEntry[] =
	[];
