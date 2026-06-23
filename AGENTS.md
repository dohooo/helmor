# AGENTS.md

This file provides guidance to AI coding agents working with code in this repository.

## What is Helmor

Helmor is a local-first desktop app built with **Tauri v2** (Rust backend) + **React 19** + **Vite** + **TypeScript**. It provides a workspace management UI with its own SQLite database (`~/helmor/` in release, `~/helmor-dev/` in debug), letting users browse workspaces/sessions/messages and send prompts to AI agents (Claude Code CLI, OpenAI Codex CLI, OpenCode) via streaming IPC.

## Commands

```bash
bun install                  # Install deps (bun 1.3+). Also runs `bun install` in sidecar/ via postinstall.
bun run dev                  # dev:prepare + vite build + tauri dev (builds dist/ so companion serves current bundle)
bun run dev:analyze          # Same as dev, with perf HUD (VITE_HELMOR_PERF_HUD=1)
bun run build                # tsc + vite build (frontend bundle to dist/)
bun run typecheck            # tsc --noEmit for frontend AND sidecar
bun run lint                 # biome check . + cargo clippy -- -D warnings
bun run lint:fix             # biome --write + cargo clippy --fix + cargo fmt
```

Tests are **three targets** — `bun run test` runs all three (frontend -> sidecar -> rust). Pre-commit hook runs biome on JS/TS and clippy/fmt on Rust.

```bash
bun run test                 # All three suites
bun run test:frontend        # vitest run (jsdom, @testing-library/react)
bun run test:sidecar         # cd sidecar && bun test
bun run test:rust            # cd src-tauri && cargo test
bun run test:rust:update-snapshots    # INSTA_UPDATE=always
bun run test:watch           # vitest watch (frontend only)
```

Single test file: `bun x vitest run src/App.test.tsx` | `cd sidecar && bun test src/foo.test.ts` | `cd src-tauri && cargo test --test pipeline_scenarios -- <name>`

## Architecture

### Three-process model

- **Frontend** (`src/`): React 19 SPA in Tauri webview. State managed by focused hooks in `shell/hooks/` (`useAppShellState`, `useSelectionController`, `useEditorEditMode`, `useGlobalShortcutHandlers`, `useAppBootstrap`) + TanStack React Query + context providers.
- **Rust backend** (`src-tauri/src/`): Tauri host, SQLite database, spawns and supervises the sidecar.
- **Sidecar** (`sidecar/`): Bun + TypeScript, wraps `@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`, and `@opencode-ai/sdk`. Built to `sidecar/dist/helmor-sidecar` via `bun build --compile`. JSON event stream over stdout.

Message flow: user prompt -> Rust `agents::streaming` -> sidecar -> SDK -> stdout events -> Rust accumulator -> adapter + collapse -> `ThreadMessageLike[]` -> `tauri::ipc::Channel` -> React.

### Frontend structure (`src/`)

Feature-based layout. Each feature folder follows: `index.tsx` (main) + `container.tsx` (data/state) + `hooks/` + tests.

| Path | Role |
| --- | --- |
| `App.tsx` | Root (~18 lines). Composition layer that delegates to AppProviders and AppShell. |
| `features/panel/` | Chat thread container, header, message components, thread viewport. |
| `features/conversation/` | Conversation renderer + `use-streaming` hook. |
| `features/composer/` | Lexical-based message input. Plugins in `editor/plugins/`. |
| `features/editor/` | Monaco file editor surface. |
| `features/inspector/` | Right-side inspector (actions, changes sections). |
| `features/navigation/` | Sidebar workspace groups. |
| `features/commit/` | Commit button + lifecycle hook. |
| `features/terminal/` | Terminal Mode session panel, presets (boot command builders), session store with PTY lifecycle. |
| `features/settings/` | Settings dialog + panels (CLI install, repo settings, Conductor import). |
| `shell/` | Top-level layout, GitHub identity gate, panel resize hooks. State orchestration in `hooks/`: `use-app-shell-state.tsx` (central hub), `use-selection-controllers.ts` (selection/context/start TDZ ring), `use-editor-edit-mode.ts`, `use-global-shortcut-handlers.ts`, and `use-app-bootstrap.ts` (app initialization). All <300 lines/file. |
| `components/ai/` | AI-specific components (code block, file tree, reasoning). |
| `components/ui/` | shadcn/ui primitives (base-nova). |
| `components/terminal-output-scheduler.ts` | PTY output coalescing (8ms flush window, 16KB threshold) to reduce IPC cost. |
| `lib/api.ts` | IPC bridge -- every Tauri `invoke()` call wrapped as a typed function. |
| `lib/query-client.ts` | React Query keys + query options factories. |
| `lib/settings.ts` | App settings context with Tauri storage. |

