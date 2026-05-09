---
name: helmor-release
description: Prepare Helmor releases by inspecting the current branch, drafting a concise user-facing Changesets entry first (bump + body — keep it as short as possible: a single sentence by default, summary + bullets only when there are multiple distinct user-visible items), writing it to `.changeset/`, and then showing the user the result with a short menu of adjustments they can pick from. Use when the user wants to cut a release, write a changeset, decide patch/minor/major, draft GitHub release notes, or summarize branch changes into release-ready language.
---

# Helmor Release

Use this skill to turn a branch's real changes into a clean `.changeset/*.md` entry for Helmor.

## Workflow

1. Inspect the branch before asking the user anything.
2. Run `scripts/collect_release_context.py` to gather:
   - commits since the base branch
   - changed files grouped by area
   - a short suggested summary
3. Draft the full changeset yourself, without asking the user upfront. Decide:
   - the bump (`patch` / `minor` / `major`) using the Versioning Guidance below
   - the body shape — **one prose sentence** when one sentence is genuinely enough, or **summary line + bullets** when there are multiple distinct user-visible changes (see Default Changeset Format)
   - the actual prose / bullets

   Prefer a conservative bump (`patch` unless there is a clear new user-visible capability). If you genuinely cannot decide the bump from the diff alone, default to `patch` and flag it in the confirmation step.

   **Brevity bias.** Aim for the shortest sentence that names the user-visible change — if a clause can be dropped without losing meaning, drop it. Reserve summary+bullets for releases with ≥2 distinct user-visible items.
4. Write the changeset to a single file under `.changeset/` right away. Do not wait for approval before creating the file — the user will adjust from a real draft, not a hypothetical one.
5. Then, and only then, show the user what you created and offer the adjustment menu described in "Confirmation Style".

## Confirmation Style

Do not ask the user anything before the draft is written. Once the changeset file exists, report what you created and offer a short menu of adjustments.

Preferred pattern:

1. State the file path you created.
2. Echo back the chosen bump and the body (single sentence, or summary+bullets) in a compact block.
3. Present a numbered menu of the things the user might want to change. The user picks any subset (e.g. "1 and 3") or says nothing / "looks good" to accept. Never phrase this as an open question like "do you approve?".

Example (Shape A — single sentence):

```text
I've written .changeset/brave-otters-smile.md:

  bump: patch
  body: Fix the context-usage ring resetting to zero when switching the active model.

If you want to adjust anything, tell me which:
  1. Version bump (currently: patch — say "make it minor" / "make it major")
  2. Rewrite the body
  3. Expand into summary + bullets
  4. Add a thanks/credits line

Otherwise we're done — no reply needed.
```

Example (Shape B — multi-change):

```text
I've written .changeset/brave-otters-smile.md:

  bump:    minor
  summary: Ship a round of release and auto-update improvements:
  bullets:
    - Add in-app update checks that download updates in the background ...
    - Add a signed and notarized macOS release pipeline ...
    - Add release planning automation ...

If you want to adjust anything, tell me which:
  1. Version bump (currently: minor — say "make it patch" / "make it major")
  2. Summary line
  3. The bullet list (add / remove / rewrite specific items)
  4. Collapse to a single sentence
  5. Add a thanks/credits line

Otherwise we're done — no reply needed.
```

If structured choice tools are unavailable, present the menu in plain text and let the user reply naturally.

## Changeset Rules

Write changesets for users, not for maintainers.

Do:

- explain what changed from the user's point of view, as briefly as possible
- use **one sentence** when one sentence cleanly conveys the change
- use **summary line + bullets** only when there are multiple distinct user-visible changes
- keep prose / bullets concrete and outcome-focused
- mention new workflows or capabilities
- include a short thanks line only if the user explicitly wants credits

Do not:

- dump commit messages verbatim
- list internal refactors unless they changed release behavior
- mention implementation-only details like exact file names
- create multiple changesets for one coordinated release task unless the user asks
- pad a single-change PR with bullets just to fit the summary+bullets template
- start the changeset body with a `- ` bullet (see format rule below)

## Default Changeset Format

The body has **two allowed shapes**. Pick the smallest one that fits.

**Shape A — single sentence.** Use this when one self-contained sentence captures the entire user-visible change. This is the default for most patch-level fixes and small polish PRs. Keep it as short as possible.

**Shape B — summary line + bullets.** Use this only when there are ≥2 distinct user-visible changes worth enumerating. The first line is a prose summary (usually ending with `:`); each concrete change is a `- ` sub-item underneath.

`@changesets/changelog-github` inlines the first line of the body after `Thanks @user! -` when rendering `CHANGELOG.md` / GitHub Release. A single prose sentence renders cleanly. A leading `- ` would produce `! - - Fix X` with the first item glued to the attribution. **Never start the body with `- `.**

Decision rule: if you find yourself writing a summary that just restates the one bullet underneath it, collapse to Shape A. If a single sentence would force you to cram multiple ideas with "and"/";", expand to Shape B.

### Shape A example (single sentence)

```md
---
"helmor": patch
---

Fix a Chinese IME regression in the composer so pressing Enter to confirm an IME candidate no longer accidentally sends the message.
```

### Shape B example (multi-change)

First line is a prose summary ending with `:`. Bullets start from the next line:

```md
---
"helmor": minor
---

Ship a round of release and auto-update improvements:
- Add in-app update checks that download updates in the background and prompt once the update is ready to install.
- Add a signed and notarized macOS release pipeline for GitHub Releases.
- Add release planning automation so Helmor can publish user-facing release notes through Changesets.
```

This renders cleanly as:

```md
- [#NN] [`hash`] Thanks @user! - Ship a round of release and auto-update improvements:
  - Add in-app update checks ...
  - Add a signed and notarized macOS release pipeline ...
  - Add release planning automation ...
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
