---
name: helmor-debug-operate
description: Operate, reproduce, and debug a running local Helmor desktop development build through the Tauri MCP bridge. Use when the user asks to use Tauri MCP, towery MCP, the local dev build, the Tauri webview, visual end-to-end validation, UI automation, screenshots, DOM/accessibility snapshots, IPC or log tracing, terminal/run-script buffer inspection, switching workspaces or sessions, creating/renaming/closing sessions, typing or sending composer prompts, inspecting styles/logs, or reproducing Helmor desktop behavior as a user would.
---

# Helmor Debug Operate

Use this skill to operate and debug a running Helmor dev build through Tauri MCP with the least possible exploration. It is the visual/runtime counterpart to `helmor-cli`: prefer Tauri MCP for webview UI, screenshots, CSS, accessibility, and IPC tracing; prefer `helmor-cli` for terminal-first data inspection or workspace orchestration.

Examples below use bare tool names such as `driver_session`; call the same tool through whatever namespace the runtime exposes.

## References

Read these only when needed:

- `references/verified-recipes.md` for action-specific recipes that have passed three consecutive Tauri MCP verification attempts.
- `references/ui-map.md` for selectors, Settings panels, Inspector/Editor preconditions, and destructive-action boundaries.

## Ground Rules

- Treat every action as real user input against the active app. Do not send prompts, close sessions, archive/delete workspaces, stop streams, or mutate settings unless the user asked for that outcome or it is necessary for the verification.
- Use the Tauri MCP bridge only for Helmor desktop debugging. Do not switch to Chrome DevTools, Browser, Playwright, or `/agent-browser` unless the user explicitly asks for another surface.
- Require a debug Tauri build. The bridge is absent in release builds. If connection fails, ask the user to run `bun run dev` or call `get_setup_instructions` only when bridge setup itself is suspect.
- Default to `port: 9223` and `windowId: "main"`.
- Re-run `webview_dom_snapshot` after every meaningful UI change. `ref=eN` handles are per-snapshot and expire after DOM changes.
- Prefer accessibility snapshots for finding controls, but fall back to structure snapshots and read-only DOM rect inspection when accessibility support is unavailable.
- Prefer UI operations for end-to-end validation. Do not use the Tauri MCP tool `ipc_execute_command` for Helmor app commands such as `list_workspace_groups`, `reveal_workspace_in_main_window`, or `debug_list_terminal_buffers`: the current bridge returns `Unsupported Tauri command` because dynamic app-command execution is not implemented there. Use the verified app-command helper in **Call App Commands** instead.
- Do not use `webview_execute_js` to dispatch synthetic user events. Use it only for read-only, JSON-serializable inspection when MCP tools cannot answer the question.
- Exception: Helmor's composer is a Lexical `contenteditable`, not a native input. If `webview_keyboard type` fails with the current bridge, `document.execCommand("insertText", false, text)` after real MCP focus/click is the last-resort smoke-test input path. Label it as a fallback and verify visible state afterward.
- If you start `ipc_monitor`, always stop it before finishing, even if the task fails.
- Save screenshots or scratch logs under `.agent-contexts/<task-slug>/` when working inside this repository.
- If a Settings dialog appears stuck visible with `data-state="closed"`, press `Cmd+,` to reopen it, then `Escape` to close. Verify `document.querySelectorAll('[role="dialog"]').length === 0` and `main[aria-hidden]` is absent.
- If `webview_execute_js` or console log reads start timing out while screenshots and `driver_session status` still work, restart only the MCP driver session (`driver_session stop appIdentifier=9223`, then `driver_session start port=9223`). Do not restart the Helmor dev build unless the bridge cannot reconnect.
- If you launch a disposable app with `HELMOR_DATA_DIR` for validation, create both the data dir and its `run/` subdir first. Missing `run/` can make the UI sync socket fail to bind, leaving backend mutations invisible until you force a reveal or restart.
- Treat this skill as an operation hint, not an authoritative source of truth. The local UI can drift ahead of these recipes. If a recipe fails three times, stop repeating it mechanically: take a fresh screenshot/snapshot, reason from the visible UI, and inspect the relevant code if needed.
- Keep this skill self-improving by proposal, not silent mutation. When you discover a better path, missing pitfall, stale selector, or unverified workaround, record a candidate update under `.agent-contexts/<task-slug>/skill-update-candidates.md` with the scenario, failing attempts, evidence, proposed recipe, and verification status. Ask the user before editing this skill unless the current user request explicitly asks you to update it.

