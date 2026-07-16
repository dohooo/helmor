# Verified Tauri MCP Recipes

Use these recipes after loading `SKILL.md`. Each recipe below was exercised against the local Helmor debug build through Tauri MCP and passed three consecutive verification attempts unless marked otherwise.

## Global Notes

- Use `windowId: "main"` and the connected app default unless multiple apps are attached.
- Prefer real UI input. Use `webview_execute_js` only for read-only rect/state inspection, selector repair, or the documented Lexical composer fallback.
- When a recipe needs a Helmor app command, use `SKILL.md`'s **Call App Commands** helper. The Tauri MCP `ipc_execute_command` tool currently cannot invoke ordinary Helmor commands and returns `Unsupported Tauri command`; any `ipc_execute_command` examples should be treated as logical shorthand, not the literal MCP tool call.
- For Radix triggers, `click` is not always sufficient. The most stable pattern is `webview_interact focus` followed by `webview_keyboard Enter` or `ArrowDown`.
- Closed Radix popovers may remain in the DOM with `data-state="closed"`. Verify open state with `data-state !== "closed"` instead of raw element count.
- If Settings gets stuck visible with `data-state="closed"`, press `Cmd+,` to reopen it, then press `Escape`. Verify no `[role="dialog"]` remains and `main[aria-hidden]` is absent.
- If `webview_execute_js` and `read_logs source=console` begin timing out while screenshots and `driver_session status` still work, restart only the MCP driver session. Use `driver_session { "action": "stop", "appIdentifier": 9223 }`, then `driver_session { "action": "start", "port": 9223 }`. This restored JS execution without restarting the Helmor dev build.

## Workspace

### Switch Workspace

1. Inspect workspace rows:

```json
webview_execute_js {
  "windowId": "main",
  "script": "(() => Array.from(document.querySelectorAll('[role=\"button\"],button')).filter((el) => (el.textContent || '').trim()).map((el) => { const r = el.getBoundingClientRect(); return { text: (el.textContent || '').replace(/\\s+/g, ' ').trim(), className: String(el.className || ''), x: r.x, y: r.y, width: r.width, height: r.height }; }).filter((row) => row.className.includes('workspace-row')))()"
}
```

2. Click the target row center.
3. Verify:

```json
webview_execute_js {
  "windowId": "main",
  "script": "(() => ({ selected: Array.from(document.querySelectorAll('.workspace-row-selected')).map((el) => (el.textContent || '').replace(/\\s+/g, ' ').trim()), header: document.querySelector('[aria-label=\"Workspace header\"]')?.textContent || null }))()"
}
```

Observed 3x pass: `Hihihi! -> 用户身份查询 -> Hihihi!`.

### New Workspace Entry

This is a high-impact operation. It may switch to a start surface and change current selection. Do not use it as a casual smoke test.

Observed behavior:
- `focus "New workspace"` + `Enter` can enter a start/source-preview surface with `What should we work on?`, `New Workspace`, `Start options`, and `Just chat`.
- In chat-only environments there may be no repository-backed workspace, so Inspector/Editor are unavailable.
- To exit the start surface, select an existing workspace row. The `Close source preview` / `Esc` button was observed not to close reliably in one run.

## Sessions

### Create Session And Close Empty Session

1. Get `New session` center:

```json
webview_execute_js {
  "windowId": "main",
  "script": "(() => { const el = document.querySelector('button[aria-label=\"New session\"]'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()"
}
```

2. Click the center.
3. Verify selected `Untitled` tab:

```json
webview_execute_js {
  "windowId": "main",
  "script": "(() => ({ tabs: Array.from(document.querySelectorAll('[role=\"tab\"]')).map((el) => ({ text: (el.textContent || '').replace(/\\s+/g, ' ').trim(), selected: el.getAttribute('aria-selected') })) }))()"
}
```

4. Close the empty selected session with `Cmd+W`:

