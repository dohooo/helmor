# Stacked PRs

Some changes are too big for one PR but too interdependent for parallel
workspaces. Stacking solves this: a chain of workspaces where each builds on
the previous one, reviewed and merged as a sequence of small PRs.

## How a stack works in Helmor

When you create a **stacked workspace** from an existing workspace:

- the child's branch is created **from the parent's branch** (not from the
  repository's default branch);
- the child's **target branch is the parent's branch**, so its PR shows only
  its own changes;
- the sidebar nests the child under its parent, so the stack reads
  root → tip.

Example: workspace A introduces a new API, stacked workspace B migrates
callers to it, stacked C deletes the old path. Three reviewable PRs, one
dependency chain.

## Working with a stack

- **Inspect it** — right-click → stack view in the app, or:

  ```bash
  helmor workspace stack myapp/new-api
  ```

  which prints the chain from root to tip.

- **Keep children fresh** — when a parent gains commits, run *Pull Latest* in
  the child to merge the parent's branch in (the child's target branch *is*
  the parent).

- **Merge bottom-up** — merge the root PR first. As lower layers merge,
  retarget and sync the remaining children; Helmor keeps each child's PR
  pointed at its parent's branch and updates targets when a stack is
  restored or rearranged.

## When to stack vs. when to parallelize

| Situation | Use |
| --- | --- |
| Independent tasks | Separate workspaces ([Parallel agents](parallel-agents.md)) |
| One big change, reviewable in slices | A stack |
| Exploratory work that might be thrown away | A single workspace, split later |

Stacks shine when review latency is the bottleneck: reviewers approve small
PRs faster, and the agent can keep building on unmerged layers instead of
waiting.
