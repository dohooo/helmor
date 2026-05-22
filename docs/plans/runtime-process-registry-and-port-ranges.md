# Runtime Process Registry and Port Ranges

Related issues: [#303](https://github.com/dohooo/helmor/issues/303), [#514](https://github.com/dohooo/helmor/issues/514)

## Goal

Make Helmor's run-script and embedded-terminal runtime safer for long-running, parallel workspaces:

- inject a persistent per-workspace port range through `HELMOR_PORT` and `HELMOR_PORT_COUNT`;
- stop all Helmor-owned terminal/run-script process groups during graceful quit;
- create a path toward conservative stale-process cleanup after crashes.

This is the highest-confidence backend contribution because #303 already has maintainer encouragement and #514 describes a concrete current bug.

## Pi-Informed Principle

Pi treats runtime ownership as backend state. A supervisor owns process groups, sandbox resources, egress policy, and cleanup. Helmor currently owns live script/terminal processes in `ScriptProcessManager`, but the ownership is in-memory and not included in the graceful quit path.

The first Helmor step should be modest: make existing runtime ownership explicit enough that normal shutdown and parallel workspaces behave predictably.

## Proposed MVP

1. Add a persistent workspace port allocation.
   - Add `workspaces.port_base INTEGER` and `workspaces.port_count INTEGER DEFAULT 10`, or a focused sibling table if maintainers prefer avoiding more workspace columns.
   - Allocate lazily the first time a workspace needs script env, or eagerly at workspace creation.
   - Default base can be an app constant such as `55100`, with `10` ports per workspace.
   - Ensure active/non-archived workspaces do not overlap.

2. Inject the env vars in `run_script_with_shell`.
   - Existing envs are `HELMOR_ROOT_PATH`, `HELMOR_WORKSPACE_PATH`, `HELMOR_WORKSPACE_NAME`, and `HELMOR_DEFAULT_BRANCH`.
   - Add `HELMOR_PORT` and `HELMOR_PORT_COUNT` when the workspace has an allocation.

3. Add `ScriptProcessManager::kill_all`.
   - Reuse the existing process-group kill logic.
   - Mark each handle as killed.
   - Avoid holding the process map lock while signaling groups.

4. Call process cleanup from `request_quit`.
   - The graceful quit path already stops watchers, optionally aborts agent streams, and shuts down the sidecar.
   - Add script/terminal cleanup before sidecar shutdown or immediately after stream abort.

## Follow-Up

Add a lightweight runtime registry for crash recovery, but keep it conservative:

- record `repo_id`, `workspace_id`, `script_type`, `pid`, `pgid`, `started_at`, and `ended_at`;
- on startup, detect still-open rows and warn first;
- only auto-kill when Helmor can prove ownership, not merely because a port is busy.

The proof-of-ownership problem matters because PIDs and process groups can be reused after a crash. Do not blindly kill by port.

## Backend Touch Points

- `src-tauri/src/workspace/scripts.rs`
- `src-tauri/src/commands/system_commands.rs`
- `src-tauri/src/schema.rs`
- `src-tauri/src/models/workspaces.rs`
- `src-tauri/tests/schema_migrations.rs`
- command tests under `src-tauri/src/commands/tests/`

## Test Plan

- Rust unit test: `ScriptProcessManager::kill_all` signals all registered process groups and leaves unrelated processes alone.
- Rust unit test: registering two workspaces receives distinct port ranges.
- Schema migration snapshot: legacy DB gets nullable/default port columns.
- Script env test: spawned shell sees `HELMOR_PORT` and `HELMOR_PORT_COUNT`.
- Quit-path test where feasible: `request_quit(force=true)` invokes script cleanup.

## PR Shape

Keep this as two PRs if possible:

1. `HELMOR_PORT` allocation and env injection.
2. Shutdown cleanup for live script/terminal process groups.

Both are independently useful and easier to review than a broad runtime registry PR.

