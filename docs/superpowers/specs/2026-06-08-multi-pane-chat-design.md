# Multi-pane chat: design

**Date:** 2026-06-08
**Status:** Approved (brainstorming); pending implementation plan.
**Approach:** A — multi-pane shell refactor.

---

## 1. Summary

Surface multiple chat sessions in Helmor at the same time, either as cells in a
grid inside the main window or as detached OS windows. Each pane is a full chat
surface — thread, composer, inspector, file tree — bound to a
`(workspaceId, sessionId)` tuple. Panes can mix freely across workspaces;
detached panes pop out into their own Tauri `WebviewWindow` and can be
re-attached.

No schema change, no Rust streaming change. The work is a front-end shell
refactor plus a small Tauri command module for window plumbing.

## 2. Goals

- **G1.** Open up to 4 chats in a 1×1 / 1×2 / 2×1 / 2×2 grid in the main window.
- **G2.** Detach any pane into its own OS window and re-attach it later.
- **G3.** Soft cap of ~6 simultaneous chats (panes + detached windows combined),
  enforced as a UX toast, not a hard refusal.
- **G4.** Each pane picks its own session, model, and workspace independently;
  two panes may target the same session.
- **G5.** Live streaming works to every visible pane simultaneously, with
  per-pane subscription lifecycle (mount = subscribe, unmount = unsubscribe).
- **G6.** Persist layout (open panes + their targets) across app restarts; do
  NOT auto-resume streaming, only restore identity.

## 3. Non-goals

- **NG1.** No data-model change. Chats remain `sessions` rows.
- **NG2.** No file-based memory or persistence change. SQLite stays the source
  of truth (already durable).
- **NG3.** No per-pane sidebar; the sidebar stays in the main window only.
- **NG4.** No new dnd library; native CSS grid only.
- **NG5.** No N>4 main-grid layout. Beyond 4, the user detaches to a window.
- **NG6.** No background warming / prefetch when hovering panes; subscribe on
  mount, unsubscribe on unmount.

## 4. Architecture

The shell goes from "one panel = one session" to "an N-cell grid of panels,
each with its own `(workspaceId, sessionId)`." `PanelContainer` becomes the
unit of repetition, used identically in main-window cells and detached
windows.

### 4.1 New abstraction: `Pane`

A logical chat surface with an id, a target `(workspaceId, sessionId | null)`,
a position (a cell in the main grid or a Tauri window label), and an opaque
per-pane scratch (e.g., scroll position). Frontend-only; persisted to
`localStorage` for layout restore.

```ts
type PaneTarget = "main" | { window: string };
type Pane = {
  id: string;
  workspaceId: string | null;
  sessionId: string | null;
  target: PaneTarget;
};
```

### 4.2 New context: `PanesProvider`

`src/shell/panes/provider.tsx`. Single source of truth for the list of panes,
the focused pane id, and the operations on them. Replaces the existing
singleton `useSelectionController` / `useAppShellState` workspace-and-session
selection. Internal state is a `useReducer` over `Pane[]`; persists to
`localStorage` (`helmor.panes.layout.v1`) on every change.

Public hook `usePanes()`:

- `panes: Pane[]`
- `focusedPaneId: string | null`
- `open({ workspaceId, sessionId, target? }): paneId`
- `close(paneId)` — also closes the detached webview if any
- `focus(paneId)`
- `detach(paneId)` — moves a main-grid pane into its own window
- `reattach(windowLabel)` — inverse of `detach`
- `replaceTarget(paneId, { workspaceId, sessionId })`

### 4.3 Layout: `PanesGrid`

`src/shell/panes/grid.tsx`. Native CSS grid. Layout derives from
`panes.length` (1×1 / 1×2 / 2×1 / 2×2). >4 main-target panes is refused at
the provider level. Reuses the existing panel-resize hooks for divider drag.

### 4.4 Per-pane shell: `PaneShell` + `PaneIdentityContext`

