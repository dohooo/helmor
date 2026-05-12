# Helmor Release Format

Use this reference when preparing a Helmor changeset or walking the user through release prep.

## Normal Iteration Flow

1. Finish the feature branch.
2. Add or update one changeset that describes the user-visible outcome.
3. Add a `.announcements/*.json` fragment when the PR deserves an in-app "New in vX" toast.
4. Push the branch and open the feature PR.
5. Merge the PR into `main`.
6. Let `Release Plan` create or update the release PR. It consumes pending announcement fragments into one entry for the final version.
7. Review the generated `CHANGELOG.md`, version bump, and release announcement catalog entry.
8. Merge the release PR.
9. Run `Publish macOS Release` when ready to publish the signed build.

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

## Body Structure

Pick the smallest shape that fits the change.

**Shape A — single sentence.** Default for most patch-level fixes and small polish PRs. One self-contained sentence is the entire body.

**Shape B — summary line + bullets.** Use only when there are ≥2 distinct user-visible changes worth enumerating. A prose summary line (no leading `- `) followed by `- ` sub-items.

Decision rule: if the summary would just restate the only bullet underneath, collapse to Shape A. If a single sentence forces "and"/";" cramming, expand to Shape B.

Hard rule for both shapes: **never start the body with `- `.** `@changesets/changelog-github` inlines the first line of the body onto the same line as `Thanks @user! -` when rendering `CHANGELOG.md` / GitHub Release; a leading `- ` produces `! - - Fix X` with the first item glued to the attribution line.

Shape A — single sentence:

```md
Fix a composer IME regression so the caret no longer jumps to the start of the paragraph after an IME buffer is stripped.
```

Shape B — summary line ends with `:`, bullets follow:

```md
Harden Chinese / Japanese / Korean IME handling in the composer:
- Pressing Enter to confirm a candidate no longer sends the message.
- Segmentation spaces no longer leak when switching IME mid-composition.
```

## Credits

If the user wants credits, keep them short and explicit in the body. Example:

- "Thanks @username for helping validate the release flow on macOS."

Do not invent credits automatically.

## In-App Announcement Fragments

Use `.announcements/*.json` for user-visible features or workflow changes that should appear in the compact in-app release toast. Do not include an id or version; release planning binds all pending fragments to the final package version.

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