```json
webview_keyboard { "action": "press", "key": "w", "modifiers": ["Meta"], "windowId": "main" }
```

5. Verify the original tab is selected again.

Observed 3x pass on `Hihihi!`.

### Session History

1. Focus `Session history`.
2. Press `Enter`.
3. Verify open menu text. Empty state is `No hidden sessions`.
4. Press `Escape` and verify `aria-expanded="false"`.

Observed 3x pass.

### Rename Session

Use a temporary empty session for smoke tests so cleanup is trivial.

1. Create/select the session.
2. Ensure selector repair is installed if selector tools fail after a React re-render.
3. Click the rename control for the selected tab:

```json
webview_interact {
  "action": "click",
  "selector": "[role=\"tab\"][aria-selected=\"true\"] [aria-label=\"Rename session\"]",
  "strategy": "css",
  "windowId": "main"
}
```

4. Verify a native input appears with current title:

```json
webview_execute_js {
  "windowId": "main",
  "script": "(() => Array.from(document.querySelectorAll('input')).map((el) => ({ value: el.value, active: document.activeElement === el })))()"
}
```

5. Select all, type the new title, and press `Enter`:

```json
webview_keyboard { "action": "press", "key": "a", "modifiers": ["Meta"], "windowId": "main" }
webview_keyboard { "action": "type", "selector": "input[data-slot=\"input\"]", "strategy": "css", "text": "New title", "windowId": "main" }
webview_keyboard { "action": "press", "key": "Enter", "windowId": "main" }
```

6. Verify the selected tab text changed.

Observed 3x pass using temporary session titles `tmp-rename-1`, `tmp-rename-2`, and `tmp-rename-3`, then `Cmd+W` cleanup.

## Sidebar Menus

### Workspace Location

Direct click did not open reliably. Use keyboard activation:

```json
webview_interact { "action": "focus", "selector": "Workspace location", "strategy": "text", "windowId": "main" }
webview_keyboard { "action": "press", "key": "Enter", "windowId": "main" }
```

Verify menu text: `Workspace locationLocalTeamConfigure team backend…`.

Observed 3x pass.

### Filter And Sort Sidebar

Click the button center or use selector after repair:

```json
webview_interact { "action": "click", "selector": "Filter and sort sidebar", "strategy": "text", "windowId": "main" }
```

Verify open dialog text includes `Repository`, `Group by`, `Status`, `Repository`, `Sort by`, `Draggable order`, `Repository name`, `Last updated`, and `Created time`.

Observed 3x pass.

### Add Repository Menu

Direct click did not open reliably. Use keyboard activation:

```json
webview_interact { "action": "focus", "selector": "Add repository", "strategy": "text", "windowId": "main" }
webview_keyboard { "action": "press", "key": "Enter", "windowId": "main" }
```

Verify menu text: `Clone from URL`. Do not select it unless the user asks to clone.

Observed 3x pass.

### Clone From URL Dialog

Use this only to inspect the clone dialog unless the user explicitly asks to clone a repository.

1. Open the Add repository menu with the recipe above.
2. Click the menu item by role:

```json
webview_interact { "action": "click", "selector": "[role=\"menuitem\"]", "strategy": "css", "windowId": "main" }
```

3. Verify:

```json
webview_execute_js {
  "windowId": "main",
  "script": "(() => ({ open: Array.from(document.querySelectorAll('[role=\"dialog\"]')).some((el) => el.getAttribute('data-state') !== 'closed' && (el.textContent || '').includes('Clone from URL')), gitUrl: !!document.querySelector('#clone-git-url'), location: !!document.querySelector('#clone-location'), cloneDisabled: !!Array.from(document.querySelectorAll('[role=\"dialog\"] button')).find((b) => (b.textContent || '').includes('Clone repository'))?.disabled }))()"
}
```

4. Press `Escape` to close.

