# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Helmor

Helmor is a local-first desktop app built with **Tauri v2** (Rust backend) + **React 19** + **Vite** + **TypeScript**. It provides a workspace management UI that connects to a local [Conductor](https://conductor.app) SQLite database, letting users browse workspaces/sessions/messages and send prompts to AI agents (Claude Code CLI, OpenAI Codex CLI) via streaming or blocking IPC.

## UI Design Source of Truth

- `DESIGN.md` at the repository root is the source of truth for any user-facing visual change.
- Before making any UI, styling, layout, typography, spacing, color, component, or motion change, read `DESIGN.md` and align the implementation with it.
- Do not invent or apply a new visual direction for the product without first consulting `DESIGN.md`.
- If a requested UI change conflicts with `DESIGN.md`, explicitly call out the conflict and ask whether to prioritize the request or the design system.
- When finishing UI work, briefly state how the implementation follows `DESIGN.md`, or note any intentional deviation.

## Commands

```bash
pnpm install                 # Install dependencies (pnpm 10+, enforced via packageManager)
pnpm run dev                 # Vite dev server on localhost:1420 (frontend only, no Tauri)
pnpm run tauri dev           # Full desktop app: Rust backend + Vite frontend with HMR
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

Export a Conductor fixture for local development:
```bash
scripts/conductor/export-repo-fixture.sh --repo <repo-name>
```

## Architecture

### Two-process model (Tauri)

- **Frontend** (`src/`): React SPA rendered in a Tauri webview. All state lives in `App.tsx` via `useState`. No router, no external state manager.
- **Backend** (`src-tauri/src/`): Rust process exposing Tauri commands via `invoke()`. Reads/writes a Conductor-format SQLite database. Spawns CLI subprocesses for agent communication.

### Frontend structure

| Path | Role |
|---|---|
| `src/App.tsx` | Root component. Owns all application state (workspaces, sessions, messages, sidebar width, theme, sending state). Orchestrates data loading and agent message flow. |
| `src/lib/conductor.ts` | **IPC bridge**. Every Tauri `invoke()` call is here. Exports typed async functions (`loadWorkspaceGroups`, `sendAgentMessage`, `startAgentMessageStream`, etc.) and all shared TypeScript types. Falls back to hardcoded defaults when Tauri runtime is absent (pure browser dev). |
| `src/lib/stream-accumulator.ts` | Accumulates Claude CLI JSON stream lines into renderable `SessionMessageRecord[]` snapshots for real-time UI updates during streaming. |
| `src/lib/message-adapter.ts` | Converts Conductor `SessionMessageRecord[]` into `@assistant-ui/react` `ThreadMessageLike[]` for the chat panel. Handles JSON-encoded messages (tool calls, thinking, results, errors) and plain text. |
| `src/lib/utils.ts` | `cn()` helper (clsx + tailwind-merge). |
| `src/components/workspace-panel.tsx` | Chat/message display area with session tabs. |
| `src/components/workspace-composer.tsx` | Message input with model selector and image attachment support. |
| `src/components/workspaces-sidebar.tsx` | Sidebar listing workspace groups (done/review/progress/backlog/canceled) with collapsible sections, archive/restore actions. |
| `src/components/ui/` | shadcn/ui primitives (base-nova style, Tailwind v4 CSS variables). |

### Backend structure (`src-tauri/src/`)

| File | Role |
|---|---|
| `lib.rs` | Tauri app builder. Registers all commands and manages `RunningAgentProcesses` state. |
| `conductor.rs` | SQLite queries against the Conductor database. All workspace/session/message CRUD. Fixture data lives in `.local-data/conductor/`. Uses `rusqlite` with bundled SQLite. |
| `agents.rs` | Spawns Claude Code / Codex CLI subprocesses, streams stdout line-by-line back to the frontend via Tauri events (`agent-stream:{streamId}`). Manages running process PIDs. |

### Data flow

1. Frontend calls `conductor.ts` functions (e.g., `loadWorkspaceGroups()`)
2. These call `invoke("list_workspace_groups")` via Tauri IPC
3. Rust handler queries SQLite and returns serialized JSON
4. For agent messages: frontend calls `startAgentMessageStream()` → Rust spawns CLI process → emits `AgentStreamEvent`s → frontend listens via `listenAgentStream()` → `StreamAccumulator` builds partial messages → `message-adapter.ts` converts for rendering

### Key conventions

- **Path alias**: `@/` maps to `src/` (configured in both `tsconfig.json` and `vite.config.ts`)
- **Styling**: Tailwind CSS v4 with semantic color tokens (`bg-app-base`, `bg-app-sidebar`, `bg-app-elevated`, `text-app-foreground`, etc.) defined in `App.css` using oklch
- **UI components**: shadcn/ui (base-nova style, `components.json` configured, no RSC)
- **Testing**: Vitest + jsdom + @testing-library/react. Setup in `src/test/setup.ts`. Tests co-located with source (e.g., `App.test.tsx`).
- **Fixture data**: `.local-data/conductor/` contains exported Conductor database + workspace context directories. Gitignored. Created via `scripts/conductor/export-repo-fixture.sh`.
- **macOS window chrome**: Overlay title bar with traffic lights at (16, 24). Drag region via `data-tauri-drag-region`.
- **Serde convention**: Rust structs use `#[serde(rename_all = "camelCase")]` so JSON fields match TypeScript types directly.
