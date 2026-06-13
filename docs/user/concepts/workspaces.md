# Workspaces

A workspace is Helmor's unit of work: one task, one directory, one branch, one
(or more) agent conversations. Understanding workspaces is understanding
Helmor.

## Isolation through git worktrees

By default a workspace is a **git worktree** — a first-class git feature that
gives a repository multiple working directories, each checked out to its own
branch. Helmor creates them under:

```
~/helmor/workspaces/<repo-name>/<workspace-name>/
```

Worktrees share the repository's object store, so they are cheap to create,
but their files are fully independent. That is what makes parallel agents
safe: an agent in one workspace physically cannot touch another workspace's
files, your original clone, or your checked-out `main`.

Each workspace also gets its own **branch**, named from your repository's
branch prefix (e.g. `helmor/fix-login-flow`). You can instead attach a
workspace to an existing branch when creating it — useful for picking up
review feedback on a colleague's PR.

## Workspace modes

| Mode | What it is | When to use it |
| --- | --- | --- |
| **Worktree** (default) | Isolated worktree + branch under `~/helmor/workspaces/` | Almost always |
| **Local** | Operates directly on your existing clone's directory | When you want the agent in your real working copy — e.g. alongside a running dev setup |
| **Chat** | A scratch directory with no git binding | Questions, explorations, anything that isn't a code change (**⌘⇧N**) |

A Local workspace can be converted into a Worktree workspace later
(right-click → *Move to worktree*) — your changes move with it.

## Target branch

Every workspace has an **intended target branch** — the branch its PR will
target and the branch *Pull Latest* merges from. It defaults to the
repository's default branch and can be changed in the branch picker at the top
of the panel. Stacked workspaces target their parent's branch instead
([Stacked PRs](stacked-prs.md)).

**Sync** (*Pull Latest*, ⌘⇧L) merges the target branch into your workspace.
Uncommitted work is stashed first and restored after; if the merge or the
stash restore conflicts, Helmor tells you and you can dispatch the
*Resolve Conflicts* action. Helmor also auto-fetches remotes in the background
every couple of minutes, so ahead/behind counts in the inspector stay honest.

## Lifecycle

```
create ──► setup ──► ready ──► archived ──► (restored | deleted)
```

- **Create** — instant; the worktree and setup run are finalized in the
  background.
- **Ready** — work happens here. Pin it, mark it unread, give it a status
  lane (*In Progress*, *Review*, *Done*, *Backlog*, *Canceled*) to organize
  the sidebar.
- **Archive** — when the work ships. The worktree directory is removed; the
  branch is deleted *only if Helmor auto-generated it* (branches you picked
  yourself are preserved). The conversation history, and the commit the
  workspace was at, are kept.
- **Restore** — recreates the worktree from the recorded commit, with checks
  that the target branch still exists. Local and Chat workspaces restore
  instantly since nothing was deleted.
- **Delete** — permanent: removes database rows, worktree, and files.

Archive can be automated per repository with **archive on merge**, and your
project can run a cleanup script on archive
([Configure your project](../get-started/configure-your-project.md)).

## Renaming and branches

You can rename a workspace's branch at any time (branch picker → rename);
Helmor updates git and its own records atomically. The branch picker also lets
you switch the target branch and create branches from any start point.

## Disk usage

Worktrees are real checkouts, so big repositories add up. Right-click a
workspace → *Open in Finder* to inspect it, and archive workspaces you're done
with — that reclaims the disk while keeping the history.
