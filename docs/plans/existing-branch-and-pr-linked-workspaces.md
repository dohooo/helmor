# Existing Branch and PR-Linked Workspaces

Related issues: [#508](https://github.com/dohooo/helmor/issues/508), [#477](https://github.com/dohooo/helmor/issues/477)

## Goal

Let Helmor start work from durable external anchors:

- use an existing branch as the workspace branch instead of always creating a new branch;
- create or enrich sessions from GitHub/GitLab issue and PR/MR URLs;
- for PR/MR URLs, check out the right branch/ref and persist the association.

This is the second-best contribution target because #508 has maintainer confirmation that Helmor should eventually support both "from a branch" and "use a branch".

## Pi-Informed Principle

Pi's missions/runs have durable identities and parent/child relationships. Work does not live only in a prompt; it is tied to a mission directory, run rows, assertions, workers, and evidence.

For Helmor, the equivalent durable anchors are:

- a workspace branch/ref;
- a linked issue, PR, MR, or discussion;
- a session that can be found later from that external artifact.

## Proposed Data Model

Add a focused `session_links` table rather than overloading `session_messages`:

```sql
CREATE TABLE IF NOT EXISTS session_links (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    workspace_id TEXT,
    provider TEXT NOT NULL,
    kind TEXT NOT NULL,
    external_url TEXT NOT NULL,
    owner TEXT,
    repo TEXT,
    number INTEGER,
    title TEXT,
    state TEXT,
    metadata_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Use this table for command-palette search and for rendering linked source context later.

## Existing Branch MVP

1. Introduce a backend creation mode:
   - `newBranchFrom`: current behavior;
   - `useExistingBranch`: attach the workspace to an existing local or remote branch.

2. Resolve branch existence explicitly.
   - Local branch exists: `git worktree add <workspace_path> <branch>`.
   - Remote branch exists only: fetch and create a local tracking branch or worktree from remote ref, depending on existing Git helper conventions.
   - Branch already checked out in another worktree: return a clear error with recovery guidance.

3. Store branch provenance.
   - `workspaces.branch`: the branch actually used.
   - `initialization_parent_branch`: for "new branch from X", keep X.
   - `intended_target_branch`: keep merge target semantics distinct from the workspace's own branch.

## PR/MR Link MVP

1. Add URL normalization for GitHub PR/issue and GitLab MR/issue URLs.
2. Add a command that resolves the URL to metadata through the existing forge backends.
3. Create a session link row.
4. For PR/MR workspace creation:
   - fetch the PR/MR branch/ref;
   - use the existing-branch mode;
   - write `pr_url`, `pr_title`, and `pr_sync_state` if the workspace is change-request-linked.

## Backend Touch Points

- `src-tauri/src/workspace/lifecycle.rs`
- `src-tauri/src/workspace/branching.rs`
- `src-tauri/src/git/ops.rs`
- `src-tauri/src/forge/github/*`
- `src-tauri/src/forge/gitlab/*`
- `src-tauri/src/schema.rs`
- `src-tauri/src/models/sessions.rs`
- `src-tauri/src/models/workspaces.rs`
- `src-tauri/src/commands/workspace_commands.rs`
- `src-tauri/src/commands/forge_commands.rs`

## Test Plan

- Git fixture: use existing local branch without creating a new branch.
- Git fixture: use remote-only branch after fetch.
- Error test: branch already checked out by another worktree.
- URL parser tests for GitHub issue/PR and GitLab issue/MR.
- Schema migration snapshot for `session_links`.
- Command test: create session link and retrieve/search it.

## PR Shape

Recommended split:

1. Existing-branch backend mode and tests.
2. `session_links` schema and metadata commands.
3. PR/MR URL workspace creation.

Do not start with the command palette UI. The backend model can be merged first and used by multiple surfaces later.

