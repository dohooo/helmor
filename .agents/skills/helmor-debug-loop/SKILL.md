---
name: helmor-debug-loop
description: Autonomous local-development debugging loop for Helmor bugs. Use when the user asks an agent to reproduce, diagnose, instrument, fix, or verify a Helmor local dev build issue using repeated local UI simulation, temporary logging, Tauri MCP/towery MCP, screenshots, DOM/accessibility snapshots, IPC traces, console/system logs, terminal/run-script logs, or multi-attempt verification. This skill coordinates with $helmor-debug-operate for operating the running desktop app.
---

# Helmor Debug Loop

Use this skill to drive a bounded reproduce -> instrument -> inspect -> fix -> verify loop for Helmor local-dev bugs. Always use `$helmor-debug-operate` for actual local app control through Tauri MCP; this skill owns the debugging strategy and evidence discipline.

## Core Loop

1. Define the suspected behavior, expected behavior, and success signal in one or two sentences.
2. Reproduce through `$helmor-debug-operate` with real UI actions when possible. Start with screenshots, DOM/accessibility snapshots, IPC monitor, console/system logs, and terminal buffers.
3. If evidence is insufficient, add the smallest temporary log or probe with a unique prefix such as `[debug-loop:<slug>]`, rerun the flow, then remove or justify the probe before finalizing.
4. Analyze the evidence before editing product code. Prefer a narrow fix that explains the observed signal.
5. Verify the fix with the same user path. For user-visible flows, require three consecutive successful runs unless the user explicitly lowers the bar.
6. Produce an evidence pack under `.agent-contexts/<task-slug>/` with repro attempts, logs, screenshots, IPC, fix summary, and remaining uncertainty.

## Fault Tolerance

- If you cannot reproduce after three distinct attempts, do not invent a failure. Mark the state as `not reproduced`, preserve evidence, inspect code paths that should have fired, and report the most likely missing precondition.
- If the bug is flaky, run at least three attempts and compare evidence. Treat intermittent pass/fail as a valid finding, not a failure of the loop.
- If Tauri MCP cannot connect, use `$helmor-debug-operate` recovery steps. If the bridge remains unavailable, fall back to static code analysis and terminal tests, and label UI verification as blocked.
- If a skill recipe fails three times, follow `$helmor-debug-operate` stale-skill rules: reason from fresh screenshots/DOM/code, record a candidate skill update, and ask before editing that skill unless the user explicitly requested it.
- If adding logs risks exposing secrets, log shape/count/state only. Never print access tokens, credentials, API keys, cookies, or private account details.
- If verification cannot be run safely because it would mutate durable user data, switch to a disposable workspace/session or stop and state the risk.

## Evidence Sources

Use the available signals in this order:

- Terminal buffers: use `$helmor-debug-operate`'s **Call App Commands** helper to run `debug_list_terminal_buffers`, then `debug_read_terminal_buffer` with the returned raw `scriptType`.
- UI state: screenshot plus accessibility or structure snapshot.
- IPC: start monitor, perform one action, capture filtered commands/events, then stop monitor.
- Logs: Tauri console/system logs, sidecar JSONL logs under the dev data dir when relevant.
- Code probes: temporary logs with unique prefixes, guarded by debug context when possible.

Read `references/debug-loop.md` when the task needs the full loop checklist or when reproduction fails. Use scripts in `scripts/` to summarize logs and build evidence packs instead of pasting raw dumps into the chat.