Observed 3x pass. Text selector for `Clone from URL` failed once while `[role="menuitem"]` was stable.

### Collapse Workspace Groups

Workspace group headers such as `Proposed tasks7`, `In review1`, `In progress3`, and `Archived23` are safe to toggle. Use the header rect center, not a workspace row.

1. Locate the header and child rows:

```json
webview_execute_js {
  "windowId": "main",
  "script": "(() => Array.from(document.querySelectorAll('[role=\"button\"],button,div')).map((el) => { const r = el.getBoundingClientRect(); const text = String(el.textContent || '').replace(/\\s+/g, ' ').trim(); return { text, aria: el.getAttribute('aria-label'), role: el.getAttribute('role'), x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height), className: String(el.className || '').slice(0, 120) }; }).filter((x) => x.width > 0 && x.height > 0 && x.x < 280 && x.text.match(/In progress|Add Search|Initial Greeting 2|Initial Greeting 4/)).slice(0, 80))()"
}
```

2. Click the group header center.
3. Verify child row count for that group drops to `0`.
4. Click the same header again.
5. Verify the child row count returns.

Observed 3 collapse/expand cycles passed for `In progress3`, with child rows `Add Search`, `Initial Greeting 2`, and `Initial Greeting 4`.

## Composer Controls

### Model Menu

Direct click and `Enter` were unreliable. Use exact trigger focus plus `ArrowDown`.

1. Locate the model trigger by text or id:

```json
webview_execute_js {
  "windowId": "main",
  "script": "(() => Array.from(document.querySelectorAll('button')).filter((b) => (b.textContent || '').includes('Opus')).map((b) => ({ id: b.id, text: (b.textContent || '').replace(/\\s+/g, ' ').trim() })))()"
}
```

2. Focus the returned id and press `ArrowDown`:

```json
webview_interact { "action": "focus", "selector": "#MODEL_TRIGGER_ID", "strategy": "css", "windowId": "main" }
webview_keyboard { "action": "press", "key": "ArrowDown", "windowId": "main" }
```

Verify menu text includes `Claude Code`, `Claude`, current selected model, `Codex`, and `GPT-5.5`.

Observed 3x pass.

### Effort Menu

Use exact trigger focus plus `ArrowDown`:

```json
webview_execute_js {
  "windowId": "main",
  "script": "(() => Array.from(document.querySelectorAll('button')).filter((b) => (b.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase() === 'high').map((b) => ({ id: b.id, text: b.textContent })))()"
}
webview_interact { "action": "focus", "selector": "#EFFORT_TRIGGER_ID", "strategy": "css", "windowId": "main" }
webview_keyboard { "action": "press", "key": "ArrowDown", "windowId": "main" }
```

Verify menu text: `Effortlowmediumhigh✓Extra Highmax`.

Observed 3x pass.

### Add Context

In a repo-backed workspace, this toggles the right inspector between the normal Git inspector and the Contexts inspector. It does not open a dialog/popper.

1. Click `Add context`.
2. Verify the right inspector text starts with `Contexts` and source tabs `GitHub`, `Slack`, `Linear`, and `Mobile` exist.
3. Click `Add context` again.
4. Verify the right inspector text starts with `Git` and Git controls such as `Create PR options` return.

Verification:

```json
webview_execute_js {
  "windowId": "main",
  "script": "(() => { const text = String(document.querySelector('[aria-label=\"Inspector sidebar\"], [data-shell-pane=\"inspector\"]')?.textContent || '').replace(/\\s+/g, ' ').trim(); return { context: text.startsWith('Contexts'), git: text.startsWith('Git'), hasSourceTabs: Array.from(document.querySelectorAll('button')).some((b) => ['GitHub', 'Slack', 'Linear', 'Mobile'].includes(b.getAttribute('aria-label') || '')) }; })()"
}
```

