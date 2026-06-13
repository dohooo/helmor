# Troubleshooting

## First stop: the logs

Helmor writes structured JSONL logs to `~/helmor/logs/`. When something
misbehaves, the most recent file there usually says why. Attach the relevant
lines when reporting a bug.

## GitHub / GitLab auth stopped working

Symptoms: PR status missing, *Create PR* / *Merge* failing with auth errors.

1. Open **Settings → Accounts** and check the account state.
2. Re-authenticate from there — the `gh auth login` / `glab auth login` flow
   runs in an embedded terminal.
3. Multiple accounts: each repository binds to one login. If a repo shows the
   wrong account or none, retry the binding from the repository settings.

## Workspace creation fails

- **"Repository has no remote"** — Helmor needs at least one git remote
  (usually `origin`) to create worktree workspaces. Add one:
  `git remote add origin <url>`.
- **Branch name collisions** — if a branch with the generated name already
  exists, pick a different workspace name or attach to the existing branch
  explicitly.

## Setup script failed

The workspace is created anyway, in a *setup pending* state. Fix the script
(repository settings → Scripts, or `helmor.json`) and re-run setup from the
workspace. Remember setup runs in a fresh worktree: untracked files from your
main clone (like `.env.local`) aren't there unless your script copies them —
see [Configure your project](../get-started/configure-your-project.md).

## Pull Latest reports conflicts

*Pull Latest* stashes your uncommitted work, merges the target branch, and
restores the stash. Two things can conflict:

- **The merge itself** — Helmor aborts cleanly and offers
  **Resolve Conflicts**, which dispatches an agent at the conflict markers.
  You can also resolve by hand in the editor or a terminal.
- **The stash restore** — your uncommitted changes overlap the merged ones.
  The work is safe in the stash; resolve in a terminal (`git stash pop` after
  fixing) or let the agent sort it out.

## An agent turn hangs or errors

- **Stop** the turn — the session stays usable; send again to continue.
- Check the provider sign-in (Claude Code / Codex login, API keys in
  Settings → Models).
- Behind a proxy? Configure it in Settings — agent processes inherit the
  system or custom proxy you set there.

## The `helmor` CLI isn't found

- Install it via **Settings → Experimental → Command Line Tool**.
- On Windows, open a *new* terminal after installing so the updated `PATH` is
  visible.
- `helmor cli-status` reports what's installed and which data directory it
  points at.

## Updates won't install

Check **Settings → App Updates** for state, then the logs. As a fallback,
download the latest release from
[GitHub releases](https://github.com/dohooo/helmor/releases) and install over
the existing app — your data in `~/helmor/` is untouched.

## Disk usage creeping up

Worktrees are full checkouts. Archive workspaces you're done with — that
removes their directories while keeping history. The sidebar's right-click
menu and `helmor workspace archive` both work.

## Still stuck?

- [Discord](https://discord.gg/ukyyuNfnDp) — fastest answers
- The feedback button at the bottom of Helmor's sidebar (can attach
  screenshots)
- [GitHub issues](https://github.com/dohooo/helmor/issues)