`src/shell/panes/pane-shell.tsx`. Thin wrapper that scopes "this pane's
identity" to React context via `PaneIdentityContext` (`{ paneId, workspaceId,
sessionId }`). Both grid cells and the detached-window route render
`<PaneShell />` → `<PanelContainer workspaceId={…} sessionId={…} />`.

Any descendant component that previously read `activeWorkspaceId` /
`activeSessionId` from the singleton selection store reads from
`usePaneIdentity()` instead.

### 4.5 Detached window route

A secondary `index.html` entrypoint (`/pane.html?id=<paneId>&workspaceId=…
&sessionId=…`) renders `<PaneShell />` plus a slim title bar (model selector,
drag region, re-attach button, close). Opened via Tauri's
`WebviewWindowBuilder` from a small Rust command module
`src-tauri/src/commands/panes.rs`:

- `pane_window_open(pane_id, workspace_id, session_id) -> Result<()>`
- `pane_window_close(pane_id) -> Result<()>`
- `pane_window_focus(pane_id) -> Result<()>`

No new tables, no schema migration. The Rust module is a passive relay —
the same `SessionStreamHub` already handles addressing by `session_id`, so
streaming events naturally reach every subscribed pane regardless of window.

### 4.6 Sidebar updates

`src/features/navigation/`. Each session/workspace row gets an
"open in new pane" affordance (cmd+click on macOS, ctrl+click on Windows).
Default click stays "switch the focused pane to this session." A small badge
indicates a session is already open elsewhere.

### 4.7 What does NOT change

- SQLite schema (`sessions`, `workspaces`, `repos`).
- Rust backend (`agents::streaming`, `SessionStreamHub`, sidecar IPC).
- `PanelContainer`, `EditorPanel`, `Inspector`, `Composer` internals — their
  interfaces stay; they consume `(workspaceId, sessionId)` via the new
  context instead of the singleton.

## 5. Components

| Unit | Path | Purpose |
|---|---|---|
| `Pane` (type) | `src/shell/panes/types.ts` | In-memory record of one open chat surface. |
| `PanesProvider` | `src/shell/panes/provider.tsx` | Owns panes + focus + operations; persists layout to `localStorage`. |
| `PanesGrid` | `src/shell/panes/grid.tsx` | Renders main-target panes in a 1/2/4-cell CSS grid. |
| `PaneShell` | `src/shell/panes/pane-shell.tsx` | Wrapper that injects `PaneIdentityContext` around `PanelContainer`. |
| `PaneIdentityContext` | `src/shell/panes/identity-context.tsx` | React context exposing `{paneId, workspaceId, sessionId}` to descendants. |
| `PaneErrorBoundary` | `src/shell/panes/error-boundary.tsx` | Isolates a pane crash so siblings keep working. |
| Detached window route | `src/pane-route.tsx` + new `pane.html` entry | Bootstrap for the second webview. |
| Pane window commands | `src-tauri/src/commands/panes.rs` | Open / close / focus / destroyed-event handlers for detached webviews. |
| `PanelContainer` (modified) | `src/features/panel/container.tsx` | Takes `(workspaceId, sessionId)` from props/context instead of the singleton. |
| Sidebar (modified) | `src/features/navigation/` | Adds "open in new pane" modifier-click affordance. |

For each new unit:

### 5.1 `PanesProvider`
- **What it does.** Holds `Pane[]` + `focusedPaneId` and exposes mutating ops.
- **How you use it.** Wrap the app in `<PanesProvider>`. Inside, call
  `usePanes()`.
- **What it depends on.** Tauri `WebviewWindow` API (via the Rust commands),
  `nanoid`, the `localStorage` persistence helper.

### 5.2 `PanesGrid`
- **What it does.** Lays out main-target panes; renders a `<PaneShell />` per
  cell wrapped in a focus border.
- **How you use it.** Place once in `AppShell`. No props.
- **What it depends on.** `usePanes()`, `PaneShell`, existing panel-resize
  hooks.

### 5.3 `PaneShell` + `PaneIdentityContext`
- **What they do.** Inject pane identity into the subtree, then render
  `<PanelContainer />`.
- **How you use them.** Internal — used only by `PanesGrid` and the detached
  route.
- **What they depend on.** `PanelContainer`.

### 5.4 Detached window route
- **What it does.** Bootstraps a slim React root in the secondary webview;
  renders one `<PaneShell />` plus a minimal title bar.
- **How you use it.** Reached only via `pane_window_open` from the main
  window's `PanesProvider`.
- **What it depends on.** Tauri `WebviewWindow`, `commands/panes.rs`.

### 5.5 `commands/panes.rs`
- **What it does.** Thin wrapper over `WebviewWindowBuilder`. No state of its
  own beyond a `HashMap<String, WindowLabel>` to make open/close idempotent.
- **How you use it.** Tauri commands invoked from `PanesProvider`.
- **What it depends on.** `tauri::WebviewWindowBuilder`, `tauri::Manager`,
  the existing window-event registration in `lib.rs`.

## 6. Data Flow

### 6.1 State down (provider → pane → existing hooks)

`PanesProvider`'s reducer is the only writer of pane identity. Each
`<PaneShell>` reads its `Pane` from `usePanes()` by id. Existing per-pane
hooks (`useWorkspaceDetail`, `useWorkspaceSessions`, etc.) now key on the
pane's `workspaceId` instead of the singleton. No new query options —
`helmorQueryKeys.workspaceDetail(workspaceId)` already accepts any id;
React Query naturally dedupes when the same workspace is open in two panes.

Per-pane composer state (draft, focus, scroll) stays in component-local
state. Drafts are already persisted to SQLite per session in
`composer/draft-storage.ts`; no change there.

### 6.2 Events up (sidecar streaming → focused pane and beyond)

Sidecar emits events keyed by `session_id`; `SessionStreamHub` already lets
any subscriber listen for any session. Each `PanelContainer` mounted in a
pane calls `useStreaming(sessionId)`, which opens a Tauri `Channel` for that
session. N panes for N sessions = N channels.

Two panes pointing at the same session both subscribe and both render the
live stream. This is intentional (e.g., detach a pane to read history while
the focused pane drives the chat).

### 6.3 Cross-window IPC (main ↔ detached)

Detached webviews are separate React roots — they can't share
`PanesProvider` state directly. We bridge over Tauri events:

- Main window emits `helmor://pane:state-changed` whenever a pane row
  changes (rename, close, sessionId swap). Detached windows for affected
  panes pick up the new identity.
