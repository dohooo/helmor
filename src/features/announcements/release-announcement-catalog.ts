import type { ReleaseAnnouncementCatalogEntry } from "./announcements";

/**
 * Release Announcement Catalog
 * ----------------------------
 * Add an entry here when a release deserves an in-app toast (a new
 * user-visible feature). Bug fixes and perf work belong in changesets
 * only.
 *
 * Conventions:
 *   - `id` is the ship timestamp as `yyyy-mm-dd-hhmm` (24h, author's
 *     local time). The minute slot keeps ids unique when multiple
 *     releases ship on the same day. It's just a stable key — the
 *     runtime doesn't parse it, only matches it.
 *   - Don't write the version anywhere here. `release:stamp` binds the
 *     id to the bumped version when `release:version` runs in CI.
 *   - NEVER rename an `id` after release — that orphans every user's
 *     dismissal record. In-place edits to `items` are fine.
 *
 * Users who skip versions see one merged toast covering the half-open
 * range `(lastSeen, current]`, newest release on top.
 */
export const RELEASE_ANNOUNCEMENT_CATALOG: readonly ReleaseAnnouncementCatalogEntry[] =
	[
		{
			id: "2026-05-12-2104",
			items: [
				{
					text: "You can now drag workspaces in the sidebar to keep each section in your preferred order.",
				},
			],
		},
		{
			id: "2026-05-11-2300",
			items: [
				{
					text: "You can now group workspaces in the sidebar by repository — toggle it in Settings.",
					action: {
						label: "Open General",
						value: { type: "openSettings", section: "general" },
					},
				},
				{
					text: "Add Context now supports GitLab too — auto-detected based on your current project.",
					action: {
						label: "Open Context",
						value: { type: "setRightSidebarMode", mode: "context" },
					},
				},
				{
					text: "Claude Code thinking now offers two modes. Choosing Omitted lets the final text stream sooner.",
					action: {
						label: "Open General",
						value: { type: "openSettings", section: "general" },
					},
				},
				{
					text: "Plus a batch of performance fixes across the app.",
				},
			],
		},
	];
