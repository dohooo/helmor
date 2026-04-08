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
pnpm install                 # Install dependencies (pnpm 10+, enforced via packageManager). Also runs `bun install` in sidecar/ via postinstall.
pnpm run dev                 # Full desktop app: Tauri + Vite (webview served at localhost:1420 inside the app window)
pnpm run dev:analyze         # Same as dev, with VITE_HELMOR_PERF_HUD=1 + HELMOR_SIDECAR_DEBUG=1 (perf HUD + sidecar trace)
pnpm run build               # tsc + vite build (frontend bundle to dist/)
pnpm run typecheck           # tsc --noEmit for frontend AND sidecar (both must pass)
pnpm run lint                # biome check . + cargo clippy -- -D warnings
pnpm run lint:fix            # biome --write + cargo clippy --fix + cargo fmt
```

Tests are **three targets** — `pnpm run test` runs all three in order (frontend → sidecar → rust). A pre-commit hook (husky + lint-staged) runs biome on staged JS/TS and clippy/fmt on staged Rust.

```bash
pnpm run test                # All three suites (frontend + sidecar + rust)
pnpm run test:frontend       # vitest run (jsdom, @testing-library/react)
pnpm run test:sidecar        # cd sidecar && bun test
pnpm run test:rust           # cd src-tauri && cargo test
pnpm run test:rust:update-snapshots   # INSTA_UPDATE=always — accept new insta snapshots
pnpm run test:watch          # vitest in watch mode (frontend only)
```

Run a single test file:

```bash
pnpm vitest run src/App.test.tsx                                         # Single frontend test
cd sidecar && bun test src/claude-session-manager.test.ts                # Single sidecar test
cd src-tauri && cargo test --test pipeline_scenarios -- <name>           # Single rust integration test
```

Rust backend one-offs (from `src-tauri/`):

```bash
cargo check                                     # Type-check without building
cargo test                                      # Run all Rust tests
cargo clippy --all-targets -- -D warnings       # Lint (must pass before committing)
```

## Architecture

### Three-process model (Tauri + Rust + Bun sidecar)

- **Frontend** (`src/`): React 19 SPA rendered in a Tauri webview. All state lives in `App.tsx` via `useState`. No router, no external state manager.
- **Rust backend** (`src-tauri/src/`): Tauri host process exposing commands via `invoke()`. Reads/writes Helmor's own SQLite database (`~/helmor/helmor.db` release or `~/helmor-dev/helmor.db` debug). Spawns and supervises the sidecar.
- **Sidecar** (`sidecar/`): Standalone Bun + TypeScript project that wraps `@anthropic-ai/claude-agent-sdk` and `@openai/codex-sdk`. Built to a single binary at `sidecar/dist/helmor-sidecar` via `bun build --compile`. The Rust process launches it as a child, reads stdout/stderr as a JSON event stream, and pushes events into the pipeline. Has its own `bun test` suite (`pnpm run test:sidecar`).

Message lifetime: user sends a prompt → Rust `agents::send_agent_message_stream` forwards to the sidecar → sidecar calls the SDK → SDK events stream back via stdout → Rust accumulator collects them → pipeline adapter/collapse produces `ThreadMessageLike[]` → Rust pushes into a `tauri::ipc::Channel` → React paints.

### Frontend structure

The frontend is a thin renderer — there is **no** TypeScript stream accumulator or message adapter. Both live in Rust (`src-tauri/src/pipeline/`); the frontend receives ready-to-render `ThreadMessageLike[]` and paints it. Many components follow a `*-container.tsx` (stateful, data fetching) + `*.tsx` (presentational) split — edit the container for data/behavior and the inner component for layout/markup.

| Path                                              | Role                                                                                                              |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `src/App.tsx`                                     | Root component. Owns all application state via `useState`.                                                        |
| `src/lib/api.ts`                                  | IPC bridge — every Tauri `invoke()` call wrapped as a typed function.                                            |
| `src/lib/query-client.ts`                         | React Query keys + query options factories.                                                                       |
| `src/lib/message-layout-estimator.ts`             | Virtualization height estimator for the conversation list (hot path — changes need perf testing).                |
| `src/lib/perf-marks.ts` + `dev-*`                 | Perf instrumentation (long-frame tracker, render debug, react-scan) gated on `VITE_HELMOR_PERF_HUD`.              |
| `src/components/workspace-panel.tsx`              | Chat thread. Native scroll + `use-stick-to-bottom` (NO virtualization, NO `@assistant-ui`).                       |
| `src/components/workspace-conversation-container.tsx` | Conversation data loader for the panel.                                                                        |
| `src/components/workspace-composer.tsx`           | Message input with model selector + image attachments (Lexical editor under `composer-editor/`).                 |
| `src/components/workspace-editor-surface.tsx`     | Monaco-based file editor surface (loaded via dynamic import in `monaco-runtime.ts`).                             |
| `src/components/workspace-inspector-sidebar.tsx`  | Right-side inspector for workspace details.                                                                      |
| `src/components/workspaces-sidebar.tsx`           | Sidebar workspace groups (done/review/progress/backlog/canceled).                                                 |
| `src/components/streamdown-components.tsx`        | Custom overrides for the `streamdown` markdown renderer (code blocks, etc).                                       |
| `src/components/ui/`                              | shadcn/ui primitives (base-nova).                                                                                 |

### Backend structure (`src-tauri/src/`)

| File                                 | Role                                                                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib.rs`                             | Tauri app builder. Registers commands, runs setup hook (data dir + schema init + migrations + bundled CLI resource resolution). |
| `data_dir.rs`                        | Resolves `~/helmor` (release) or `~/helmor-dev` (debug). `HELMOR_DATA_DIR` env override.                                                         |
| `schema.rs`                          | Schema + idempotent migrations.                                                                                                                  |
| `import.rs`                          | Optional Conductor merge-import via SQLite `ATTACH DATABASE` + `INSERT OR IGNORE`.                                                               |
| `error.rs`                           | `CommandError` — bridges `anyhow::Error` to Tauri IPC.                                                                                           |
| `sidecar.rs`                         | Bun sidecar process manager (spawn, stdio, graceful SIGTERM). Pub/sub of sidecar events keyed by request id.                                     |
| `models/` (`auth`, `db`, `editor_files`, `git_ops`, `github_cli`, `repos`, `sessions`, `settings`, `workspaces`, `helpers`) | Tauri command handlers split by domain. |
| `agents.rs`                          | Streaming + persistence. `send_agent_message_stream` takes a `tauri::ipc::Channel<AgentStreamEvent>` and pushes pipeline output through it.      |
| `pipeline/` (`accumulator/`, `adapter/`, `classify.rs`, `collapse.rs`, `types.rs`) | Message pipeline: `accumulator` → `adapter` + `collapse` → `ThreadMessageLike[]`. Shared by streaming and historical reload paths. |
| `bin/gen_pipeline_fixture.rs`        | Dev helper binary for capturing real DB sessions into `tests/fixtures/pipeline/`.                                                                |

