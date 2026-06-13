# Review & ship

The inspector (right panel, **⌘⌥B**) is where agent output becomes shipped
software. It has four sections: actions, changes, terminals, and run scripts.

## Changes

Every modified file in the workspace, as a tree:

- status badges (modified / added / deleted) and per-file +/− line counts;
- click a file to open its **diff** — side-by-side or unified, fully
  syntax-highlighted;
- **⌘E** flips the diff into edit mode when you want to fix something
  yourself ([Editor](editor.md));
- right-click for *Reveal in Finder*, *Copy path*, or *Open on
  GitHub/GitLab*.

## Actions

The action area reads the workspace's git and PR state — uncommitted changes,
conflicts, ahead/behind the target branch, PR status, CI checks — and offers
the next sensible step as a button:

| Action | Shortcut | What it does |
| --- | --- | --- |
| **Commit & Push** | ⌘⇧Y | Commit all changes and push the branch |
| **Create PR / MR** | ⌘⇧P | Open a pull request against the target branch |
| **Pull Latest** | ⌘⇧L | Merge the target branch into the workspace (stashes and restores uncommitted work) |
| **Merge** | ⌘⇧M | Merge the PR (uses the repo's allowed merge method) |
| **Fix CI** | ⌘⇧X | Dispatch an agent at the failing checks |
| **Resolve Conflicts** | — | Dispatch an agent at the merge conflicts |
| **Open PR** | ⌘⇧G | Open the PR in your browser |

Notes:

- *Commit & Push*, *Create PR*, *Fix CI*, and *Resolve Conflicts* are
  agent-dispatched — they start a session you can watch and steer like any
  other.
- *Merge* respects branch protection: if checks are still running or the PR
  is blocked, the button says so instead of failing.
- PR state (open / merged / closed) and check results refresh automatically;
  Helmor also background-fetches the remote so ahead/behind counts stay
  current.

Works with **GitHub** and **GitLab**, via the accounts you connected during
onboarding.

## Terminals

Open real terminals in the workspace directory — multiple tabs, full color:

- **⌘⇧J** — focus the terminal section
- **⌘T / ⌘W** — new / close terminal (while the terminal is focused)

Anything you'd normally do in a checkout — `git log`, one-off scripts, manual
testing — works here without leaving the app.

## Run scripts

Your project's configured actions (dev server, tests, builds) appear in the
scripts panel:

- **⌘J** — toggle the panel
- **⌘R** — run / stop the selected script

Output streams in with color; the sidebar glows on workspaces with active
scripts. Configure the actions in
[`helmor.json`](../get-started/configure-your-project.md).

## After the merge

Archive the workspace — manually, or automatically with the per-repository
**archive on merge** setting. See
[Workspaces → Lifecycle](../concepts/workspaces.md#lifecycle).
