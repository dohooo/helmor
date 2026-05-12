# Changesets

Always use `.agents/skills/helmor-release/` to create release metadata.

Do not run `bun run changeset` directly for normal PR work.

The skill creates the Changesets entry and, when the PR deserves an in-app
"New in vX" toast, the matching `.announcements/*.json` fragment.

Changesets still owns release notes and version syncing for `package.json`,
`src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`; the release skill is
the project wrapper that keeps those files and Helmor's in-app announcement
flow aligned.

Only bypass the skill when you intentionally want a raw changeset with no
announcement review.