### Sidecar structure (`sidecar/src/`)

| File                         | Role                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------- |
| `index.ts`                   | Entry point. Reads JSON requests from stdin, writes events to stdout.                            |
| `request-parser.ts`          | Parses incoming request frames from the Rust host.                                                |
| `session-manager.ts`         | Base session lifecycle (abort, emit, cleanup).                                                    |
| `claude-session-manager.ts`  | Claude-specific driver using `@anthropic-ai/claude-agent-sdk`.                                    |
| `codex-session-manager.ts`   | Codex-specific driver using `@openai/codex-sdk`.                                                  |
| `codex-skill-scanner.ts`     | Discovers available Codex skills.                                                                 |
| `emitter.ts`                 | Stdout event serialization.                                                                      |
| `abort.ts`                   | Cooperative cancellation wiring.                                                                  |
| `images.ts`                  | Image attachment preprocessing.                                                                  |
| `title.ts`                   | Session title generation.                                                                        |

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
cd src-tauri && cargo test --tests                                           # Run all integration tests
cd src-tauri && INSTA_UPDATE=always cargo test --tests                       # Accept new/changed snapshots
cd src-tauri && cargo insta review                                           # Interactive accept/reject (recommended)
cd src-tauri && cargo run --bin gen_pipeline_fixture -- <session_id> <name>  # Capture a new real fixture
```

When a snapshot drifts: stop. Look at the diff. Decide whether the new shape is the **intended** behavior or a regression. Only accept after triage. The `.snap` files in git are the source of truth for "what each pipeline scenario currently produces" — reviewers see them in PR diffs.

### Key conventions

- **Path alias**: `@/` maps to `src/` (configured in both `tsconfig.json` and `vite.config.ts`)
- **Styling**: Tailwind CSS v4 with semantic color tokens (`bg-app-base`, `bg-app-sidebar`, `bg-app-elevated`, `text-app-foreground`, etc.) defined in `App.css` using oklch
- **UI components**: shadcn/ui (base-nova style, `components.json` configured, no RSC). Radix primitives + `@base-ui/react` for some pieces. Icons are `lucide-react` (+ `@primer/octicons-react` sparingly).
- **Chat rendering**: `streamdown` + `use-stick-to-bottom` for the assistant thread. Code blocks use `@streamdown/code` (Shiki-based). Markdown overrides live in `src/components/streamdown-components.tsx`. **No `@assistant-ui/react` or `react-virtuoso`** — they were removed; do not re-introduce them.
- **Rich text input**: Lexical (`@lexical/react`) in `src/components/composer-editor/`.
- **File editor**: Monaco, lazy-loaded via `src/lib/monaco-runtime.ts`.
- **Frontend linting**: Biome (`biome.json` — tab indent, react domain rules recommended). Run via `pnpm run lint`; `lint-staged` enforces it on pre-commit.
- **Frontend testing**: Vitest + jsdom + @testing-library/react. Setup in `src/test/setup.ts`. Tests co-located with source.
- **Sidecar testing**: `bun test` from `sidecar/`. Shares stream fixtures with Rust via `../src-tauri/tests/fixtures/streams/`.
- **Rust testing**: lib unit tests inline + insta integration tests under `src-tauri/tests/`. Pipeline changes need snapshot coverage (see above).
- **Data directory**: `~/helmor/` (release) or `~/helmor-dev/` (debug). Override with `HELMOR_DATA_DIR` env var. Database auto-created on first startup.
- **macOS window chrome**: Overlay title bar with traffic lights at (16, 24). Drag region via `data-tauri-drag-region`.
- **Serde convention**: Rust structs use `#[serde(rename_all = "camelCase")]` so JSON fields match TypeScript types directly.
- **Rust clippy**: All Rust code must pass `cargo clippy --all-targets -- -D warnings` with zero warnings. Run clippy before committing any Rust changes — `lint-staged` enforces it on `*.rs` pre-commit along with `cargo fmt`.
- **Performance instrumentation**: `VITE_HELMOR_PERF_HUD=1` enables the in-app perf HUD + `react-scan` + long-frame tracker in `src/lib/dev-*`. `HELMOR_SIDECAR_DEBUG=1` makes the sidecar log every event. Use `pnpm run dev:analyze` to turn both on at once. Perf notes and reproducers live in `docs/perf/`.