- Detached windows emit `helmor://pane:request-close` and
  `helmor://pane:request-reattach`. Main window's `PanesProvider` listens
  and applies the change.
- The Rust side (`commands/panes.rs`) is a passive relay — no state of its
  own beyond the window-label registry.

### 6.4 Lazy / "auth-check-style" rules

To keep N panes affordable (echoing #750's pattern):

1. **Mount = subscribe.** A pane registered in `PanesProvider` but not yet
   rendered does NOT open any stream channel. Subscription happens in a
   `useEffect` inside `PanelContainer`, gated on `isMounted && isVisible`.
2. **Hidden tabs / minimized windows pause non-essential polls.** React
   Query's `refetchIntervalInBackground: false` becomes the default for
   per-pane queries; streaming channels stay live (losing live messages
   would be wrong).
3. **Same-workspace dedup is automatic** via React Query — no custom layer.
4. **No background warming**: don't prefetch the next pane's data on hover.
5. **Layout restore, streaming opt-in.** On app start, restore pane
   identities (the grid + detached-window layout looks the same) but do
   NOT auto-resume streaming for sessions that weren't actively streaming
   when the app last closed. The user clicks/types to re-engage.

### 6.5 Backend sanity item to validate before shipping

`SessionStreamHub`'s subscriber model: confirm there is no implicit
single-subscriber assumption. Two panes on the same session must each
receive the full event stream. Covered by the Rust integration test in §8.

## 7. Error handling

Multi-pane introduces six failure modes the single-pane app doesn't have.

### 7.1 Pane points at a deleted workspace or session
`PanelContainer`'s existing "session not found" empty state covers
sessionless panes. `PaneShell` adds a similar "workspace not found" check
that switches the pane to the workspace/session picker rather than
crashing. `PanesProvider` listens for `RepositoryListChanged` /
`WorkspaceArchived` UI-sync events; on a still-open pane whose target is
gone, it clears the pane's `(workspaceId, sessionId)` to `(null, null)`
instead of closing the pane. The user picked a layout; respect it.

### 7.2 Detached window closed externally
Listen for Tauri's `tauri://destroyed` event on each `pane-<id>` window.
On fire, `PanesProvider` removes the pane from its list. No
"are you sure?" prompt — same semantics as closing a browser tab.

Inverse: if the main window closes but a detached pane window survives
(possible on macOS), close it too. Enforced via
`tauri::Manager::on_window_event` in `commands/panes.rs`.

### 7.3 Same session open in N panes → simultaneous send
The streaming layer already serializes by `request_id` per session; a
second send queues. Don't add a new gate; surface it visually: a small
"another pane is sending" badge on the inactive pane's composer.

Drafts are per-session in SQLite (single source of truth), so both panes
share the draft. Focused-pane-wins: the focused pane writes drafts; others
are viewers until focused.

### 7.4 Soft cap exceeded (~6)
`open()` returns the pane id but emits a `close-suggestion` event picked up
by a toast: *"You have 7 chats open. Performance may degrade — consider
closing one."* Do NOT refuse.

Hard refusal only for one case: a 5th main-target pane (grid maxes at
2×2). Refused with a toast: *"Detach a pane to open another in the grid."*

### 7.5 `WebviewWindow` open failure
Tauri returns an error from `WebviewWindowBuilder::build` (rare). `detach()`
rejects; the pane stays in the grid; toast surfaces the error. No
recovery loop.

### 7.6 `localStorage` layout payload is corrupt / from a future version
Single-version key (`helmor.panes.layout.v1`). On parse failure or unknown
version, drop silently and start with one empty pane. No migration
framework for v1.

### 7.7 Error-boundary discipline
One `<PaneErrorBoundary />` per cell. If a pane crashes, only that cell
shows an inline "this pane crashed, click to reload" affordance; siblings
keep working. Crash is reported via the existing
`console.error` → `tracing::error!` bridge.

### 7.8 What we explicitly do NOT handle as errors

- "User opens 6 panes" — that's their choice.
- "Two panes show the same session" — explicit feature.
- "Stream lag in a background pane" — naturally fixed by lazy mount + tab
  focus rules.

## 8. Testing

| Surface | Level | File |
|---|---|---|
| `PanesProvider` reducer | unit | `src/shell/panes/provider.test.ts` |
| `PanesGrid` layout | component | `src/shell/panes/grid.test.tsx` |
| `PaneShell` wiring | component | `src/shell/panes/pane-shell.test.tsx` |
| Pane ↔ stream | integration | `src/features/conversation/use-streaming.multipane.test.tsx` |
| `commands/panes.rs` | unit | inline `#[cfg(test)] mod tests` |
| Two subscribers on a session | rust integration | new test file `src-tauri/tests/streaming_multi_subscriber.rs` |
| Open second pane + stream both | E2E | `tests/e2e/multi-pane.spec.ts` |

### 8.1 `PanesProvider` reducer (Vitest)
- `open()` adds and focuses.
- `open()` past the main-target hard cap (4) is refused.
- `open()` past the soft cap (6) succeeds and emits `close-suggestion`.
- `close()` removes; focus moves to the next pane if focused.
- `close()` on a detached pane triggers `pane_window_close`.
- `detach()` moves `target` from `"main"` to `{window: "pane-<id>"}`.
- `reattach()` is the inverse.
- `replaceTarget()` swaps ids without touching `id` or `target`.
- `localStorage` persists between calls; parse failure resets to one empty
  pane.
- Simulated `WorkspaceArchived` on an open pane clears
  `(workspaceId, sessionId)` to `(null, null)` without closing the pane.

### 8.2 `PanesGrid` (Vitest + RTL)
- 1 pane → 1×1; 2 → 1×2; 3 → 2×2 with one empty; 4 → full 2×2.
- Focus border follows `focusedPaneId`.
- Clicking an unfocused cell calls `focus(id)`.

### 8.3 `PaneShell` + `PanelContainer` wiring (Vitest + RTL)
- Rendering `<PaneShell>` with `(A, X)` causes mocked `useStreaming`,
  `useWorkspaceDetail`, etc. to receive the right ids.
- Switching the shell to `(B, Y)` unsubscribes the old channel (assert
  mocked `unlisten` called) and subscribes the new one.
- `<PaneErrorBoundary>` catches a thrown error from a stubbed child and
  shows the reload affordance; siblings unaffected.

### 8.4 `commands/panes.rs` (Rust unit)
- `pane_window_open` with a duplicate id returns the existing window
  (idempotent).
- `pane_window_close` on an unknown id is a no-op.
- `on_window_event(Destroyed)` for `pane-<id>` removes the pane from the
  registry.
- Both macOS and Windows code paths exercised — `WebviewWindowBuilder` has
  platform-specific args (decorations, traffic lights).

### 8.5 E2E (Playwright)
One happy path: open the app → open a second pane on a different workspace
→ send a message in pane A while pane B is idle → both stream correctly →
close pane A → pane B keeps streaming and remains focused.

### 8.6 Backend sanity (Rust integration)
New `src-tauri/tests/streaming_multi_subscriber.rs`. Subscribe two
observers to the same `session_id` on `SessionStreamHub`; confirm both
receive the same event stream. Catches a single-subscriber assumption (if
any) before the UI exercises it.

### 8.7 What we explicitly do NOT test
- Detached window creation across operating systems beyond one Playwright
  happy path. Manual smoke when bumping Tauri.
- Performance under N panes. Covered by judgment and the lazy rules in
  §6.4, not asserted in CI.

## 9. Implementation sequencing

Land in 6 small PRs, each shippable on its own (regressing single-pane UX is
the failure mode to avoid):

1. **`PanesProvider` + grid scaffolding, single-pane mode.** Pure refactor:
   the app looks identical, but `<PanelContainer />` lives inside a
   one-cell `<PanesGrid>`. Behavior-preserving.
2. **`PanelContainer` consumes props/context, not singleton.** Migrate
   every `useAppShellState` workspace/session read to `usePaneIdentity`.
3. **Open a second pane (cap 2, grid 1×2).** Adds the "+ open in new
   pane" sidebar affordance and the soft-cap toast plumbing.
4. **Detached-window plumbing.** Adds `commands/panes.rs`,
   `pane-route.tsx`, the second webview entrypoint, the cross-window IPC
   bridge.
5. **Soft cap to 6 + grid expansion to 2×2.** Lifts the grid layout to
   the full 2×2 and the soft-cap toast UX.
6. **Layout persistence.** `localStorage` save / restore at the
   `PanesProvider` level. Restore identities only; do not auto-resume
   streaming.

Each PR has its own tests. The reducer unit tests can be written ahead of
time in PR 1 and remain useful through every subsequent PR.

## 10. Out of scope (future work)

- **Per-pane sidebars** in detached windows.
- **Pane-as-virtual-window via `react-mosaic-component`** for free dnd +
  tab nesting. Possible iteration after the native grid lands.
- **Tabified grid cells** (multiple panes per cell, tabified). Worth
  considering once we have feedback on how users actually arrange the
  grid.
- **Cross-app drag of a pane to another monitor** as a first-class
  gesture rather than the explicit "detach" button.
- **Saved layout presets** ("split for code review," "single-chat focus
  mode").

## 11. Open questions

None blocking. Two we'll resolve in PR-level design:

- Exact serialization shape of the `helmor.panes.layout.v1` localStorage
  payload (proposed: `{ version: 1, panes: Pane[], focusedPaneId: string |
  null }`).
- Whether the sidebar in the main window should also gain a small
  "open panes" list to make detached-elsewhere panes findable, or whether
  the OS taskbar / Mission Control is sufficient.
