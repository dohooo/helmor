---
name: helmor-release
description: Prepare Helmor releases by inspecting the current branch, asking the user a few targeted release questions, and creating or updating a user-facing Changesets entry. Use when the user wants to cut a release, write a changeset, decide patch/minor/major, draft GitHub release notes, or summarize branch changes into release-ready language.
---

# Helmor Release

Use this skill to turn a branch's real changes into a clean `.changeset/*.md` entry for Helmor.

## Workflow

1. Inspect the branch before asking the user anything.
2. Run `scripts/collect_release_context.py` to gather:
   - commits since the base branch
   - changed files grouped by area
   - a short suggested summary
3. Ask the user up to three short questions, one at a time:
   - release bump: `patch`, `minor`, or `major`
   - which user-visible changes to include
   - any exclusions, caveats, or credits
4. Create or update a single changeset file under `.changeset/`.
5. Show the resulting changeset body back to the user for confirmation if the task is interactive.

## Question Style

Keep questions short and concrete.

Preferred pattern:

1. Show the inspected changes in a compressed list.
2. Offer a recommendation first.
3. Accept free-form edits from the user.

Example:

```text
Suggested bump: minor

I found these user-facing changes:
1. In-app auto-update checks and downloaded-update toast
2. macOS signed/notarized release pipeline
3. Release automation with Changesets + GitHub Releases

Which items should be included in the release notes, and should this be patch/minor/major?
```

If structured choice tools are unavailable, ask in plain text and let the user reply naturally.

## Changeset Rules

Write changesets for users, not for maintainers.

Do:

- explain what changed from the user's point of view
- group related work into 2-5 short bullets
- keep bullets concrete and outcome-focused
- mention new workflows or capabilities
- include a short thanks line only if the user explicitly wants credits

Do not:

- dump commit messages verbatim
- list internal refactors unless they changed release behavior
- mention implementation-only details like exact file names
- create multiple changesets for one coordinated release task unless the user asks

## Default Changeset Format

Use this structure:

```md
---
"helmor": minor
---

- Add in-app update checks that download updates in the background and prompt once the update is ready to install.
- Add a signed and notarized macOS release pipeline for GitHub Releases.
- Add release planning automation so Helmor can publish user-facing release notes through Changesets.
```

If the user wants credits, append a final bullet such as:

```md
- Thanks @username for helping validate the release flow.
```

## GitHub Release Notes

Helmor already uses `@changesets/changelog-github` in `.changeset/config.json`.

That means:

- merged PRs and GitHub context are handled by Changesets
- GitHub Release body is derived from `CHANGELOG.md`
- this skill should focus on writing a strong user-facing changeset body

Do not invent a separate release-note format unless the user asks for one.

## Versioning Guidance

Recommend:

- `patch` for fixes, polish, and invisible release improvements
- `minor` for new user-visible features or workflows
- `major` only when behavior changes incompatibly

For Helmor's current early lifecycle, prefer `patch` or `minor`. Escalate to `major` only with a concrete breaking change.

## Resources

- Use `scripts/collect_release_context.py` to inspect the current branch before drafting the changeset.
- Use `references/release-format.md` if you need the exact Helmor release flow or writing guidance.
