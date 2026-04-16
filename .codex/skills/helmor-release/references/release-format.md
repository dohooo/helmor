# Helmor Release Format

Use this reference when preparing a Helmor changeset or walking the user through release prep.

## Normal Iteration Flow

1. Finish the feature branch.
2. Add or update one changeset that describes the user-visible outcome.
3. Push the branch and open the feature PR.
4. Merge the PR into `main`.
5. Let `Release Plan` create or update the release PR.
6. Review the generated `CHANGELOG.md` and version bump.
7. Merge the release PR.
8. Run `Publish macOS Release` when ready to publish the signed build.

## What the Changeset Should Capture

Prefer these categories:

- new capability
- changed workflow
- fix or reliability improvement
- release/distribution improvement that matters to users

Avoid these unless the user explicitly asks for them:

- internal refactors
- file renames
- dependency bumps without user impact
- internal docs-only changes

## Bump Heuristics

- `patch`: bug fixes, polish, packaging, small workflow fixes
- `minor`: new features, new user-visible workflows, notable release improvements
- `major`: breaking behavior changes

## Writing Style

Good:

- "Add in-app update checks that download updates in the background and prompt once the update is ready to install."
- "Add signed and notarized macOS release publishing through GitHub Releases."

Bad:

- "Refactor updater state machine and reorganize release scripts."
- "Update Cargo.toml, tauri.conf.json, and workflow files."

## Credits

If the user wants credits, keep them short and explicit in the body. Example:

- "Thanks @username for helping validate the release flow on macOS."

Do not invent credits automatically.
