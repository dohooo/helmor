# Release Announcements

Use the Helmor release skill to create both the Changesets entry and any in-app release announcement fragment for a PR.

Each `*.json` file in this directory is pending release content. It is intentionally unversioned. During `bun run release:version`, the release script consumes every pending file, merges all items into one catalog entry for the final package version, and deletes the pending files.

Add a fragment only for user-visible features or workflow changes that are useful in the in-app "New in vX" toast. Bug fixes, internal refactors, and routine performance work usually belong only in the changeset.

Example:

```json
{
	"items": [
		{
			"text": "You can now drag workspaces in the sidebar to keep each section in your preferred order."
		}
	]
}
```

Schema:

```ts
type PendingReleaseAnnouncement = {
	items: Array<{
		text: string;
		action?: {
			label: string;
			value:
				| { type: "openSettings"; section?: SettingsSection }
				| { type: "setRightSidebarMode"; mode: WorkspaceRightSidebarMode };
		};
	}>;
};
```

Use `openSettings` for settings destinations:

```json
{
	"items": [
		{
			"text": "You can now group workspaces in the sidebar by repository.",
			"action": {
				"label": "Open General",
				"value": { "type": "openSettings", "section": "general" }
			}
		}
	]
}
```

Use `setRightSidebarMode` for right-sidebar destinations:

```json
{
	"items": [
		{
			"text": "Add Context now supports GitLab too.",
			"action": {
				"label": "Open Context",
				"value": { "type": "setRightSidebarMode", "mode": "context" }
			}
		}
	]
}
```