### Backend structure (`src-tauri/src/`)

| Module | Role |
| --- | --- |
| `lib.rs` | Tauri app builder. Registers commands, runs setup hook. |
| `commands/` | Tauri command handlers split by domain (session, repository, workspace, editor, github, conductor, settings, system). `terminal_commands.rs` includes `set_terminal_session_busy` and `create_session` (now accepts `session_kind` and `agent_type` parameters). |
| `agents/` | Agent streaming + persistence (catalog, persistence, queries, streaming, support). |
| `cli/` | CLI entry point + subcommands. `terminal_hook.rs` provides the hidden `terminal-hook` command used by agent CLIs to communicate PTY lifecycle events (session id, busy/idle, prompt capture). |
| `pipeline/` | Message pipeline: `accumulator/` -> `adapter/` + `collapse` -> `ThreadMessageLike[]`. Includes `event_filter.rs`, `classify.rs`, `types.rs`. |
| `workspace/` | Workspace operations (branching, lifecycle, helpers) + `files/` sub-module (editor, changes, types). `scripts.rs` includes PTY output coalescing (8ms flush window, 16KB threshold, UTF-8 safe flush). |
| `git/` | Git operations (ops, watcher). |
| `github/` | GitHub integration (auth, CLI, GraphQL). |
| `models/` | Persistence layer (db, repos, sessions, settings, workspaces). Sessions table now has `session_kind` (distinguishes terminal vs GUI sessions) and `agent_type` (tracks which agent is being used). |
| `service.rs` | Service layer. |
| `sidecar.rs` | Sidecar process manager (spawn, stdio, graceful SIGTERM). |
| `schema.rs` | DB schema + idempotent migrations. |
| `mcp.rs` | MCP bridge integration. |
| `logging.rs` | Structured logging setup. |
| `data_dir.rs` | Data dir resolution. `HELMOR_DATA_DIR` env override. |
| `error.rs` | `CommandError` -- bridges `anyhow::Error` to Tauri IPC. |

### Sidecar structure (`sidecar/src/`)

`index.ts` (entry, stdin/stdout JSON) | `session-manager.ts` (base lifecycle) | `claude-session-manager.ts` | `codex-session-manager.ts` | `opencode-protocol/session-manager.ts` (shared protocol manager) | `opencode-protocol/server.ts` | `opencode-protocol/opencode.ts` (opencode config) | `codex-skill-scanner.ts` | `request-parser.ts` | `emitter.ts` | `abort.ts` | `images.ts` | `title.ts` | `logger.ts`

### Message data flow

```
Live streaming      sidecar events --> accumulator --> adapter + collapse --> ThreadMessageLike[]
Historical reload   DB rows --> convert_historical ----^
```

Both paths converge at `IntermediateMessage[]` and share adapter + collapse.

**Storage shape**: `session_messages.content` is JSON. Top-level `type` discriminates: `user_prompt`, `user`, `assistant`, `system`, `error`, `result`, `item.completed` (Codex), `turn.completed`. DB stores post-accumulator form. Claude SDK delivers delta-style blocks; accumulator APPENDs them.

**🚨 Any change touching `pipeline/`, `agents/` persistence, `schema.rs`, or the storage shape MUST have snapshot test coverage in `src-tauri/tests/`.**

