# AGENTS.md

This file provides guidance to AI coding agents working with code in this repository.

## What is Helmor

Helmor is a local-first desktop app built with **Tauri v2** (Rust backend) + **React 19** + **Vite** + **TypeScript**. It provides a workspace management UI with its own SQLite database (`~/helmor/` in release, `~/helmor-dev/` in debug), letting users browse workspaces/sessions/messages and send prompts to AI agents (Claude Code CLI, OpenAI Codex CLI) via streaming IPC.

## Commands

```bash
pnpm install                 # Install deps (pnpm 10+). Also runs `bun install` in sidecar/ via postinstall.
pnpm run dev                 # Full desktop app: Tauri + Vite (localhost:1420 in webview)
pnpm run dev:analyze         # Same as dev, with perf HUD (VITE_HELMOR_PERF_HUD=1)
pnpm run build               # tsc + vite build (frontend bundle to dist/)
pnpm run typecheck           # tsc --noEmit for frontend AND sidecar
pnpm run lint                # biome check . + cargo clippy -- -D warnings
pnpm run lint:fix            # biome --write + cargo clippy --fix + cargo fmt
```

Tests are **three targets** — `pnpm run test` runs all three (frontend -> sidecar -> rust). Pre-commit hook runs biome on JS/TS and clippy/fmt on Rust.

```bash
pnpm run test                # All three suites
pnpm run test:frontend       # vitest run (jsdom, @testing-library/react)
pnpm run test:sidecar        # cd sidecar && bun test
pnpm run test:rust           # cd src-tauri && cargo test
pnpm run test:rust:update-snapshots   # INSTA_UPDATE=always
pnpm run test:watch          # vitest watch (frontend only)
```

Single test file: `pnpm vitest run src/App.test.tsx` | `cd sidecar && bun test src/foo.test.ts` | `cd src-tauri && cargo test --test pipeline_scenarios -- <name>`

## Architecture

### Three-process model

- **Frontend** (`src/`): React 19 SPA in Tauri webview. Root state in `App.tsx` via `useState` + TanStack React Query + context providers.
- **Rust backend** (`src-tauri/src/`): Tauri host, SQLite database, spawns and supervises the sidecar.
- **Sidecar** (`sidecar/`): Bun + TypeScript, wraps `@anthropic-ai/claude-agent-sdk` and `@openai/codex-sdk`. Built to `sidecar/dist/helmor-sidecar` via `bun build --compile`. JSON event stream over stdout.

Message flow: user prompt -> Rust `agents::streaming` -> sidecar -> SDK -> stdout events -> Rust accumulator -> adapter + collapse -> `ThreadMessageLike[]` -> `tauri::ipc::Channel` -> React.

### Frontend structure (`src/`)

Feature-based layout. Each feature folder follows: `index.tsx` (main) + `container.tsx` (data/state) + `hooks/` + tests.

| Path | Role |
| --- | --- |
| `App.tsx` | Root. Owns selection state, view mode, sending status. |
| `features/panel/` | Chat thread container, header, message components, thread viewport. |
| `features/conversation/` | Conversation renderer + `use-streaming` hook. |
| `features/composer/` | Lexical-based message input. Plugins in `editor/plugins/`. |
| `features/editor/` | Monaco file editor surface. |
| `features/inspector/` | Right-side inspector (actions, changes sections). |
| `features/navigation/` | Sidebar workspace groups. |
| `features/commit/` | Commit button + lifecycle hook. |
| `features/settings/` | Settings dialog + panels (CLI install, repo settings, Conductor import). |
| `shell/` | Top-level layout, GitHub identity gate, panel resize hooks. |
| `components/ai/` | AI-specific components (code block, file tree, reasoning). |
| `components/ui/` | shadcn/ui primitives (base-nova). |
| `lib/api.ts` | IPC bridge -- every Tauri `invoke()` call wrapped as a typed function. |
| `lib/query-client.ts` | React Query keys + query options factories. |
| `lib/settings.ts` | App settings context with Tauri storage. |

### Backend structure (`src-tauri/src/`)

| Module | Role |
| --- | --- |
| `lib.rs` | Tauri app builder. Registers commands, runs setup hook. |
| `commands/` | Tauri command handlers split by domain (session, repository, workspace, editor, github, conductor, settings, system). |
| `agents/` | Agent streaming + persistence (catalog, persistence, queries, streaming, support). |
| `pipeline/` | Message pipeline: `accumulator/` -> `adapter/` + `collapse` -> `ThreadMessageLike[]`. Includes `event_filter.rs`, `classify.rs`, `types.rs`. |
| `workspace/` | Workspace operations (branching, lifecycle, helpers) + `files/` sub-module (editor, changes, types). |
| `git/` | Git operations (ops, watcher). |
| `github/` | GitHub integration (auth, CLI, GraphQL). |
| `models/` | Persistence layer (db, repos, sessions, settings, workspaces). |
| `service.rs` | Service layer. |
| `sidecar.rs` | Sidecar process manager (spawn, stdio, graceful SIGTERM). |
| `schema.rs` | DB schema + idempotent migrations. |
| `mcp.rs` | MCP bridge integration. |
| `logging.rs` | Structured logging setup. |
| `data_dir.rs` | Data dir resolution. `HELMOR_DATA_DIR` env override. |
| `error.rs` | `CommandError` -- bridges `anyhow::Error` to Tauri IPC. |