Observed 3 open/restore cycles passed. Focus + Enter on the button surfaced only tooltip text `Add context⌘⇧C`; `Cmd+Shift+C` with either the button focused or the composer focused did not open a picker in the observed build.

### Contexts Source Tabs

Use only read-only tab switching unless the user asks to add context. Do not click `Add to context`.

1. Open the Contexts inspector with `Add context`.
2. Click a source tab such as `Slack`.
3. Verify the clicked tab no longer has `text-muted-foreground` while the other tabs do.
4. Click `GitHub` to restore the default source.

Verification:

```json
webview_execute_js {
  "windowId": "main",
  "script": "(() => Array.from(document.querySelectorAll('button')).map((b) => { const r = b.getBoundingClientRect(); const aria = b.getAttribute('aria-label'); const cls = String(b.className || ''); return { aria, selected: !cls.includes('text-muted-foreground'), x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; }).filter((x) => x.width > 0 && x.height > 0 && ['GitHub', 'Slack', 'Linear', 'Mobile'].includes(x.aria)))()"
}
```

Observed 3 GitHub/Slack cycles passed, restored GitHub, then restored the Git inspector by clicking `Add context` again.

### Context Usage

Not yet stable. Click and long-press did not open a visible dialog/popper in the observed states. The current Tauri MCP toolset lacks a hover action, so treat this as unverified unless a hover-capable tool is available.

### Usage Stats

Not yet stable. Click and long-press did not open a visible dialog/popper in the observed repo-backed workspace. Treat as unverified unless a hover-capable tool is available or code inspection shows a non-hover activation path.

### Fast Mode Toggle

Use a temporary session for smoke tests and restore the original state afterward.

1. Click `Fast mode`.
2. Verify enabled class contains `text-amber-500`.
3. Click `Fast mode` again.
4. Verify disabled class contains `text-muted-foreground`.

Observed 3 toggle/restore cycles passed.

### Plan Mode Toggle

Use a temporary session for smoke tests and restore the original state afterward.

1. Click `Plan mode`.
2. Verify the class no longer contains the disabled marker `text-muted-foreground/70`.
3. Click `Plan mode` again.
4. Verify the disabled class contains `text-muted-foreground/70`.

Observed 3 toggle/restore cycles passed.

### Terminal Mode Toggle

Use a temporary session or restore the original state afterward. This only toggles composer mode; it does not create an inspector terminal unless a prompt is later sent in terminal mode.

1. Click `Terminal mode`.
2. Verify enabled class contains `text-emerald-500`.
3. Click `Terminal mode` again.
4. Verify disabled class contains `text-muted-foreground/70`.

Observed 3 toggle/restore cycles passed, restored disabled.

### Carry Room Context Toggle

The enabled state uses blue styling; disabled state uses muted styling.

1. Click `Carry room context`.
2. Verify disabled class contains `text-muted-foreground`.
3. Click it again.
4. Verify enabled class contains `text-blue-500`.

Observed 3 toggle/restore cycles passed, restored to enabled.

### Send Smoke Prompt

Use a temporary session unless the user explicitly wants to send in the current session.

1. Click the composer.
2. Insert short text. In the current bridge, the Lexical fallback is the reliable input path:

```json
webview_execute_js {
  "windowId": "main",
  "script": "(() => { const el = document.querySelector('#workspace-input'); if (!el) return { ok: false }; el.focus(); const ok = document.execCommand('insertText', false, 'smoke'); const send = document.querySelector('button[aria-label=\"Send\"]'); return { ok, text: el.textContent || '', html: el.innerHTML, sendDisabled: send ? !!send.disabled : null }; })()"
}
```

3. Read back before retrying. `execCommand` can return before Lexical state visibly updates:

```json
webview_execute_js {
  "windowId": "main",
  "script": "(() => ({ text: document.querySelector('#workspace-input')?.textContent || '', html: document.querySelector('#workspace-input')?.innerHTML || '', sendDisabled: !!document.querySelector('button[aria-label=\"Send\"]')?.disabled }))()"
}
```