## Debugging (Tauri MCP only)

> **Hard rule:** Helmor debugging uses the Tauri MCP bridge (`tauri-plugin-mcp-bridge`) and nothing else. Do **not** use `chrome-devtools` MCP, `/agent-browser`, or any browser-based debugging. There is no browser mode to debug — Helmor only runs inside the Tauri webview, and the MCP bridge attaches directly to that real webview. Every behavior you care about (window chrome, title bar drag, real IPC, console logs, sidecar events) lives there and only there.

### Prerequisites

1. **Must be a debug build.** The MCP bridge plugin is wired in `src-tauri/src/lib.rs` behind `#[cfg(debug_assertions)]` and does not exist in release binaries. Always start the app via `pnpm run dev` (or `pnpm run dev:analyze` for perf HUD + sidecar trace). Never attempt to connect to a release binary — it will fail.
2. **Open a driver session before any other tool call.** Every `webview_*`, `ipc_*`, `manage_window`, and `read_logs source=console` tool requires an active session. Default port is `9223`; main window label is `main`. Call `driver_session action=status` before `start` to avoid stacking duplicates. When multiple Tauri apps are running, disambiguate with `appIdentifier`. Stop with `action=stop` when the debugging session ends.
3. **Sanity-check the connection.** Call `ipc_get_backend_state` once after connecting to confirm you're attached to the right Helmor instance (version, env). Cheap, and surfaces setup problems immediately.
4. **Only call `get_setup_instructions` on failure.** Use it to diagnose plugin/version mismatches when `driver_session action=start` errors out — never prophylactically.

### Scenario → tool playbook