## Connect

1. Check the bridge:

```json
driver_session { "action": "status", "port": 9223 }
```

2. Start only when not connected:

```json
driver_session { "action": "start", "port": 9223 }
```

3. Sanity-check the target:

```json
ipc_get_backend_state {}
manage_window { "action": "list" }
```

Expect `app.identifier` to be `ai.helmor.desktop`, `app.name` to be `Helmor`, `environment.debug` to be `true`, and a visible `main` window. If multiple apps are connected, pass the returned port or bundle id as `appIdentifier` on later calls.

## Baseline Snapshot

Start every UI task with both a visual and semantic read:

```json
webview_screenshot { "windowId": "main", "format": "png" }
webview_dom_snapshot { "windowId": "main", "type": "accessibility" }
```

If accessibility fails with `aria-api library not loaded`, immediately use:

```json
webview_dom_snapshot { "windowId": "main", "type": "structure" }
```

Avoid taking screenshots with `maxWidth` when you need click coordinates. A scaled screenshot changes the coordinate space; direct `webview_interact { "x": ..., "y": ... }` expects the webview's real coordinates from `getBoundingClientRect()` or `manage_window info`.

Use this stable mental map:

- Shell: `Application shell`, `Workspace sidebar`, `Workspace panel`, `Workspace viewport`.
- Sidebar buttons: `Workspace location`, `Filter and sort sidebar`, `Add repository`, `New workspace`, `Collapse left sidebar`.
- Workspace rows: role `button` with the displayed workspace title. Nested actions include `Archive workspace`, `Confirm archive workspace`, and `Delete permanently`.
- Session header: tablist `Sessions`; tabs are named by session title, often `Untitled`; buttons include `New session` and `Session history`.
- Session tab actions: `Rename session` and `Close session` appear in the accessibility tree when visible. If not targetable, use the keyboard or the **Call App Commands** helper recipes below.
- Hidden session history: `Session history` opens rows with `Restore session` and `Delete session permanently`.
- Composer: `Workspace composer`, textbox `Workspace input`, placeholder `Ask to make changes, @mention files, run /commands`.
- Composer controls: model selector, `Fast mode`, `Carry room context`, effort dropdown such as `High`, `Plan mode`, `Terminal mode`, `Add context`, `Context usage`, and trailing `Send`, `Stop`, `Steer`, `Request Changes`, or `Implement`.

## Selector Repair And Coordinate Targeting

Some bridge versions inject `window.__MCP__` but omit helper functions used by selector-based tools. If `webview_dom_snapshot`, `webview_find_element`, `webview_interact selector=...`, or `webview_keyboard type selector=...` fails with `window.__MCP__.resolveAll is not a function` or `window.__MCP__.resolveRef is not a function`, install this compatibility shim once per page load:

```json
webview_execute_js {
  "windowId": "main",
  "script": "(() => {\n  if (!window.__MCP__) window.__MCP__ = {};\n  if (!window.__MCP__.refs) window.__MCP__.refs = new Map();\n  if (!window.__MCP__.reverseRefs) window.__MCP__.reverseRefs = new Map();\n  const all = (selector, strategy = 'css') => {\n    if (!selector) return [];\n    if (String(selector).startsWith('ref=')) {\n      const el = window.__MCP__.refs.get(String(selector).slice(4));\n      return el ? [el] : [];\n    }\n    if (strategy === 'xpath') {\n      const result = document.evaluate(selector, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);\n      return Array.from({ length: result.snapshotLength }, (_, i) => result.snapshotItem(i)).filter(Boolean);\n    }\n    if (strategy === 'text') {\n      const needle = String(selector).trim();\n      return Array.from(document.querySelectorAll('button,[role=\"button\"],[role=\"tab\"],input,textarea,[contenteditable=\"true\"],[role=\"textbox\"],a,[aria-label],[title]')).filter((el) => {\n        const text = (el.textContent || '').trim();\n        return text === needle || text.includes(needle) || el.getAttribute('aria-label') === needle || el.getAttribute('title') === needle || el.getAttribute('placeholder') === needle;\n      });\n    }\n    return Array.from(document.querySelectorAll(selector));\n  };\n  window.__MCP__.resolveAll = (selector, strategy = 'css') => all(selector, strategy);\n  window.__MCP__.resolveRef = (selector, strategy = 'css') => all(selector, strategy)[0] || null;\n  window.__MCP__.countAll = (selector, strategy = 'css') => all(selector, strategy).length;\n  return { installed: true, hasResolveAll: typeof window.__MCP__.resolveAll };\n})()"
}
```