### Pipeline tests (`src-tauri/tests/`)

Three insta-based targets sharing `tests/common/mod.rs`:

- `pipeline_scenarios.rs` -- Handcrafted edge cases (70+ tests). Normalized snapshots.
- `pipeline_fixtures.rs` -- Real DB sessions in `tests/fixtures/pipeline/`, auto-discovered via `insta::glob!`.
- `pipeline_streams.rs` -- Raw SDK stream-event JSONL in `tests/fixtures/streams/`. Three-stage round-trip.

```bash
cd src-tauri && cargo test --tests                                           # All integration tests
cd src-tauri && INSTA_UPDATE=always cargo test --tests                       # Accept new snapshots
cd src-tauri && cargo insta review                                           # Interactive accept/reject
cd src-tauri && cargo run --example gen_pipeline_fixture -- <session_id> <name>  # Capture real fixture
```

When a snapshot drifts: look at the diff first. Only accept after confirming the new shape is intended, not a regression.

## Key conventions

- **Path alias**: `@/` maps to `src/`
- **Styling**: Tailwind CSS v4, oklch semantic tokens. Three-layer architecture in `src/styles/color-theme.css`:
  1. **Base** — atomic semantics (`--bg-base / --bg-surface / --bg-elevated / --bg-overlay`, `--fg-default / --fg-muted / --fg-subtle / --fg-disabled`, `--border-default / --border-subtle / --border-strong`, `--accent-default / --accent-hover / --accent-muted`, `--status-success/warning/danger/info`). This is the only layer theme presets touch.
  2. **Shadcn/ui interface** — `--background / --foreground / --primary / --muted / --sidebar / ...` forward Base via `var()`. These are the shadcn ecosystem protocol; shadcn primitives and copy-paste examples target them. Not a shim — a deliberate public surface.
  3. **Region** — bg-only chrome tokens for each pane (`--titlebar-bg / --sidebar-bg / --panel-bg / --inspector-bg / --composer-bg / --editor-chrome-bg / --terminal-chrome-bg / --statusbar-bg / --settings-nav-bg`). Region fg/border intentionally do **not** exist — pane text/borders consume Base globally so reading rhythm stays consistent across the shell. Sidebar is the lone exception (it gets `--sidebar-fg*` + `--sidebar-item-*` because Slack-style themes invert fg on dark sidebars).
