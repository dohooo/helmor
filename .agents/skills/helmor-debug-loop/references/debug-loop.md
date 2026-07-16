# Helmor Debug Loop Reference

Use this reference after loading `SKILL.md` when a bug needs iterative local verification.

## Attempt Structure

Each attempt should record:

- Attempt number and timestamp.
- Preconditions: workspace, session, selected model/mode, run action, feature flags, relevant settings.
- Exact user path driven through `$helmor-debug-operate`.
- Evidence collected: screenshot path, DOM/snapshot file, IPC capture, console/system logs, terminal buffer ids, and code probes.
- Result: `reproduced`, `not reproduced`, `flaky`, `fixed`, `blocked`, or `inconclusive`.

Store attempt notes under `.agent-contexts/<task-slug>/attempts.md`.

## Terminal Buffer Commands

When the app has a debug build with the terminal buffer commands registered, use `$helmor-debug-operate`'s **Call App Commands** helper. Do not call the Tauri MCP `ipc_execute_command` tool for these app commands; the current bridge returns `Unsupported Tauri command`.

```json
{ "id": "list-buffers", "command": "debug_list_terminal_buffers", "payload": {} }
```

Pick the relevant item from the returned `repoId`, `workspaceId`, and `scriptType`, then read the tail:

```json
{
  "id": "read-buffer",
  "command": "debug_read_terminal_buffer",
  "payload": {
    "repoId": "REPO_ID",
    "workspaceId": "WORKSPACE_ID_OR_NULL",
    "scriptType": "RAW_SCRIPT_TYPE_FROM_LIST",
    "maxBytes": 200000
  }
}
```

If the helper result says the command is unavailable, fall back to visible xterm screenshots/DOM and mark terminal-buffer evidence as unavailable. Do not block the whole loop on this one signal.

## Reproduction Branches

### Reproduced

1. Freeze the smallest path that reproduces the bug.
2. Add temporary probes only where the next unknown remains.
3. Fix the code.
4. Repeat the same path three times.

### Not Reproduced

After three distinct attempts:

1. Record every precondition and attempt.
2. Inspect the code path that should have handled the user flow.
3. Identify missing preconditions, likely stale recipe, or environment drift.
4. If a low-risk static fix is obvious, make it and verify with available tests; otherwise report `not reproduced` with next recommended probe.

### Flaky

Treat flaky behavior as a valid bug. Preserve a run table with pass/fail state and compare:

- Logs immediately before divergence.
- DOM state before the click/keypress.
- IPC event ordering.
- Terminal/run-script timing.

Fix the race or state leak only after the divergence has a plausible mechanism.

### Blocked

Use `blocked` only when the loop cannot progress without user input or an external state change, such as missing credentials, no running debug build, destructive verification risk, or unavailable Tauri bridge after recovery attempts.

## Temporary Logging Rules

- Use a unique prefix: `[debug-loop:<short-slug>]`.
- Log the smallest state needed: ids, booleans, counts, branch names, command names, elapsed times.
- Avoid secrets and large objects.
- Prefer existing structured logging in Rust/backend and `console.debug` in frontend only when it is removed before final.
- Remove temporary logs before final unless they become intentional product diagnostics.

## Evidence Pack Checklist

Create `.agent-contexts/<task-slug>/evidence.md` with:

- User request and expected behavior.
- Reproduction attempts table.
- Evidence links and summaries.
- Root cause.
- Fix summary.
- Verification table with three pass rows or a clear exception.
- Residual risk and unverified paths.

Use `scripts/terminal_log_summary.py` for terminal text and `scripts/build_evidence_pack.py` to assemble a markdown pack.
