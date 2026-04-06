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
```

## Architecture

### Two-process model (Tauri)

- **Frontend** (`src/`): React SPA rendered in a Tauri webview. All state lives in `App.tsx` via `useState`. No router, no external state manager.
- **Backend** (`src-tauri/src/`): Rust process exposing Tauri commands via `invoke()`. Reads/writes Helmor's own SQLite database (`~/helmor/helmor.db` or `~/helmor-dev/helmor.db`). Spawns CLI subprocesses for agent communication.

### Frontend structure

| Path                                    | Role                                                                                                                                                                                                                                                                                                     |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/App.tsx`                           | Root component. Owns all application state (workspaces, sessions, messages, sidebar width, theme, sending state). Orchestrates data loading and agent message flow.                                                                                                                                      |
| `src/lib/api.ts`                        | **IPC bridge**. Every Tauri `invoke()` call is here. Exports typed async functions (`loadWorkspaceGroups`, `sendAgentMessage`, `startAgentMessageStream`, `mergeFromConductor`, etc.) and all shared TypeScript types. Falls back to hardcoded defaults when Tauri runtime is absent (pure browser dev). |
| `src/lib/stream-accumulator.ts`         | Accumulates Claude CLI JSON stream lines into renderable `SessionMessageRecord[]` snapshots for real-time UI updates during streaming.                                                                                                                                                                   |
| `src/lib/message-adapter.ts`            | Converts `SessionMessageRecord[]` into chat-renderable message structures for the workspace panel. Handles JSON-encoded messages (tool calls, thinking, results, errors) and plain text.                                                                                                                 |
| `src/lib/utils.ts`                      | `cn()` helper (clsx + tailwind-merge).                                                                                                                                                                                                                                                                   |
| `src/components/workspace-panel.tsx`    | Chat/message display area with session tabs. Uses `@assistant-ui/react` for message rendering with `@assistant-ui/react-markdown` for markdown.                                                                                                                                                          |
| `src/components/workspace-composer.tsx` | Message input with model selector and image attachment support.                                                                                                                                                                                                                                          |
| `src/components/workspaces-sidebar.tsx` | Sidebar listing workspace groups (done/review/progress/backlog/canceled) with collapsible sections, archive/restore actions.                                                                                                                                                                             |
| `src/components/ui/`                    | shadcn/ui primitives (base-nova style, Tailwind v4 CSS variables).                                                                                                                                                                                                                                       |

### Backend structure (`src-tauri/src/`)

| File                   | Role                                                                                                                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib.rs`               | Tauri app builder. Registers all commands, manages `RunningAgentProcesses` state, runs setup hook (directory + schema init).                                                                         |
| `data_dir.rs`          | Resolves the Helmor data directory (`~/helmor` or `~/helmor-dev`). Supports `HELMOR_DATA_DIR` env var override.                                                                                      |
| `schema.rs`            | Database schema initialization — creates all tables/indexes/triggers if not present.                                                                                                                 |
| `import.rs`            | Optional merge-import of data from a local Conductor installation via SQLite `ATTACH DATABASE` + `INSERT OR IGNORE`. Atomic (transaction-wrapped), non-destructive (existing Helmor data preserved). |
| `error.rs`             | `CommandError` wrapper — bridges `anyhow::Error` to Tauri-serializable errors for IPC.                                                                                                               |
| `models/mod.rs`        | Tauri command handlers — thin wrappers calling sub-modules.                                                                                                                                          |
| `models/db.rs`         | Database connection opening via `data_dir::db_path()`.                                                                                                                                               |
| `models/repos.rs`      | Repos table CRUD + git repository resolution.                                                                                                                                                        |
| `models/workspaces.rs` | Workspaces table CRUD + archive/restore + workspace creation.                                                                                                                                        |
| `models/sessions.rs`   | Sessions/messages/attachments queries + read/unread marking.                                                                                                                                         |
| `models/settings.rs`   | Settings key-value store.                                                                                                                                                                            |
| `models/git_ops.rs`    | Git mirror, worktree, and branch management.                                                                                                                                                         |
| `models/helpers.rs`    | Display helpers, naming, filesystem copy, icon resolution.                                                                                                                                           |
| `agents.rs`            | Spawns Claude Code / Codex CLI subprocesses, streams stdout line-by-line back to the frontend via Tauri events (`agent-stream:{streamId}`). Manages running process PIDs.                            |

### Data flow

1. Frontend calls `api.ts` functions (e.g., `loadWorkspaceGroups()`)
2. These call `invoke("list_workspace_groups")` via Tauri IPC
3. Rust handler queries SQLite and returns serialized JSON
4. For agent messages: frontend calls `startAgentMessageStream()` → Rust spawns CLI process → emits `AgentStreamEvent`s → frontend listens via `listenAgentStream()` → `StreamAccumulator` builds partial messages → `message-adapter.ts` converts for rendering

### Key conventions

- **Path alias**: `@/` maps to `src/` (configured in both `tsconfig.json` and `vite.config.ts`)
- **Styling**: Tailwind CSS v4 with semantic color tokens (`bg-app-base`, `bg-app-sidebar`, `bg-app-elevated`, `text-app-foreground`, etc.) defined in `App.css` using oklch
- **UI components**: shadcn/ui (base-nova style, `components.json` configured, no RSC)
- **Chat rendering**: `@assistant-ui/react` with `ExternalStoreRuntime` for message display, `@assistant-ui/react-markdown` + `remark-gfm` for markdown
- **Testing**: Vitest + jsdom + @testing-library/react. Setup in `src/test/setup.ts`. Tests co-located with source (e.g., `App.test.tsx`).
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