Do not immediately run `insertText` again after an empty first read; a delayed update can duplicate the prompt.

4. Click `Send` by rect center.
5. Verify the message appears in the panel, the input is empty, and `Send` is disabled. If `Stop` appears and remains visible, stop the run only if cancellation is intended.
6. For temporary sessions, close with `Cmd+W` after verification.

Observed 3x pass. One run duplicated to `smokesmoke` when insertion was retried too soon; the send still worked, but the stable recipe is to read back before reinserting.

## Inspector And Editor

These recipes require a repository-backed, non-chat workspace. Chat-only workspaces hide the inspector.

### Header Open-In Dropdown

This opens the workspace "open in app" dropdown. Do not select an app during smoke tests because items such as Finder, Cursor, VS Code, Xcode, Terminal, and Warp can launch external applications.

Direct click did not open reliably. Use focus plus `ArrowDown`:

```json
webview_interact { "action": "focus", "selector": "button[data-slot=\"dropdown-menu-trigger\"][data-size=\"xs\"]", "strategy": "css", "windowId": "main" }
webview_keyboard { "action": "press", "key": "ArrowDown", "windowId": "main" }
```

Verify menu text includes `Finder`, `Cursor`, `VS Code`, `Xcode`, `Terminal`, and `Warp`; close with Escape.

Observed 3x pass.

### Switch Setup And Run Tabs

This is safe: it only changes the visible inspector panel and does not run scripts.

1. Click Setup:

```json
webview_interact { "action": "click", "selector": "#inspector-tab-setup", "strategy": "css", "windowId": "main" }
```

2. Verify `#inspector-panel-setup` is visible and `#inspector-panel-run` is hidden:

```json
webview_execute_js {
  "windowId": "main",
  "script": "(() => Array.from(document.querySelectorAll('[id^=\"inspector-panel-\"]')).map((el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return { id: el.id, display: cs.display, hidden: el.hidden, width: Math.round(r.width), height: Math.round(r.height), text: String(el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120) }; }))()"
}
```

3. Click Run:

```json
webview_interact { "action": "click", "selector": "#inspector-tab-run", "strategy": "css", "windowId": "main" }
```

4. Verify `#inspector-panel-run` is visible. Observed text included `No output for DB` and `Run⌘R`.

Observed 3 cycles passed.

### Collapse Inspector Sections

Use the toggle button aria labels instead of hard-coded coordinates; the y position changes after collapse.

Actions section:

```json
webview_interact { "action": "click", "selector": "button[aria-label=\"Toggle inspector actions section\"]", "strategy": "css", "windowId": "main" }
```

Verify:

```json
webview_execute_js {
  "windowId": "main",
  "script": "(() => Array.from(document.querySelectorAll('section')).map((s) => { const r = s.getBoundingClientRect(); return { label: s.getAttribute('aria-label'), height: Math.round(r.height), text: String(s.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80) }; }).filter((x) => String(x.label || '').includes('Inspector section')))()"
}
```

Collapsed Actions is about 33px tall with text `Actions`; expanded Actions returns to the larger content panel. Observed 3 collapse/expand cycles passed.

Tabs section:

```json
webview_interact { "action": "click", "selector": "button[aria-label=\"Toggle inspector tabs section\"]", "strategy": "css", "windowId": "main" }
```

Collapsed Tabs is about 33px tall with text `SetupDBTerminal`; expanded Tabs restores the Setup/Run/Terminal panel area. Observed 3 collapse/expand cycles passed.

### Switch Run Action Menu

Do not select a script during smoke tests. Opening and closing the menu is safe.

Direct click did not open reliably. Use focus plus `ArrowDown`:

```json
webview_interact { "action": "focus", "selector": "button[aria-label=\"Switch run action\"]", "strategy": "css", "windowId": "main" }
webview_keyboard { "action": "press", "key": "ArrowDown", "windowId": "main" }
```