Even with selector repair, coordinate targeting is often the fastest reliable path:

```json
webview_execute_js {
  "windowId": "main",
  "script": "(() => Array.from(document.querySelectorAll('button,[role=\"button\"],[role=\"tab\"],[role=\"textbox\"]')).map((el) => { const r = el.getBoundingClientRect(); return { text: (el.textContent || '').trim(), ariaLabel: el.getAttribute('aria-label'), role: el.getAttribute('role'), selected: el.getAttribute('aria-selected'), x: r.x, y: r.y, width: r.width, height: r.height, disabled: !!el.disabled }; }))()"
}
```

Click the center of the returned rect:

```json
webview_interact { "action": "click", "windowId": "main", "x": 1254, "y": 52 }
```

For Radix dropdown/menu triggers, direct click is sometimes ignored even when the selector resolves. Prefer:

```json
webview_interact { "action": "focus", "selector": "BUTTON_OR_TEXT", "strategy": "text", "windowId": "main" }
webview_keyboard { "action": "press", "key": "Enter", "windowId": "main" }
```

For model/effort menu triggers, `ArrowDown` was more reliable than `Enter`:

```json
webview_keyboard { "action": "press", "key": "ArrowDown", "windowId": "main" }
```

## Call App Commands

The MCP bridge's `ipc_execute_command` tool currently cannot invoke Helmor's ordinary Tauri commands. Use this click-triggered low-level IPC helper whenever you need a deterministic backend command. It was verified against a fresh debug build on port `9224` for repository/workspace setup, `debug_list_terminal_buffers`, `debug_read_terminal_buffer`, and terminal stdin writes.

Install the helper once per page load:

```json
webview_execute_js {
  "windowId": "main",
  "script": "(() => {\n  window.__helmorDebugResults = window.__helmorDebugResults || {};\n  let btn = document.getElementById('__helmor_debug_ipc_runner');\n  if (!btn) {\n    btn = document.createElement('button');\n    btn.id = '__helmor_debug_ipc_runner';\n    btn.textContent = 'ipc runner';\n    btn.style.position = 'fixed';\n    btn.style.left = '4px';\n    btn.style.top = '244px';\n    btn.style.zIndex = '2147483647';\n    btn.style.width = '120px';\n    btn.style.height = '32px';\n    document.body.appendChild(btn);\n  }\n  btn.onclick = () => {\n    const request = window.__helmorDebugRequest;\n    if (!request) return;\n    const id = request.id || `${Date.now()}-${Math.random()}`;\n    window.__helmorDebugResults[id] = { pending: true, command: request.command };\n    const callback = window.__TAURI_INTERNALS__.transformCallback((value) => {\n      window.__helmorDebugResults[id] = { ok: true, command: request.command, value };\n    }, true);\n    const error = window.__TAURI_INTERNALS__.transformCallback((err) => {\n      window.__helmorDebugResults[id] = { ok: false, command: request.command, error: String(err) };\n    }, true);\n    window.__TAURI_INTERNALS__.ipc({ cmd: request.command, callback, error, payload: request.payload || {} });\n  };\n  const r = btn.getBoundingClientRect();\n  return { installed: true, x: r.x + r.width / 2, y: r.y + r.height / 2 };\n})()"
}
```

Run a command by setting `window.__helmorDebugRequest`, clicking the helper button center returned above, then polling the result:

```json
webview_execute_js {
  "windowId": "main",
  "script": "(() => { window.__helmorDebugRequest = { id: 'list-buffers', command: 'debug_list_terminal_buffers', payload: {} }; return window.__helmorDebugRequest; })()"
}
webview_interact { "action": "click", "windowId": "main", "x": 64, "y": 260 }
webview_execute_js {
  "windowId": "main",
  "script": "(() => window.__helmorDebugResults?.['list-buffers'] || null)()"
}
```

Important constraints:

- Never call `window.__TAURI_INTERNALS__.invoke(...)` or `window.__TAURI_INTERNALS__.ipc(...)` directly from the same `webview_execute_js` stack; it can time out.
- Do not inject Promise chains in handlers for this bridge path; use `transformCallback` callback ids as shown.
- Keep the helper only for debug sessions. It mutates the visible DOM by adding a small fixed button; remove or ignore it before taking polished UI screenshots.
- Use the returned raw `scriptType` when reading buffers. Run actions can appear as values such as `run:run:<id>` because action ids may already include a `run:` prefix.

## Workspace Operations

### Switch By UI

1. Snapshot accessibility, or structure if accessibility is unavailable.
2. Prefer selector/text click only if selector repair is working and the name is unique:

```json
webview_interact { "action": "click", "selector": "My Workspace", "strategy": "text", "windowId": "main" }
```

3. If selector click fails, list workspace row rects and click the target row center:

```json
webview_execute_js {
  "windowId": "main",
  "script": "(() => Array.from(document.querySelectorAll('[role=\"button\"],button')).filter((el) => (el.textContent || '').trim()).map((el) => { const r = el.getBoundingClientRect(); return { text: (el.textContent || '').trim(), className: String(el.className || ''), x: r.x, y: r.y, width: r.width, height: r.height }; }).filter((row) => row.className.includes('workspace-row') || row.text === 'TARGET_WORKSPACE'))()"
}
```

4. Verify the workspace row has `workspace-row-selected`, the panel header/title changed, and the visible session tabs belong to the target workspace.

### Switch Deterministically

Use this when duplicate workspace names make text selection ambiguous. Install **Call App Commands** first, then run helper requests:

```json
{ "id": "list-workspace-groups", "command": "list_workspace_groups", "payload": {} }
{ "id": "reveal-workspace", "command": "reveal_workspace_in_main_window", "payload": { "workspaceId": "WORKSPACE_ID", "sessionId": null } }
```

Then re-snapshot and verify the visible UI. For details on one workspace:

```json
{ "id": "get-workspace", "command": "get_workspace", "payload": { "workspaceId": "WORKSPACE_ID" } }
```

### Archive Or Restore

Archive is destructive enough to require explicit user intent. If asked to test it as UI:

1. Click `Archive workspace` on the target row.
2. Click `Confirm archive workspace`.
3. Verify the row leaves active groups or appears under `Archived`.

For setup/cleanup only, prefer helper commands after confirming intent:

```json
{ "id": "validate-archive", "command": "validate_archive_workspace", "payload": { "workspaceId": "WORKSPACE_ID" } }
{ "id": "start-archive", "command": "start_archive_workspace", "payload": { "workspaceId": "WORKSPACE_ID" } }
{ "id": "restore-workspace", "command": "restore_workspace", "payload": { "workspaceId": "WORKSPACE_ID", "targetBranchOverride": null } }
```

## Session Operations

### List And Select

Read sessions for the current or target workspace:

```json
{ "id": "list-sessions", "command": "list_workspace_sessions", "payload": { "workspaceId": "WORKSPACE_ID" } }
```

Select a visible tab by clicking its snapshot `ref=eN`, or use a deterministic reveal:

```json
{ "id": "reveal-session", "command": "reveal_workspace_in_main_window", "payload": { "workspaceId": "WORKSPACE_ID", "sessionId": "SESSION_ID" } }
```

Re-snapshot and confirm the selected tab and message thread.

### Create

UI path:

```json
webview_interact { "action": "click", "selector": "New session", "strategy": "text", "windowId": "main" }
```

Coordinate-safe UI path when selectors are broken:

```json
webview_execute_js {
  "windowId": "main",
  "script": "(() => { const el = document.querySelector('button[aria-label=\"New session\"]'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, disabled: !!el.disabled }; })()"
}
webview_interact { "action": "click", "windowId": "main", "x": 1254, "y": 52 }
```

