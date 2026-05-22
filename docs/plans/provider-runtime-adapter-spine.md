# Provider Runtime Adapter Spine

Related issues/PRs: [#321](https://github.com/dohooo/helmor/issues/321), [#510](https://github.com/dohooo/helmor/issues/510), [#511](https://github.com/dohooo/helmor/pull/511)

## Goal

Create a cleaner provider/runtime boundary so Helmor can support ACP-style providers, and eventually Pi-style agents, without duplicating provider-specific behavior across the sidecar, Rust send params, and frontend capability checks.

This should support the active Copilot ACP work rather than competing with it.

## Pi-Informed Principle

Pi normalizes tool calls, run events, graph stages, and sandbox execution behind typed traits. Individual agents can be different, but their runtime evidence lands in a common shape.

Helmor's equivalent is the sidecar event vocabulary plus Rust pipeline normalization. The more providers Helmor supports, the more it needs an explicit provider capability contract.

## Current Helmor Signals

- Helmor already supports Claude, Codex, and Cursor.
- Draft PR #511 adds Copilot via ACP and touches sidecar provider code, model listing, permission modes, context usage, icons, settings, and Rust bundled binary resolution.
- Issue #321 asks for Pi-mono agent support, but a direct Pi-specific adapter would be too large until the generic provider spine is stable.

## Proposed Contribution

Start with provider infrastructure and tests:

1. Add a provider capability model.
   - `supportsPlanMode`
   - `supportsAutopilot`
   - `supportsContextUsage`
   - `supportsSteer`
   - `supportsSlashCommands`
   - `permissionModes`

2. Keep provider capabilities close to model/provider catalog generation.
   - Avoid scattering checks like `provider === "cursor"` or `provider === "copilot"` throughout unrelated UI/backend code.

3. Add sidecar event contract tests.
   - For ACP providers, snapshot event sequences such as session start, permission request, deny, tool update, usage update, abort, and completion.
   - Rust pipeline tests should assert that ACP-like provider events produce stable `ThreadMessageLike` output.

4. Help de-risk #511 specifically.
   - Permission deny handling.
   - Model-list failure fallback.
   - Shutdown of per-session ACP child processes.
   - Context-usage persistence.
   - Bundled binary path resolution.

## Pi Agent Path

Do not open with "support Pi agent" as a full provider PR. Instead:

1. Define the generic provider/runtime contract.
2. Let Pi expose an ACP or MCP-compatible runtime surface.
3. Add Pi as another provider once it can emit Helmor-normalized events.

That makes Pi support look like a normal Helmor provider, not a bespoke integration that maintainers have to understand deeply.

## Backend Touch Points

- `sidecar/src/session-manager.ts`
- provider-specific sidecar managers
- `sidecar/src/emitter.ts`
- `src-tauri/src/agents/streaming/params.rs`
- `src-tauri/src/agents/catalog.rs`
- `src-tauri/src/pipeline/accumulator/*`
- `src-tauri/tests/agent_stream_event_wire.rs`
- `src-tauri/tests/pipeline_streams.rs`

## Test Plan

- Sidecar unit tests for provider capability selection.
- Sidecar tests for ACP permission allow/deny/cancel mapping.
- Rust wire snapshot for new provider events.
- Pipeline stream fixture for ACP tool call plus result.
- Shutdown test for provider child process cleanup.

## PR Shape

Best first PR: provider capability extraction and tests that are useful to #511 without rewriting it.

Second PR: ACP event fixture/snapshot coverage.

Pi-specific provider work should wait until those land.

