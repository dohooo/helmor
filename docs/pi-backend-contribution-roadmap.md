# Pi-Informed Helmor Backend Contribution Roadmap

Scan date: May 12, 2026.

This document compares the local Pi project against Helmor's current backend and the public Helmor issue/PR tracker, then ranks backend-focused contribution projects by likely mergeability.

GitHub Discussions note: `dohooo/helmor` currently has Discussions disabled, so the public signal here comes from Issues and Pull Requests rather than Discussions.

## What Pi Has That Helmor Does Not

Pi is a headless Rust platform for long-running, multi-agent work. Its strongest backend ideas are:

- Durable run state: append-only `runlog.events` plus resumable `runlog.session_state` with optimistic concurrency.
- Runtime ownership: supervisors, sandboxes, egress, broker policy, resource claims, and cleanup are explicit backend concepts.
- Agent topologies: single-pass agents, solver/verifier/refiner loops, declarative graphs, and queen/worker hive orchestration.
- Validation contracts: missions define assertions before work begins, then workers and validators produce auditable evidence.
- Protocol normalization: tool calls, MCP, OpenAI-style tools, and Pi events converge into a canonical tool-call shape.

Helmor is stronger as a local desktop workbench:

- It already has workspace/session/message persistence in SQLite.
- It has a polished sidecar streaming path for Claude, Codex, Cursor, and a WIP Copilot ACP PR.
- It has strong pipeline snapshot tests for provider event drift.
- It has a real Tauri command/service split, GitHub/GitLab integration, worktree lifecycle, terminal/script execution, and UI sync events.

The best contribution strategy is not to port Pi wholesale. The mergeable path is to introduce small durable runtime primitives that improve Helmor's existing workflows.

## Backend Test Posture

Helmor already has meaningful backend quality coverage, and every contribution in this roadmap should strengthen it rather than work around it.

Existing backend coverage includes:

- Rust unit tests colocated in backend modules such as git ops/watchers, workspace scripts, commands, rate limits, updater, UI sync, image storage, and system limits.
- Rust integration tests under `src-tauri/tests/`.
- Insta snapshot suites for the message pipeline:
  - `pipeline_scenarios.rs` for handcrafted edge cases.
  - `pipeline_fixtures.rs` for real DB session fixtures.
  - `pipeline_streams.rs` for raw provider stream replay.
- Wire and bridge tests for agent stream events, elicitation, send params, stable part IDs, and schema migrations.
- `cargo clippy --all-targets -- -D warnings` enforced through `bun run lint`.

Testing is a hard requirement for this contribution plan:

- Every backend PR needs targeted Rust tests for the changed behavior.
- Every schema migration needs migration coverage, preferably with an insta snapshot when the existing pattern supports it.
- Every pipeline, agent persistence, or storage-shape change needs snapshot coverage in `src-tauri/tests/`.
- Every provider/protocol change needs wire-format or stream replay coverage before it is considered ready.
- Every PR body should state which tests were run and what risk remains untested.

## Pi Subproject Mapping

| Pi subproject | Useful pattern | Helmor contribution shape |
| --- | --- | --- |
| `pi-core` | Durable run/session state, brokered runtime ownership, normalized tool calls | Process cleanup, port allocation, active plan state, provider event contract tests |
| `pi-qa-agent` | Solver/verifier/refiner loop with explicit artifacts and evidence | Future review/validation workflows, starting with durable source links and inline review metadata |
| `pi-flow-agent` | Declarative graph orchestration for known workflows | Later backend model for multi-step plans; not a first PR |
| `pi-review-agent` | Focused review agent with structured output | Session links, PR-linked workspaces, and review-comment prompts fit this shape |
| `pi-explainer-agent` | Small single-pass reference agent | A good bar for new Helmor provider/runtime integrations: simple providers should stay simple |

## Public Tracker Signals

High-signal open issues and PRs:

- [#303](https://github.com/dohooo/helmor/issues/303): per-workspace `HELMOR_PORT`; maintainer said "feel free to open a PR".
- [#514](https://github.com/dohooo/helmor/issues/514): clean up embedded terminal/run-script process groups on app shutdown.
- [#508](https://github.com/dohooo/helmor/issues/508): create workspace from existing branch; maintainer explicitly wants "from a branch" and "use a branch".
- [#477](https://github.com/dohooo/helmor/issues/477): GitHub issue/PR attachments for sessions and PR-linked workspace checkout.
- [#410](https://github.com/dohooo/helmor/issues/410): pin active agent plans for long-running work.
- [#321](https://github.com/dohooo/helmor/issues/321): support Pi-mono agent.
- [#510](https://github.com/dohooo/helmor/issues/510) and draft [#511](https://github.com/dohooo/helmor/pull/511): GitHub Copilot via ACP.
- [#453](https://github.com/dohooo/helmor/issues/453): remote server / SSH workspaces.
- [#482](https://github.com/dohooo/helmor/issues/482): dashboard view for workspace status overview.
- [#512](https://github.com/dohooo/helmor/issues/512): recent macOS energy-consumption regression.

## Ranked Contribution Projects

| Rank | Project | Why It Is Likely To Merge | Pi Insight | Main Backend Surface |
| --- | --- | --- | --- | --- |
| 1 | Runtime process cleanup plus per-workspace port allocation | #303 has explicit maintainer encouragement, #514 is recent and concrete, and the changes are narrow backend fixes | Runtime resources should be owned and cleaned up by the harness, not frontend memory | `src-tauri/src/workspace/scripts.rs`, `schema.rs`, `models/workspaces.rs`, quit path |
| 2 | Existing-branch and PR-linked workspace starts | #508 has maintainer interest, #477 asks for the adjacent session-link model, both fit Helmor's worktree identity | Missions/runs need durable external anchors and restartable work directories | workspace lifecycle, git ops, forge metadata, session link table |
| 3 | Durable active plan state | #410 is exactly the long-running task supervision gap; Helmor already parses Codex plan/todo events | Pi treats plans/contracts as state, not scrollback text | pipeline accumulator/adapter, sessions schema, UI sync |
| 4 | Provider runtime adapter spine for ACP/Pi-style agents | #510/#511 show active maintainer/user interest, but the safest contribution is infrastructure and tests around the WIP | Normalize provider events and capabilities before adding agent-specific orchestration | sidecar provider managers, Rust send params, pipeline snapshots |
| 5 | Workspace dashboard backend projection | #482 is user-visible but can start as a backend read model over existing tables | Pi dashboards are projections over run/session state, not a separate task system | workspace/session aggregate query, command API, UI sync |
| 6 | Remote runner spike | #453 has strong product pull, but the full feature is too large for a first PR | Pi's harness/sandbox/session split maps cleanly to local UI plus remote runtime | service boundary, headless binary, SSH/stdio JSON-RPC |
| 7 | Runtime/energy observability | #512 is urgent but underspecified; a diagnostic PR is safer than speculative tuning | Long-running agent systems need cheap heartbeat and resource telemetry | stream/process registries, logging, perf counters |
| 8 | Full Pi agent support | #321 exists, but a direct Pi-specific adapter is risky until Helmor's provider/runtime boundary is cleaner | Pi can become one provider/runtime after ACP/MCP abstractions settle | sidecar protocol, provider catalog, permissions, snapshots |

## Recommended Sequence

Start with Rank 1. It solves two public issues, is mostly Rust/backend, and establishes the "durable runtime ownership" pattern needed for larger work.

Then do Rank 2. Branch reuse and PR-linked sessions make Helmor better for real OSS contribution work and create the metadata spine for dashboards, validation, and long-running task history.

Rank 3 is the first "advanced agent" feature worth building after that. It should store plan state as a backend object and emit `UiMutationEvent` invalidations, not rely on scanning chat messages in React.

For Pi support, avoid opening a large "support Pi" PR. Instead, help harden the ACP/provider spine around #511, then make Pi present itself through that boundary later.

For the concrete PR-by-PR execution sequence, see [Contribution Execution Plan](./plans/contribution-execution-plan.md).

## Created Project Plans

- [Contribution Execution Plan](./plans/contribution-execution-plan.md)
- [Runtime Process Registry and Port Ranges](./plans/runtime-process-registry-and-port-ranges.md)
- [Existing Branch and PR-Linked Workspaces](./plans/existing-branch-and-pr-linked-workspaces.md)
- [Durable Active Plan State](./plans/durable-active-plan-state.md)
- [Provider Runtime Adapter Spine](./plans/provider-runtime-adapter-spine.md)
- [Remote Runner Spike](./plans/remote-runner-spike.md)