Backend helper path:

```json
{ "id": "create-session", "command": "create_session", "payload": { "workspaceId": "WORKSPACE_ID" } }
```

If using helper creation, reveal the returned session id, then verify the new tab:

```json
{ "id": "reveal-new-session", "command": "reveal_workspace_in_main_window", "payload": { "workspaceId": "WORKSPACE_ID", "sessionId": "NEW_SESSION_ID" } }
```

For terminal sessions:

```json
{ "id": "create-terminal-session", "command": "create_session", "payload": { "workspaceId": "WORKSPACE_ID", "sessionKind": "terminal", "agentType": "claude" } }
```

### Rename

The most reliable non-UI path is the helper, followed by UI verification:

```json
{ "id": "rename-session", "command": "rename_session", "payload": { "sessionId": "SESSION_ID", "title": "New title" } }
```

Re-snapshot and verify the tab/history label. Use UI rename only when `Rename session` is visible and targetable in the latest snapshot.

### Close, Hide, Restore, Delete

Close the selected visible session like a user:

```json
webview_keyboard { "action": "press", "key": "w", "modifiers": ["Meta"], "windowId": "main" }
```

If the session is running, expect a `Close running chat?` dialog. Click `Close anyway` only when cancellation is intended.

Backend equivalents:

```json
{ "id": "hide-session", "command": "hide_session", "payload": { "sessionId": "SESSION_ID" } }
{ "id": "unhide-session", "command": "unhide_session", "payload": { "sessionId": "SESSION_ID" } }
{ "id": "delete-session", "command": "delete_session", "payload": { "sessionId": "SESSION_ID" } }
```

`hide_session` is the normal recoverable close for non-empty sessions. `delete_session` is permanent and should normally be limited to empty sessions or hidden-session cleanup explicitly requested by the user.

## Composer Operations

### Type Without Sending

1. Select the target workspace and session first.
2. Get the composer rect and click it:

```json
webview_execute_js {
  "windowId": "main",
  "script": "(() => { const el = document.querySelector('#workspace-input'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, text: el.textContent || '' }; })()"
}
webview_interact { "action": "click", "windowId": "main", "x": 340, "y": 850 }
```

3. Try the native MCP typing path only if the bridge supports `contenteditable` targets:

```json
webview_interact { "action": "focus", "selector": "Workspace input", "strategy": "text", "windowId": "main" }
webview_keyboard { "action": "type", "selector": "Workspace input", "strategy": "text", "text": "Prompt text here", "windowId": "main" }
```

In the known Helmor bridge state, this can fail with `The HTMLInputElement.value setter can only be used on instances of HTMLInputElement`. For a short smoke test, use the fallback:

```json
webview_execute_js {
  "windowId": "main",
  "script": "(() => { const el = document.querySelector('#workspace-input'); if (!el) return { ok: false }; el.focus(); const ok = document.execCommand('insertText', false, 'Prompt text here'); const send = document.querySelector('button[aria-label=\"Send\"]'); return { ok, text: el.textContent || '', sendDisabled: send ? !!send.disabled : null }; })()"
}
```

4. Verify the text is present and `Send` is enabled:

```json
webview_execute_js {
  "windowId": "main",
  "script": "(() => { const input = document.querySelector('#workspace-input'); const send = document.querySelector('button[aria-label=\"Send\"]'); return { text: input ? input.textContent : null, sendDisabled: send ? !!send.disabled : null }; })()"
}
```

### Send A Prompt

Only send when the user supplied the exact target and message, or the task explicitly requires sending.

1. Optional but recommended: start IPC monitor.

```json
ipc_monitor { "action": "start" }
```

2. Focus/type as above.
3. Click `Send`. Prefer the rect center when selectors are unreliable:

```json
webview_interact { "action": "click", "selector": "Send", "strategy": "text", "windowId": "main" }
```

or:

```json
webview_execute_js {
  "windowId": "main",
  "script": "(() => { const el = document.querySelector('button[aria-label=\"Send\"]'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, disabled: !!el.disabled }; })()"
}
webview_interact { "action": "click", "windowId": "main", "x": 1267, "y": 916 }
```