- **Typography**: Semantic font-size tokens (`text-nano` … `text-heading`) live in `src/styles/color-theme.css` (Typography scale section), exposed via `App.css` `@theme inline`; pick by role, not px. Don't write `text-[Npx]` in app code — fold it into a token (the comment in `color-theme.css` lists the few allowed off-scale exceptions). New font-size tokens must also be registered with tailwind-merge in `src/lib/utils.ts`, otherwise `cn("text-{token} text-{color}")` collapses to just the color.
- **Locked surfaces** (do not put inside theme presets): `--panel-message-* / --panel-code-* / --editor-content-* / --editor-gutter-* / --editor-line-active-bg / --editor-selection-bg / --editor-cursor`, all `--terminal-*`, the status palette (`--chart-* / --subagent-* / --workspace-*`, `--status-success/warning/danger/info`). These follow light/dark only — readability and semantic colors (red=danger, green=merged) must not change with the chrome theme.
- **Designing a new theme**: add a `.theme-<name>:not(.dark) { ... }` + `.dark.theme-<name> { ... }` block at the bottom of `color-theme.css`. Override Base tokens only (typically `--bg-base / --bg-surface / --bg-elevated / --accent-default / --accent-fg / --border-default / --ring-default` — about 10 values). Region tokens auto-derive. Then add the name to `ColorTheme` + `VALID_COLOR_THEMES` in `src/lib/settings.ts` and to the picker options in `src/features/settings/panels/appearance.tsx`. Both `.theme-<name>:not(.dark)` and `.dark.theme-<name>` blocks are required because `lightTheme` and `darkTheme` are independent settings — users may pair your preset with either mode. Do NOT override locked surfaces in a preset.
- **Monaco theme**: `src/lib/monaco-runtime.ts` builds the editor theme by reading CSS variables through a hidden DOM probe (`resolveCssColor`). On any `<html>` class mutation (light/dark or preset switch) it re-defines both themes and re-applies. Syntax-highlight rules stay hard-coded so code colors are stable across themes — chrome (background/gutter/widgets/diff) follows the active theme.
- **xterm theme**: `src/components/terminal-output.tsx` resolves `--terminal-*` via `getComputedStyle` and pushes a new `ITheme` into `terminal.options.theme` on class mutation. The ANSI palette is locked (light/dark only).
- **UI**: shadcn/ui (base-nova), `lucide-react` icons. **No `@assistant-ui/react` or `react-virtuoso`** -- removed, do not re-introduce.
- **Cursor**: Clickable elements default to `cursor-pointer` (baked into base UI components; keep it on custom `<div onClick>` too). Users can flip the whole app back to the platform arrow via Appearance settings → "Use pointer cursors" (adds `.no-pointer-cursors` on `<html>`); don't bypass with inline `style={{ cursor }}`.
- **Chat rendering**: `streamdown` + `use-stick-to-bottom`. Markdown overrides in `src/components/streamdown-components.tsx`.
- **Rich text input**: Lexical in `src/features/composer/editor/`.
- **File editor**: Monaco, lazy via `src/lib/monaco-runtime.ts`.
- **Linting**: Biome (tab indent). `lint-staged` enforces on pre-commit.
- **Testing**: Vitest + jsdom (frontend), `bun test` (sidecar), cargo test + insta (Rust). Tests co-located with source.
- **Changesets**: A `.changeset/*.md` body uses the smallest shape that fits — a single prose sentence (default for simple patch-level changes) or a prose summary line followed by `- ` sub-items (only when ≥2 distinct user-visible changes are worth enumerating). Never start the body with `- `. See the `helmor-release` skill for full format and rationale.
- **Data dir**: `~/helmor/` (release) or `~/helmor-dev/` (debug). Override: `HELMOR_DATA_DIR`.
- **macOS chrome**: Overlay title bar, traffic lights at (16, 24). Drag via `data-tauri-drag-region`.
- **Serde**: `#[serde(rename_all = "camelCase")]` -- JSON fields match TypeScript directly.
- **Persisting React Query data**: Every query is **in-memory only by default**. To persist a query across app restarts, set `meta: PERSIST_META` (alias for `{ persist: true }`) on its `queryOptions` / `useQuery` call. Only do this for data the user must see *immediately on cold start* (sidebar lists, identity chips). Never opt in large or fast-refetching queries — the persisted blob is read synchronously on boot. See `src/lib/query-client.ts` for the wiring; the `react-query.d.ts` augmentation closes `meta`'s shape so typos like `presist` fail at compile time.
- **Backend → frontend notifications**: Always go through `UiMutationEvent` (`src-tauri/src/ui_sync/events.rs`). Add a typed variant, broadcast with `crate::ui_sync::publish(&app, ...)`, mirror the variant in `UiMutationEvent` in `src/lib/api.ts`, and handle it in `src/shell/hooks/use-ui-sync-bridge.ts` to invalidate the right React Query keys. Do NOT add ad-hoc `app.emit("custom-event", ...)` channels with their own component-level `listen(...)` -- they fragment cache invalidation, skip the global bridge, and are easy to leak. Terminal session lifecycle uses `TerminalActivityChanged` (busy/idle transitions), `TerminalSessionIdle` (completion notification), and `TerminalPromptCaptured` (title and branch-rename generation).
- **Adding a Triage provider**: A provider lives in `sidecar/src/triage/providers/<id>.ts` implementing `TriageProvider` from `providers/types.ts` (`preflight()` → `buildTools(ctx)` → `promptHint(ctx)`), registered in `providers/registry.ts`, and mirrored by a `PROVIDER_SPECS` row in `src/features/settings/panels/triage.tsx` so the toggle shows up in Settings → Experimental → Local LLM → Auto-triage. Provider tools must write fetched data as Markdown into the per-tick `ScratchSession`; the agent then uses the built-in `scratch_grep` / `scratch_read` to fish out slices instead of stuffing raw API JSON into the context window.
- **Clippy**: Must pass `cargo clippy --all-targets -- -D warnings` with zero warnings.
- **Perf**: `VITE_HELMOR_PERF_HUD=1` enables HUD + react-scan + long-frame tracker.
- **Logging**: Dev defaults to `debug`. Override: `HELMOR_LOG=info|debug|error`. JSONL logs in `{data_dir}/logs/`.
- **Bundled forge CLIs (`gh`, `glab`, `cloudflared`)**: Pinned + SHA256-verified in `sidecar/scripts/vendor-platform.ts`. `cloudflared` powers the mobile-companion tunnel feature. To upgrade:
  1. Bump `GH_VERSION` / `GLAB_VERSION` / `CLOUDFLARED_VERSION`.
  2. Pull the new SHA256 from `…/checksums.txt` (URLs in the file's header comment) and update `GH_SHA256` / `GLAB_SHA256` / `CLOUDFLARED_SHA256`.
  3. Re-run `bun run build` in `sidecar/` — the changed SHA256 auto-forces a re-download + verify (no manual wipe). Downloaded archives now live in a shared, cross-worktree cache (the main worktree's `sidecar/.bundle-cache`, override `HELMOR_BUNDLE_CACHE`); wipe that only if you want a forced clean fetch.
  Bump cadence: every release cycle if upstream has shipped a notable fix; immediately on security advisories. Pin so the auth-status JSON shape Helmor parses doesn't drift unexpectedly.
- **Bundled agent CLIs (`claude-code`, `codex`, `opencode`)**: Pulled in via `sidecar/package.json` and staged into `sidecar/dist/vendor/{claude-code,codex,opencode}/` as platform-native binaries. All three upstreams ship per-platform npm sub-packages (`@anthropic-ai/claude-code-darwin-{arm64,x64}`, `@openai/codex-darwin-{arm64,x64}`, `opencode-darwin-{arm64,x64}`). Cross-arch CI staging downloads the tarball straight from the npm registry and verifies against `CLAUDE_CODE_SHA256` / `CODEX_SHA256` / `OPENCODE_SHA256` in `vendor-platform.ts`. The `stage-vendor.ts` script stages claude-code, codex, opencode, gh, glab, and cloudflared CLIs. To upgrade:
  1. Bump the version in `sidecar/package.json`, `cd sidecar && bun install`.
  2. Compute the SHA256 of both arch tarballs (`shasum -a 256` on the cached `.tgz`) and update the table in `stage-vendor.ts` (key it under the new version string).
  3. Run `bun run build` in `sidecar/` to verify — a changed SHA256 auto-forces a re-download (shared cache at the main worktree's `sidecar/.bundle-cache`, override `HELMOR_BUNDLE_CACHE`; no manual wipe needed).
  Both binaries are `bun build --compile` output (~200 MB each on macOS), so `maybeSignMacBinary(_, true)` is required — JSC needs `allow-jit` / `allow-unsigned-executable-memory` under hardened runtime. Run pipeline snapshot tests after every claude-code bump (`cd src-tauri && cargo test --tests`); the SDK event shape is the contract Helmor's accumulator depends on.

## 🚨 Code organization rules

**Never let a single file grow into a monolith.** In early 2026 the codebase went through a full refactor precisely because too much logic had been crammed into too few files (App.tsx alone was 1976 lines). The split delivered 22 focused files (all <300 lines, largest 299) that isolate re-render scopes and keep responsibilities clear. Follow these rules strictly:

1. **One responsibility per file.** If a file handles two unrelated concerns, split it.
2. **Use module directories.** When a module grows beyond ~300 lines, convert `foo.rs` to `foo/mod.rs` + sub-files, or split `foo.tsx` into a `foo/` folder with `index.tsx` + focused sub-modules. The `agents/`, `pipeline/`, `workspace/`, `commands/` directories are the reference pattern.
3. **Frontend: feature folders.** New features go into `src/features/<name>/` with `index.tsx`, optional `container.tsx`, `hooks/`, and tests. Shared components go into `src/components/`. Do NOT put feature-specific logic in `src/lib/` or `App.tsx`.
4. **Backend: commands vs. domain logic.** Tauri `#[command]` handlers go in `commands/`. Business logic and domain operations go in their own modules (`workspace/`, `agents/`, `git/`, etc.). Do not mix IPC glue with domain logic.
5. **When in doubt, split.** It is always easier to merge two small files than to untangle a 1000-line monolith.

## Terminal Mode

Terminal Mode is a composer toggle (settings opt-in) that sends prompts directly to Claude Code or Codex CLI in a live PTY terminal session, bypassing the SDK streaming pipeline. Terminal sessions render in the main panel alongside GUI chat sessions.

**Key features:**

- WebGL context management: only visible terminals hold GPU contexts, staying within Chromium/WebKit budget limits.
- Coalesced PTY output: 8ms flush window, 16KB threshold to reduce per-event IPC cost on high-throughput output.
- Lifecycle hooks: idle detection, title generation, and completion notifications matching GUI behavior. Hooks inject `helmor terminal-hook` as a callback command into the agent's session lifecycle events (SessionStart, UserPromptSubmit, Stop).
- Resume support: the agent's real session id is persisted via hooks, enabling `--resume` on relaunch.

**Structure:**

- Frontend: `src/features/terminal/` (session panel, presets, boot command builder, session store with PTY lifecycle).
- Backend: `src-tauri/src/cli/terminal_hook.rs` (hook callback command), `src-tauri/src/commands/terminal_commands.rs` (spawn, resize, busy-state commands), `src-tauri/src/workspace/scripts.rs` (PTY output coalescing).
- Components: `src/components/terminal-output-scheduler.ts` (output coalescing).

## Debugging (Tauri MCP only)

> **Hard rule:** Use the Tauri MCP bridge (`tauri-plugin-mcp-bridge`) only. No `chrome-devtools` MCP, no `/agent-browser`. Helmor runs in Tauri webview only.

### Prerequisites

1. **Debug build only.** MCP bridge is behind `#[cfg(debug_assertions)]`. Always `bun run dev`.
2. **Open driver session first.** Call `driver_session action=status` before `start`. Default port `9223`, window `main`.
3. **Sanity-check.** Call `ipc_get_backend_state` after connecting to confirm the right instance.

### Tool playbook (condensed)

- **UI state**: `webview_screenshot` -> `webview_dom_snapshot type=accessibility` (prefer ref IDs for follow-ups)
- **User input**: `webview_interact` + `webview_keyboard`. Never dispatch synthetic events via `webview_execute_js`.
- **IPC tracing**: `ipc_monitor start` -> trigger flow -> `ipc_get_captured filter=<cmd>` -> `ipc_monitor stop`. Always stop when done.
- **Direct backend call**: `ipc_execute_command command=... args=...` to bypass frontend.
- **Async waits**: `webview_wait_for type=ipc-event value=<event>` for streaming/pipeline events.
- **Console/system logs**: `read_logs source=console` or `source=system filter=helmor`.
- **JS eval**: `webview_execute_js script="(() => <expr>)()"` (IIFE, JSON-serializable return). Cannot see React state.
- **Styles**: `webview_get_styles selector=... properties=[...]`.
- **Element picker**: `webview_select_element` or `webview_get_pointed_element` (Alt+Shift+Click).
- **Window geometry**: `manage_window action=list|info|resize`.

### Pitfalls

- Release builds have no MCP bridge.
- `webview_screenshot` = visible viewport only. Scroll first if needed.
- `ipc_monitor` is sticky -- stop it explicitly.
- Tauri MCP does not see sidecar HTTP/WS traffic. Check JSONL logs in `{data_dir}/logs/`.
- Ref IDs are per-snapshot. Re-snapshot after UI state changes.
