# `/helmor-cli break` — split an existing change into a stack

`break` is the mirror of `stack`: instead of planning a stack from scratch, it
takes the change you've **already written** in the current workspace and carves
it into a stack of small, dependent PRs — **confirming the slicing granularity
with the user** before committing to anything. The output is the normal stack:
one workspace + PR per slice, nested in the sidebar.

**Input**: the current workspace's full diff vs its base branch. The current
workspace becomes the stack's **root**, so capture a recovery ref before you
rewrite anything:
```bash
git commit -am "WIP: snapshot before break"   # only if the working tree is dirty
ORIG=$(git rev-parse HEAD)                      # the full change you're slicing
git branch helmor/break-backup "$ORIG"          # named recovery point
```
Source every slice below from `$ORIG` (not the branch name) — once the root is
reset, the branch no longer points at the full change.

## Workflow

### 1. Analyze the diff
```bash
git diff --name-status <base>...
```
(`<base>` is the workspace's target branch, e.g. `origin/main` — the system
prompt tells you which.) Read the changed files and their add/modify/delete
status, and group them by concern (schema/data, backend/API, UI, tests, docs…).

### 2. Propose a slicing
Build a **dependency-ordered** list of slices (bottom depends on nothing new;
top depends on everything below), e.g. `db → api → ui`. For each slice give: a
title, the files it contains, and the one-line reason it depends on the slice
below. Show the full proposal.

### 3. Confirm granularity WITH the user — the point of `break`
Do NOT auto-split. Present the proposal and let the user steer the granularity
with structured choices:
- **Approve** as-is.
- **Coarser** — merge two adjacent slices.
- **Finer** — split a slice (e.g. pull tests into their own layer).
- **Move a file** — reassign a file to a different slice.
- **Reorder** — fix the dependency order.

Loop until the user approves. Also **proactively ask** about ambiguous files — a
single file whose changes span concerns (e.g. `utils.ts` with both schema and UI
helpers): keep it whole in one slice, or flag it for a manual hunk-level split
(out of scope for v1 — see Limits).

### 4. Materialize the stack (bottom-up) — your current workspace becomes the root
The workspace you're in becomes the **bottom** layer; only the higher layers are
new workspaces. No throwaway launchpad, nothing to delete afterward.

For each slice K, from the bottom up:

1. Get the layer's workspace:
   - **bottom slice (root) = your current workspace** — reset it onto the base and
     rebuild it as slice 1 only:
     ```bash
     git reset --hard <base>                  # e.g. origin/main — the slicing base
     git checkout "$ORIG" -- <slice-1 added/modified files>
     git rm <slice-1 deleted files>           # if any
     git commit -m "<slice 1 title>"
     ```
   - **every higher slice**: `helmor workspace new --parent <slice K-1 workspace>`
     (the first higher layer's `--parent` is your current workspace).
2. Apply **only slice K's files** onto that layer (it already contains slices
   1..K-1 because it forked off the layer below), sourcing from `$ORIG`:
   - added / modified files: `git checkout "$ORIG" -- <files>`
   - deleted files: `git rm <files>`
   - then commit with the slice title.

   Drive each higher layer with a focused dispatch so it works inside its own
   worktree (pass `$ORIG`'s SHA explicitly; `helmor/break-backup` resolves it too):
   ```bash
   helmor send --workspace <id> --plan "Apply ONLY these files from <ORIG-sha>: <list>. \
   Added/modified: git checkout <ORIG-sha> -- <files>. Deleted: git rm <files>. \
   Commit as '<title>'. Do not touch anything else."
   ```

Result: layer K = base + slices 1..K (cumulative); the top layer reproduces the
original change exactly.

### 5. Verify lossless
The stack must reproduce the original exactly:
```bash
git diff "$ORIG" <top-layer-branch>
```
**This must be empty.** Empty = the top of the stack has the same tree as the
original → nothing was dropped or duplicated. If it is **not** empty, STOP and
report the difference — and restore the root with `git reset --hard helmor/break-backup`.

### 6. Hand off
Your current workspace is now the stack's **root**; the higher layers are the
only new workspaces (`helmor workspace stack <top>` shows the chain; the sidebar
nests them). Open PRs bottom-up. Consider retitling the root to its slice-1
title. Once you've confirmed the split is faithful, the recovery branch is yours
to keep or drop (`git branch -D helmor/break-backup`).

## Limits (v1)
- **File-level slices only**: a file goes wholesale into one slice. Splitting a
  single file's changes across slices (hunk-level) isn't supported yet — flag
  such files in step 3 and keep them in one slice.
- Slices must **partition** all changed files; the step-5 lossless check
  enforces it.
- **Root = your current workspace**: its branch is rewritten in place to become
  slice 1. The full change stays recoverable at `helmor/break-backup` (and is
  reproduced at the stack tip + checked in step 5), so it's safe — but unlike a
  fresh-stack build, the starting branch *is* rewritten. Higher layers are new
  workspaces.