Verify the open menu text:

```json
webview_execute_js {
  "windowId": "main",
  "script": "(() => Array.from(document.querySelectorAll('[role=\"menu\"],[data-radix-popper-content-wrapper]')).map((el) => { const r = el.getBoundingClientRect(); return { role: el.getAttribute('role'), state: el.getAttribute('data-state'), text: String(el.textContent || '').replace(/\\s+/g, ' ').trim(), width: Math.round(r.width), height: Math.round(r.height) }; }).filter((x) => x.width > 0 && x.height > 0))()"
}
```

Observed menu text: `DBBEAPPMarketingCreate`. Close with Escape. Observed 3x pass.

### Create PR Options Menu

Do not select a menu item during smoke tests. `Create draft PR` and `Create PR manually` are real PR actions.

Direct click did not open reliably. Use focus plus `ArrowDown`:

```json
webview_interact { "action": "focus", "selector": "button[aria-label=\"Create PR options\"]", "strategy": "css", "windowId": "main" }
webview_keyboard { "action": "press", "key": "ArrowDown", "windowId": "main" }
```

Verify the open menu text contains `Create draft PR` and `Create PR manually`, then close with Escape:

```json
webview_execute_js {
  "windowId": "main",
  "script": "(() => Array.from(document.querySelectorAll('[role=\"menu\"],[data-radix-popper-content-wrapper]')).map((el) => { const r = el.getBoundingClientRect(); return { role: el.getAttribute('role'), state: el.getAttribute('data-state'), text: String(el.textContent || '').replace(/\\s+/g, ' ').trim(), width: Math.round(r.width), height: Math.round(r.height) }; }).filter((x) => x.width > 0 && x.height > 0))()"
}
```

Observed 3x pass.

### Create, Switch, And Close Inspector Terminal

This creates a real inspector terminal panel. Use only on an idle repo-backed workspace, and close it when done.

1. Click the placeholder tab:

```json
webview_interact { "action": "click", "selector": "#inspector-tab-terminal-placeholder", "strategy": "css", "windowId": "main" }
```

2. Verify a dynamic terminal panel exists:

```json
webview_execute_js {
  "windowId": "main",
  "script": "(() => ({ terminalPanel: Array.from(document.querySelectorAll('[id^=\"inspector-panel-terminal-\"]')).map((el) => { const r = el.getBoundingClientRect(); return { id: el.id, width: Math.round(r.width), height: Math.round(r.height), visible: r.width > 0 && r.height > 0 }; }), close: !!document.querySelector('button[aria-label=\"Close Terminal\"]') }))()"
}
```

3. Switch between Run and the existing terminal tab:

```json
webview_interact { "action": "click", "selector": "#inspector-tab-run", "strategy": "css", "windowId": "main" }
webview_interact { "action": "click", "selector": "[id^=\"inspector-tab-terminal-\"]", "strategy": "css", "windowId": "main" }
```

Verify the visible panel by checking which `[id^="inspector-panel-"]` has `display !== "none"`.

4. Close the terminal:

```json
webview_interact { "action": "click", "selector": "button[aria-label=\"Close Terminal\"]", "strategy": "css", "windowId": "main" }
```

Verify `#inspector-tab-terminal-placeholder` exists again and `document.querySelectorAll('[id^="inspector-panel-terminal-"]').length === 0`.

Observed 3x pass for create/close, and 3 cycles passed for Run/Terminal switching after one terminal existed.

### Collapse And Expand The Right Inspector

Click the header button by aria label:

```json
webview_interact { "action": "click", "selector": "button[aria-label=\"Collapse right sidebar\"]", "strategy": "css", "windowId": "main" }
```

Verify collapsed state by button label and inspector state:

```json
webview_execute_js {
  "windowId": "main",
  "script": "(() => { const el = document.querySelector('[aria-label=\"Inspector sidebar\"], [data-shell-pane=\"inspector\"]'); const r = el?.getBoundingClientRect(); return { ariaHidden: el?.getAttribute('aria-hidden'), width: r && Math.round(r.width), button: Array.from(document.querySelectorAll('button')).map((b) => { const r = b.getBoundingClientRect(); return { aria: b.getAttribute('aria-label'), width: Math.round(r.width), height: Math.round(r.height) }; }).filter((x) => x.width > 0 && x.height > 0 && String(x.aria || '').includes('right sidebar')) }; })()"
}
```

Collapsed state shows `Expand right sidebar` and `aria-hidden="true"`; after the animation, width can be `0`. Expanded state shows `Collapse right sidebar`, `aria-hidden="false"`, and the inspector width restored.

Observed 3 successful cycles. One extra attempt made the bridge JS channel time out even though the action applied; restarting the driver session recovered it.

### Open And Close A Diff From Git Changes

Use `data-change-path`; it is more stable than text.

```json
webview_interact { "action": "click", "selector": "[data-change-path=\".claude/settings.json\"]", "strategy": "css", "windowId": "main" }
```

Verify the editor surface:

```json
webview_execute_js {
  "windowId": "main",
  "script": "(() => { const el = document.querySelector('[aria-label=\"Workspace editor surface\"], [data-focus-scope=\"editor\"], [aria-label=\"Editor canvas\"]'); const r = el?.getBoundingClientRect(); return { editor: !!el, rect: el ? { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } : null, text: String(el?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 140), close: !!document.querySelector('button[aria-label=\"Close diff view\"]') }; })()"
}
```

Close:

```json
webview_interact { "action": "click", "selector": "button[aria-label=\"Close diff view\"]", "strategy": "css", "windowId": "main" }
```

Verify the editor surface is gone and `[data-change-path]` rows are visible again. Observed 3x pass.

### Toggle Editor Edit/Diff Mode

From an open diff, click the mode button by rect or by visible text if unique. Do not type into Monaco unless the user asked to edit a file.

Signals:

- Diff mode has button text `Edit⌘E` and close aria `Close diff view`.
- Edit mode has button text `Diff⌘E`, close aria `Close editor view`, and `.monaco-editor` is present.

Observed 3 Edit/Diff cycles passed with no editor typing.

### Toggle Git Changes Tree/List View

This is safe: it only changes the visible Git changes layout.

1. Click the small view toggle in the Git section header. In tree mode its aria label is `Switch to list view`.
2. Verify list mode:

```json
webview_execute_js {
  "windowId": "main",
  "script": "(() => { const buttons = Array.from(document.querySelectorAll('button')).map((el) => { const r = el.getBoundingClientRect(); return { aria: el.getAttribute('aria-label'), width: Math.round(r.width), height: Math.round(r.height) }; }).filter((x) => x.width > 0 && x.height > 0 && (String(x.aria || '').includes('list view') || String(x.aria || '').includes('tree view'))); const treeItems = Array.from(document.querySelectorAll('[role=\"treeitem\"]')).filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.x > 900; }).length; return { buttons, treeItems }; })()"
}
```

List mode shows `Switch to tree view` and visible `treeItems: 0`.

3. Click the same button again.
4. Verify tree mode shows `Switch to list view` and visible `treeItems` restored.

Observed 3 cycles passed, restored tree view.

## Settings And Feedback

### Open Settings

Click the first bottom-left sidebar icon.

Verify open dialog contains `General`, `Appearance`, and `Desktop Notifications`. `Escape` closes.

Observed 3x pass.

## Global Overlays

### Quick Switch Workspace

Open with `Ctrl+Tab`:

```json
webview_keyboard { "action": "press", "key": "Tab", "modifiers": ["Control"], "windowId": "main" }
```

Verify `[data-testid="quick-switch-overlay"]` exists and an open dialog has aria-label `Quick switch workspace`.