- **Inspect current UI state** — `webview_screenshot` (pass `maxWidth` to bound response size) for pixels, then `webview_dom_snapshot type=accessibility` for interactive semantics or `type=structure` for class/id/data-testid layout. Prefer the accessibility snapshot to locate elements, then reuse its ref IDs (e.g. `ref=e3`) in follow-up tools to avoid re-querying. Scope with `selector` when you only care about a subtree.
- **Simulate user input** — `webview_interact action=click|double-click|long-press|scroll|swipe|focus` and `webview_keyboard action=type|press|down|up`. Do **not** dispatch synthetic events via `webview_execute_js` — only `webview_interact` walks Tauri's native event path. To scroll a long conversation list into view before a screenshot, use `webview_interact action=scroll` with `scrollY`.
- **Locate elements by content** — prefer `strategy=text` (matches text content, then falls back to placeholder, aria-label, title). Fall back to CSS for structural selectors, XPath only as a last resort. Ref IDs from a previous snapshot work with any strategy.
- **Trace IPC between frontend and Rust** — `ipc_monitor action=start` → trigger the UI flow → `ipc_get_captured filter=<command>` → `ipc_monitor action=stop`. This is the primary way to verify `src/lib/api.ts` ↔ `src-tauri/src/models/*` contracts and to spot missing or duplicate invokes after a React refactor. **Always stop the monitor when done** — leaving it open pollutes later captures with stale traffic.
- **Hit a Rust command directly** — `ipc_execute_command command=... args=...`. Bypasses the frontend entirely; use to isolate backend bugs from React Query caching or rendering. Not a substitute for end-to-end reproduction through the UI.
- **Emit a test event into the app** — `ipc_emit_event eventName=... payload=...`. Exercises frontend event handlers in isolation without scripting a full user flow.
- **Wait for async sidecar / agent streaming** — `webview_wait_for type=ipc-event value=<event-name>`. The only way to await Tauri-native events like agent stream progress, `turn.completed`, or the pipeline's collapse output. DOM-only waits will miss them because streaming events land in state, not only in the DOM.
- **Read webview console logs** — `read_logs source=console lines=200 filter=<regex>`. Replaces opening DevTools. Essential when tracing `src/lib/dev-*` perf instrumentation (long-frame tracker, react-scan, render debug) or any warning from `message-layout-estimator`.
- **Read Rust + sidecar logs** — `read_logs source=system filter=helmor`. Captures Rust `eprintln!` and sidecar stdout/stderr. Pair with `HELMOR_SIDECAR_DEBUG=1` (via `pnpm run dev:analyze`) when diagnosing sidecar lifecycle (spawn, graceful SIGTERM, crash), or when verifying which SDK events the sidecar is actually forwarding.
- **Evaluate a JS expression in the webview** — `webview_execute_js script="(() => <expr>)()"`. **Must be an IIFE**; return value must be JSON-serializable; `window.__TAURI__` is available. Useful for measuring `use-stick-to-bottom` scroll offsets, reading CSS custom properties, or sampling `performance.now()` around a suspected hot path. **Not** useful for reading React state — state lives inside `App.tsx` closures and is not exposed to the JS context.
- **Inspect computed styles** — `webview_get_styles selector=... properties=[...]`. Pass `multiple=true` to check a batch. Cheaper than full DOM snapshots when triaging a CSS regression (Tailwind token collisions, oklch color drift, unexpected flex gap/overflow).
- **Ask the user to point at an element** — when a layout or pixel issue is hard to describe in words, call `webview_select_element` to pop an overlay picker, or have the user Alt+Shift+Click the element and then call `webview_get_pointed_element`. Both return rich element metadata (tag, classes, attributes, bounding rect, CSS selector, computed styles, parent chain) plus an annotated screenshot. Faster than a back-and-forth "which element do you mean".
- **Read or change window geometry** — `manage_window action=list` → `action=info` → `action=resize width=... height=...`. Use when verifying responsive layout, the sidebar collapse threshold, or the macOS traffic light region (16, 24). Logical pixels by default.

### Pitfalls

- **Release builds have no MCP bridge.** Connecting to a `pnpm run build` artifact will fail. Always `pnpm run dev`.
- **`webview_screenshot` captures only the visible viewport.** For long conversation lists or sidebar overflow, scroll the target into view with `webview_interact action=scroll` first.
- **Multi-window scenarios.** All tools default to `windowId=main`. Explicitly pass `windowId` for modals, settings dialogs, or any secondary window. Use `manage_window action=list` to discover labels.
- **`webview_execute_js` cannot see React state.** The app owns state via `useState` inside `App.tsx` closures and never exposes it to `window`. Observe state indirectly via DOM snapshots plus `ipc_monitor`, or add a temporary `window.__helmor_probe = ...` assignment if you really need introspection.
- **`ipc_monitor` is sticky.** A running monitor keeps collecting between tool calls and across scenarios. Stop it explicitly when you finish a reproduction, or `ipc_get_captured` results will be contaminated.
- **Tauri MCP does not see HTTP/WebSocket traffic from the sidecar's SDK calls.** It only captures Tauri IPC (frontend ↔ Rust). For sidecar ↔ Claude/Codex SDK traffic, rely on `read_logs source=system` with `HELMOR_SIDECAR_DEBUG=1`, or add temporary logging in `sidecar/src/`.
- **Ref IDs are per-snapshot.** A `ref=e3` returned by one `webview_dom_snapshot` call is not guaranteed to point at the same element after a re-render. Re-snapshot after any UI state change.
- **`list_devices` is for Tauri mobile (Android/iOS).** Helmor is desktop-only — ignore it.