### Sidecar structure (`sidecar/src/`)

`index.ts` (entry, stdin/stdout JSON) | `session-manager.ts` (base lifecycle) | `claude-session-manager.ts` | `codex-session-manager.ts` | `codex-skill-scanner.ts` | `request-parser.ts` | `emitter.ts` | `abort.ts` | `images.ts` | `title.ts` | `logger.ts`

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
cd src-tauri && cargo run --bin gen_pipeline_fixture -- <session_id> <name>  # Capture real fixture
```

When a snapshot drifts: look at the diff first. Only accept after confirming the new shape is intended, not a regression.

## Key conventions

- **Path alias**: `@/` maps to `src/`
- **Styling**: Tailwind CSS v4 with oklch semantic color tokens (`bg-app-base`, `text-app-foreground`, etc.)
- **UI**: shadcn/ui (base-nova), `lucide-react` icons. **No `@assistant-ui/react` or `react-virtuoso`** -- removed, do not re-introduce.
- **Cursor**: Every clickable element MUST have `cursor-pointer`. This is already baked into base UI components (`Button`, `SidebarMenuButton`, `CommandItem`, `DropdownMenuItem`, `ContextMenuItem`, etc.). When adding custom clickable elements (e.g. `<div onClick>`), always include `cursor-pointer`.
- **Chat rendering**: `streamdown` + `use-stick-to-bottom`. Markdown overrides in `src/components/streamdown-components.tsx`.
- **Rich text input**: Lexical in `src/features/composer/editor/`.
- **File editor**: Monaco, lazy via `src/lib/monaco-runtime.ts`.
- **Linting**: Biome (tab indent). `lint-staged` enforces on pre-commit.
- **Testing**: Vitest + jsdom (frontend), `bun test` (sidecar), cargo test + insta (Rust). Tests co-located with source.
- **Data dir**: `~/helmor/` (release) or `~/helmor-dev/` (debug). Override: `HELMOR_DATA_DIR`.
- **macOS chrome**: Overlay title bar, traffic lights at (16, 24). Drag via `data-tauri-drag-region`.
- **Serde**: `#[serde(rename_all = "camelCase")]` -- JSON fields match TypeScript directly.
- **Clippy**: Must pass `cargo clippy --all-targets -- -D warnings` with zero warnings.
- **Perf**: `VITE_HELMOR_PERF_HUD=1` enables HUD + react-scan + long-frame tracker.
- **Logging**: Dev defaults to `debug`. Override: `HELMOR_LOG=info|debug|error`. JSONL logs in `{data_dir}/logs/`.

## 🚨 Code organization rules

**Never let a single file grow into a monolith.** This codebase just went through a painful refactoring precisely because too much logic was crammed into too few files. Follow these rules strictly:

1. **One responsibility per file.** If a file handles two unrelated concerns, split it.
2. **Use module directories.** When a module grows beyond ~300 lines, convert `foo.rs` to `foo/mod.rs` + sub-files, or split `foo.tsx` into a `foo/` folder with `index.tsx` + focused sub-modules. The `agents/`, `pipeline/`, `workspace/`, `commands/` directories are the reference pattern.
3. **Frontend: feature folders.** New features go into `src/features/<name>/` with `index.tsx`, optional `container.tsx`, `hooks/`, and tests. Shared components go into `src/components/`. Do NOT put feature-specific logic in `src/lib/` or `App.tsx`.
4. **Backend: commands vs. domain logic.** Tauri `#[command]` handlers go in `commands/`. Business logic and domain operations go in their own modules (`workspace/`, `agents/`, `git/`, etc.). Do not mix IPC glue with domain logic.
5. **When in doubt, split.** It is always easier to merge two small files than to untangle a 1000-line monolith.

## Debugging (Tauri MCP only)

> **Hard rule:** Use the Tauri MCP bridge (`tauri-plugin-mcp-bridge`) only. No `chrome-devtools` MCP, no `/agent-browser`. Helmor runs in Tauri webview only.

### Prerequisites

1. **Debug build only.** MCP bridge is behind `#[cfg(debug_assertions)]`. Always `pnpm run dev`.
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