4. Verify the UI changed: the composer clears, the user message appears in the thread, `Send` may become `Stop`, and `list_active_streams` may include the session if helper command access is available:

```json
{ "id": "list-active-streams", "command": "list_active_streams", "payload": {} }
ipc_get_captured { "filter": "send_agent_message_stream" }
ipc_monitor { "action": "stop" }
```

If `ipc_get_captured` returns `[]` despite the UI changing, treat it as an IPC monitor limitation in that bridge session and use visible UI evidence plus logs instead.

Do not call `send_agent_message_stream` directly through `ipc_execute_command`; the real frontend call uses an IPC `Channel` callback that the generic MCP command runner cannot provide safely.

### Proven Smoke Test Recipe

Use this when the user asks whether the local dev build can be controlled end-to-end:

1. Connect and sanity-check: `driver_session status`, `ipc_get_backend_state`, `manage_window info`.
2. Snapshot. If accessibility fails, use structure plus read-only rect inspection.
3. Switch workspace by row rect center; verify `workspace-row-selected` and the panel title.
4. Click `button[aria-label="New session"]` by rect center; verify a selected `Untitled` tab.
5. Click `#workspace-input`, insert a short test prompt using the best available input path, verify `Send` is enabled.
6. Start `ipc_monitor`, click Send by rect center, verify the composer clears and the user message appears, then stop `ipc_monitor`.
7. Save a screenshot under `.agent-contexts/<task-slug>/` if the result matters.

### Stop Or Steer

To stop the selected active turn through the UI:

```json
webview_interact { "action": "click", "selector": "Stop", "strategy": "text", "windowId": "main" }
```

To stop deterministically:

```json
{ "id": "stop-agent-stream", "command": "stop_agent_stream", "payload": { "request": { "sessionId": "SESSION_ID", "provider": null } } }
```

To steer an active turn, type additional content while `Stop` is visible, then click `Steer`. If using the helper:

```json
{ "id": "steer-agent-stream", "command": "steer_agent_stream", "payload": { "request": { "sessionId": "SESSION_ID", "provider": "claude", "prompt": "Additional instruction", "files": [], "images": [] } } }
```

## Inspection And Debugging

- Screenshot visible UI:

```json
webview_screenshot { "windowId": "main", "format": "png", "filePath": ".agent-contexts/TASK/shot.png" }
```

- Accessibility snapshot for controls:

```json
webview_dom_snapshot { "windowId": "main", "type": "accessibility" }
```

- DOM structure snapshot for selectors/classes:

```json
webview_dom_snapshot { "windowId": "main", "type": "structure", "selector": ".some-css-selector" }
```

- Styles:

```json
webview_get_styles { "windowId": "main", "selector": "Workspace input", "strategy": "text", "properties": ["display", "color", "background-color", "font-size"] }
```

- Console/system logs:

```json
read_logs { "source": "console", "windowId": "main", "lines": 100 }
read_logs { "source": "system", "filter": "helmor", "lines": 200 }
```

- Terminal/run-script buffers:

```json
/* Use Call App Commands helper */
{ "id": "list-buffers", "command": "debug_list_terminal_buffers", "payload": {} }
```

Read the relevant buffer by using the returned `repoId`, `workspaceId`, and raw `scriptType` such as `setup`, `run:<actionId>`, `run:run:<actionId>`, or `terminal:<instanceId>`:

```json
/* Use Call App Commands helper */
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

If the helper result is an error saying the command is unknown, the connected build predates the debug buffer feature. Fall back to visible xterm evidence, screenshots, and system logs; do not pretend full terminal history was inspected.

- IPC tracing:

```json
ipc_monitor { "action": "start" }
/* perform the UI action */
ipc_get_captured { "filter": "COMMAND_NAME" }
ipc_monitor { "action": "stop" }
```

## Verification Pattern

End every Tauri MCP task with evidence:

1. State the target app from `ipc_get_backend_state`.
2. State the user flow performed.
3. State the verification signal: visible text/control from accessibility snapshot, screenshot path, IPC command captured, backend command result, or logs.
4. If anything was not verified, say exactly what is missing.