Close with `Escape`.

Observed 3x pass.

### Switch Settings Section

Click the left section row in the Settings dialog.

Observed 3x pass for `General -> Appearance`, verified by `Theme`, `Color Theme`, and `Chat font size`.

### Read Settings Sections Without Mutating

Open Settings first. Then use the left-nav button rects for duplicated names, especially repository names:

```json
webview_execute_js {
  "windowId": "main",
  "script": "(() => Array.from(document.querySelectorAll('[role=\"dialog\"] button')).map((el) => { const r = el.getBoundingClientRect(); return { text: String(el.textContent || '').replace(/\\s+/g, ' ').trim(), x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height), className: String(el.className || '').slice(0, 120) }; }).filter((x) => x.width > 0 && x.height > 0 && x.x < 420))()"
}
```

Click the center of the target left-nav row. Avoid plain text selectors for repository names because the same name appears in the settings body.

Read only labels, buttons, placeholders, and control states. Do not copy token values, account details, or script bodies into user-facing output:

```json
webview_execute_js {
  "windowId": "main",
  "script": "(() => { const compact = (s, n = 120) => String(s || '').replace(/\\s+/g, ' ').trim().slice(0, n); const dialog = document.querySelector('[role=\"dialog\"][data-state=\"open\"]'); return { labels: Array.from(dialog?.querySelectorAll('h1,h2,h3,p,label,span,button') || []).map((el) => { const r = el.getBoundingClientRect(); return { tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), aria: el.getAttribute('aria-label'), text: compact(el.textContent, 100), disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true', x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; }).filter((x) => x.width > 0 && x.height > 0 && x.text).slice(0, 120), inputs: Array.from(dialog?.querySelectorAll('input,textarea') || []).map((el) => { const r = el.getBoundingClientRect(); return { tag: el.tagName.toLowerCase(), aria: el.getAttribute('aria-label'), placeholder: el.getAttribute('placeholder'), type: el.getAttribute('type'), disabled: !!el.disabled, x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; }).filter((x) => x.width > 0 && x.height > 0) }; })()"
}
```

One read-only mapping pass observed:

- `Models`: Default/Review/Action model rows with model picker, effort picker, and fast-mode switches.
- `Providers`: provider cards and API/provider controls. Do not click login, sync, fetch, add-provider, or API-key actions during smoke tests.
- `Shortcuts`: shortcut search/input, shortcut key buttons, and reset-to-default controls. Clicking a shortcut button starts keybinding edit flow.
- `Accounts`: local forge account list. Do not copy account details into skill output.
- `Team`: invite link, Team mode, Worker URL, Access token, Test connection. Inputs are sensitive configuration.
- `Contexts`: GitHub/GitLab/Slack/Linear/Mobile tabs, repo selector, issue/PR switches, filters, and `Remove All`. Switches and remove actions mutate configuration.
- `Experimental`: Local LLM, Smart triage, triage sources, Mobile companion, pair/revoke controls. Treat connect/delete/run/revoke/model actions as high-impact.
- `Developer`: Reset Onboarding and Reset All Dev Data. Do not execute in ordinary verification.
- Repository settings entries: Remote, base branch, branch prefix, setup/run/archive scripts, built-in prompt preferences, and Delete Repository. Do not record script contents or change textareas.

Only `General -> Appearance` section switching has 3x verification so far; the full section map is read-only observed and should be rechecked for current UI before relying on exact labels.

### Feedback Dialog

The feedback button has no aria-label. Use its icon selector:

```json
webview_interact { "action": "click", "selector": "button:has(svg.lucide-message-square-warning)", "strategy": "css", "windowId": "main" }
```

Verify dialog text contains `Send feedback`, `Create issue`, `Quick fix`, and `Close`; input `#feedback-input` exists with aria-label `Feedback`. `Escape` closes.

Observed 3x pass.
