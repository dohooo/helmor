# `/helmor-cli stack` — plan & build a stacked PR

Turn a large change into a **stack of small, dependent PRs** — each PR builds on the one below instead of all branching from `main`. This keeps every PR small and reviewable while you keep moving, without waiting for the previous one to merge.

In Helmor a stack is a **chain of workspaces**: one workspace = one branch = one PR, linked by `parentWorkspaceId`. The sidebar groups a stack's workspaces together (tip on top, base at the bottom); `gh pr create --base` automatically targets the parent branch.

## Workflow

### 1. Investigate prior art FIRST
Before proposing a stack, check whether related work already exists, so you **extend** it instead of duplicating it.

- `helmor workspace list --json` — scan open workspaces for related branches or an in-flight stack (rows in the same repo, or already linked by a parent).
- `helmor workspace stack <ref>` — if a candidate is already stacked, see its whole chain.
- `helmor workspace show <ref>` — inspect a candidate's branch, target, and PR.
- `gh pr list` / search the repo — find related open PRs and code.

Report what you found in one line, e.g. *"you already have open PR #481 adding the schema column — the stack can start on top of it"* — that beats starting from scratch.

### 2. Decompose into an ordered stack
Break the task into the **smallest sequence of PRs where each depends only on the ones below it**. Order bottom-up by dependency, e.g. data/schema → backend → UI. For each layer, state the one-line reason it depends on the layer below.

### 3. Render the plan — always, deterministically
Always render through the bundled script so the diagram is byte-for-byte identical every time — **never hand-draw the ASCII**. Two sources, one renderer:

- **From a stack that already exists** (workspaces are created): pipe the live data straight through —
  ```bash
  helmor workspace stack <ref> --json | python3 scripts/render_stack.py -
  ```
- **From a plan you're proposing** (nothing created yet): build a JSON stack spec (see `references/stack-spec.md`, layers ordered tip → root) and render it —
  ```bash
  python3 scripts/render_stack.py /path/to/spec.json
  ```

(Sanity-check the renderer any time with `python3 scripts/render_stack.py --selfcheck`.) Show the rendered stack to the user before creating anything.

### 4. Grow the stack lazily — one layer at a time
Do **not** create every workspace up front (you'll guess the decomposition wrong before you've learned anything). Create the **bottom** layer, build it, then grow upward as each layer stabilizes:

- **Bottom of the stack** = **your current workspace** (the one you're running in). It already targets the repo's default branch, so build the first layer's change directly here — do NOT spin up a separate `--repo` workspace for the base. The workspace you started from becomes the stack's root, instead of being left behind as an empty launchpad to delete later.
- **Each higher layer** (forks off the layer below; its PR targets the parent): `helmor workspace new --parent <lower-workspace-ref>` — the first higher layer's `<lower-workspace-ref>` is your current workspace.

`--parent` records `parentWorkspaceId` **and** materializes the child's target branch to the parent's branch — so the sidebar nests the stack and `gh pr create --base` targets the parent with no extra steps. The child forks off the parent's branch tip (published `origin/<branch>` if pushed, else the local tip), so you can stack before pushing.

### 5. Ship bottom-up
Ship and merge the **bottom** PR first. After a lower layer changes or merges, re-sync the layers above it with `/helmor-cli restack` (see `references/restack.md`).

## Notes
- Keep each PR small and independently reviewable — that's the whole point of stacking.
- The diagram from step 3 is the **textual twin** of the sidebar's stack grouping — same order (tip on top, base at the bottom). Keep them consistent by always rendering through the script.
- A stack is single-repo: every layer lives in the same repository as its parent.
