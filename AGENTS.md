# AGENTS.md

This file provides guidance to AI coding agents working with code in this repository.

## What is Helmor

Helmor is a local-first desktop app built with **Tauri v2** (Rust backend) + **React 19** + **Vite** + **TypeScript**. It provides a workspace management UI with its own SQLite database (`~/helmor/` in release, `~/helmor-dev/` in debug), letting users browse workspaces/sessions/messages and send prompts to AI agents (Claude Code CLI, OpenAI Codex CLI) via streaming or blocking IPC. Data can be optionally imported from a local [Conductor](https://conductor.app) installation.

## UI Design Source of Truth

- `DESIGN.md` at the repository root is the source of truth for any user-facing visual change.
- Before making any UI, styling, layout, typography, spacing, color, component, or motion change, read `DESIGN.md` and align the implementation with it.
- Do not invent or apply a new visual direction for the product without first consulting `DESIGN.md`.
- If a requested UI change conflicts with `DESIGN.md`, explicitly call out the conflict and ask whether to prioritize the request or the design system.
- When finishing UI work, briefly state how the implementation follows `DESIGN.md`, or note any intentional deviation.

## Commands

```bash
pnpm install                 # Install dependencies (pnpm 10+, enforced via packageManager)
pnpm run dev                 # Full desktop app: Tauri + Vite + dev API server (localhost:1420 also serves real data)
pnpm run dev:vite            # Vite dev server only (no Tauri, no API)
pnpm run dev:api             # Dev API server only (localhost:3001, serves real data for browser mode)
pnpm run build               # tsc + vite build (frontend bundle to dist/)
pnpm run test                # vitest run (single pass)
pnpm run test:watch          # vitest in watch mode
```

Run a single test file:

```bash
pnpm vitest run src/App.test.tsx
```

Rust backend (from `src-tauri/`):

```bash
cargo build                  # Build Tauri backend
cargo check                  # Type-check without building
cargo test                   # Run all Rust tests (lib + integration)
cargo clippy -- -D warnings  # Lint (must pass before committing)
```

## Architecture

### Two-process model (Tauri)

- **Frontend** (`src/`): React SPA rendered in a Tauri webview. All state lives in `App.tsx` via `useState`. No router, no external state manager.
- **Backend** (`src-tauri/src/`): Rust process exposing Tauri commands via `invoke()`. Reads/writes Helmor's own SQLite database (`~/helmor/helmor.db` or `~/helmor-dev/helmor.db`). Spawns CLI subprocesses for agent communication.

### Frontend structure

The frontend is a thin renderer — there is **no** TypeScript stream accumulator or message adapter. Both live in Rust (`src-tauri/src/pipeline/`); the frontend receives ready-to-render `ThreadMessageLike[]` and paints it.

| Path                                    | Role                                                                                                              |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `src/App.tsx`                           | Root component. Owns all application state via `useState`.                                                        |
| `src/lib/api.ts`                        | IPC bridge — every Tauri `invoke()` call. Falls back to `devFetch(...)` against the dev API server in browser dev. |
| `src/lib/query-client.ts`               | React Query keys + query options factories.                                                                       |
| `src/components/workspace-panel.tsx`    | Chat thread + tabs. `@assistant-ui/react` + `react-virtuoso` + `use-stick-to-bottom`.                             |
| `src/components/workspace-composer.tsx` | Message input with model selector + image attachments.                                                            |
| `src/components/workspaces-sidebar.tsx` | Sidebar workspace groups (done/review/progress/backlog/canceled).                                                 |
| `src/components/ui/`                    | shadcn/ui primitives (base-nova).                                                                                 |

### Backend structure (`src-tauri/src/`)

| File                               | Role                                                                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib.rs`                           | Tauri app builder. Registers commands, runs setup hook (data dir + schema init + migrations).                                                    |
| `data_dir.rs`                      | Resolves `~/helmor` (release) or `~/helmor-dev` (debug). `HELMOR_DATA_DIR` env override.                                                         |
| `schema.rs`                        | Schema + idempotent migrations.                                                                                                                  |
| `import.rs`                        | Optional Conductor merge-import via SQLite `ATTACH DATABASE` + `INSERT OR IGNORE`.                                                               |
| `error.rs`                         | `CommandError` — bridges `anyhow::Error` to Tauri IPC.                                                                                           |
| `sidecar.rs`                       | Long-running TS sidecar process manager. Pub/sub of sidecar events keyed by request id.                                                          |
| `dev_api.rs` + `bin/dev_server.rs` | axum dev server on :3001 mirroring every Tauri command for browser mode. **New commands MUST be wired here too.**                                |
| `models/`                          | Tauri command handlers split by domain (`repos`, `workspaces`, `sessions`, `settings`, `git_ops`).                                               |
| `agents.rs`                        | Streaming + persistence. `send_agent_message_stream` takes a `tauri::ipc::Channel<AgentStreamEvent>` and pushes pipeline output through it.      |
| `pipeline/`                        | Message pipeline: `accumulator` → `adapter` + `collapse` → `ThreadMessageLike[]`. Shared by streaming and historical reload paths.               |

### Message data flow

```
Live streaming      sidecar events ──push_event──┐
                                                 ▼
                                      IntermediateMessage[] ──▶ adapter + collapse ──▶ ThreadMessageLike[]
                                                 ▲
Historical reload   session_messages rows ──convert_historical──┘
```

Both paths converge at `IntermediateMessage[]` and share the adapter + collapse stages, so any rendering bug shows up in both.

**Storage shape**: `session_messages.content` always holds JSON. The top-level `type` discriminates: `user_prompt` (real human input), `user` (SDK tool_result wrapped as user), `assistant`, `system`, `error`, `result`, `item.completed` (Codex — `agent_message` or `command_execution`), `turn.completed`. The DB stores **post-accumulator** form (one row per logical turn). The Claude SDK delivers blocks **delta-style** — multiple `assistant` events with the same `msg_id`, each carrying one new block — and the accumulator APPENDs them.

**🚨 Any change touching `pipeline/`, `agents.rs` persistence, `schema.rs` migrations, or the storage shape MUST be covered by a snapshot test in `src-tauri/tests/`.** See "Pipeline tests" below.

### Pipeline tests (`src-tauri/tests/`)

Three insta-based test targets sharing `tests/common/mod.rs` (builders, normalization, fixture loaders):

| Target                  | What it covers                                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- |
| `pipeline_scenarios.rs` | Handcrafted edge cases (35+ tests). Normalized snapshots — strips ids/timestamps, focuses on structural shape.  |
| `pipeline_fixtures.rs`  | Real DB sessions in `tests/fixtures/pipeline/<name>/input.json`, auto-discovered via `insta::glob!`. Raw snapshots for full fidelity. |
| `pipeline_streams.rs`   | Raw SDK stream-event jsonl in `tests/fixtures/streams/` (also read by the sidecar tests via `../../src-tauri/tests/fixtures/streams/`). Three-stage round-trip: streaming render → persistence → historical reload. |

**Workflow**:

```bash
cargo test --tests                                   # Run all integration tests
INSTA_UPDATE=always cargo test --tests               # Accept new/changed snapshots
cargo insta review                                   # Interactive accept/reject (recommended)
cargo run --bin gen_pipeline_fixture -- <session_id> <name>   # Capture a new real fixture
```

When a snapshot drifts: stop. Look at the diff. Decide whether the new shape is the **intended** behavior or a regression. Only accept after triage. The `.snap` files in git are the source of truth for "what each pipeline scenario currently produces" — reviewers see them in PR diffs.

### Key conventions

- **Path alias**: `@/` maps to `src/` (configured in both `tsconfig.json` and `vite.config.ts`)
- **Styling**: Tailwind CSS v4 with semantic color tokens (`bg-app-base`, `bg-app-sidebar`, `bg-app-elevated`, `text-app-foreground`, etc.) defined in `App.css` using oklch
- **UI components**: shadcn/ui (base-nova style, `components.json` configured, no RSC)
- **Chat rendering**: `@assistant-ui/react` with `ExternalStoreRuntime` for message display, `@assistant-ui/react-markdown` + `remark-gfm` for markdown
- **Frontend testing**: Vitest + jsdom + @testing-library/react. Setup in `src/test/setup.ts`. Tests co-located with source.
- **Rust testing**: lib unit tests inline + insta integration tests under `src-tauri/tests/`. Pipeline changes need snapshot coverage (see above).
- **Data directory**: `~/helmor/` (release) or `~/helmor-dev/` (debug). Override with `HELMOR_DATA_DIR` env var. Database auto-created on first startup.
- **macOS window chrome**: Overlay title bar with traffic lights at (16, 24). Drag region via `data-tauri-drag-region`.
- **Serde convention**: Rust structs use `#[serde(rename_all = "camelCase")]` so JSON fields match TypeScript types directly.
- **Rust clippy**: All Rust code must pass `cargo clippy -- -D warnings` with zero warnings. Run clippy before committing any Rust changes.

## Browser Debugging (Agent Browser)

- `pnpm run dev` 启动后，`http://localhost:1420` 可在浏览器中访问完整应用（含真实数据），Vite 会将 `/api/*` 请求代理到 dev API server（localhost:3001）。
- 当需要调试 UI、排查性能问题、检查布局或验证视觉变更时，**优先使用 `/agent-browser` skill** 连接浏览器进行调试，而不是仅靠阅读代码猜测。
- `/agent-browser` 可以导航页面、截图、检查元素、分析性能、执行 JavaScript 等。
- 如果 `localhost:1420` 没有数据或无法访问，先让用户确认 `pnpm run dev` 已运行。
- 推荐调试流程：用 `/agent-browser` 访问 `http://localhost:1420` → 截图确认当前状态 → 定位问题 → 修改代码 → 刷新页面验证。

### Maintaining browser bridge for new Tauri commands

When adding a new Tauri command that does file I/O or data queries:

1. Add a wrapper function in `src-tauri/src/dev_api.rs` calling the underlying model function.
2. Add a route + handler in `src-tauri/src/dev_server_bin.rs` (GET for reads, POST for writes).
3. In `src/lib/api.ts`, the `if (!inv)` branch must call `devFetch(...)` instead of throwing or returning hardcoded fallback.

Never throw "only available in Tauri" for any command that has a dev server counterpart.
