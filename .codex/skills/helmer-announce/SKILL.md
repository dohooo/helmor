---
name: helmer-announce
description: Create or update Helmor's in-app release announcement catalog for a release pipeline. Use this whenever the user asks for a user notification catalog, announcement catalog, in-app release toast, or says to generate a catalog for a Helmor release. This skill decides which current-release changes deserve an announcement, edits only the hand-maintained catalog, and leaves version stamping to Actions.
---

# Helmer Announce

Use this skill to add a user-facing in-app announcement entry for a Helmor release.

## Scope

This skill handles `src/features/announcements/release-announcement-catalog.ts`.

Do not manually edit `src/features/announcements/published-release-announcements.json` for normal release work. The release pipeline runs `bun run release:stamp`, which binds new catalog ids to the package version in Actions.

If the user also needs a Changesets entry or release wording, use the existing `helmor-release` skill first, then come back here to create the announcement catalog entry.

## Workflow

1. Inspect the release context before editing:
   - read the top of `CHANGELOG.md`
   - check `package.json` only for context, not for stamping
   - inspect recent commits or branch diff if the changelog is not enough
2. Decide whether an announcement is warranted.
   - Add entries only for new user-visible features or workflow changes.
   - Skip bug fixes, internal refactors, performance-only work, and release plumbing unless users need to learn a new behavior.
3. Add exactly one new catalog entry at the top of `RELEASE_ANNOUNCEMENT_CATALOG`.
   - Use id format `yyyy-mm-dd-hhmm` from local time.
   - Keep copy short, concrete, and written for users.
   - Add an action only when there is a useful direct destination.
4. Do not run `bun run release:stamp` unless the user explicitly asks for local stamping.
5. Verify the announcement selector still passes:
   - `bun x vitest run src/features/announcements/announcements.test.ts`
   - `bunx biome check src/features/announcements/release-announcement-catalog.ts --config-path=./biome.json`
6. Report the new id, the user-facing text, and the verification commands.

## Copy Guidance

Prefer one item for one feature:

```ts
{
	id: "2026-05-12-2104",
	items: [
		{
			text: "You can now drag workspaces in the sidebar to keep each section in your preferred order.",
		},
	],
},
```

Use actions sparingly:

```ts
action: {
	label: "Open General",
	value: { type: "openSettings", section: "general" },
},
```

Good announcement text:

- names the user-visible capability
- avoids implementation details, PR numbers, and changelog wording
- stays useful when shown inside a compact toast

Bad announcement text:

- "Fix internal JSON handling in pipeline"
- "Refactor navigation state"
- "Improve performance across the app" unless it is the primary release story

## Final Response

Keep the final response brief:

- catalog file changed
- id and text added
- note that version binding is left to Actions
- tests run
