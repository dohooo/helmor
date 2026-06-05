# `/helmor-cli break` — split an existing change into a stack

`break` is the mirror of `stack`: instead of planning a stack from scratch, it
takes the change you've **already written** in the current workspace and carves
it into a stack of small, dependent PRs — **confirming the slicing granularity
with the user** before committing to anything. The output is the normal stack:
one workspace + PR per slice, nested in the sidebar.

**Input**: the current workspace's full diff vs its base branch. If the working
tree is dirty, commit a WIP snapshot first so there's a stable diff to slice.

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

### 4. Materialize the stack (bottom-up)
For each slice K, from the bottom up:

1. Create its workspace:
   - bottom slice: `helmor workspace new --repo <repo>`
   - every higher slice: `helmor workspace new --parent <slice K-1 workspace>`
2. Apply **only slice K's files** onto that layer (it already contains slices
   1..K-1 because it forked off the layer below):
   - added / modified files: `git checkout <original-branch> -- <files>`
   - deleted files: `git rm <files>`
   - then commit with the slice title.

   Drive each layer with a focused dispatch so it works inside its own worktree:
   ```bash
   helmor send --workspace <id> --plan "Apply ONLY these files from branch <original>: <list>. \
   Added/modified: git checkout <original> -- <files>. Deleted: git rm <files>. \
   Commit as '<title>'. Do not touch anything else."
   ```

Result: layer K = base + slices 1..K (cumulative); the top layer reproduces the
original change exactly.

### 5. Verify lossless
The stack must reproduce the original exactly:
```bash
git diff <original-branch> <top-layer-branch>
```
**This must be empty.** Empty = the top of the stack has the same tree as the
original → nothing was dropped or duplicated. If it is not empty, report the
difference and STOP — the slicing missed or double-counted something.

### 6. Hand off
You now have N stacked workspaces (`helmor workspace stack <top>` shows the
chain; the sidebar nests them). Open PRs bottom-up. The **original workspace is
left untouched** — archive it once you've confirmed the split is faithful.

## Limits (v1)
- **File-level slices only**: a file goes wholesale into one slice. Splitting a
  single file's changes across slices (hunk-level) isn't supported yet — flag
  such files in step 3 and keep them in one slice.
- Slices must **partition** all changed files; the step-5 lossless check
  enforces it.
- **Non-destructive**: never delete or rewrite the original workspace's branch.
