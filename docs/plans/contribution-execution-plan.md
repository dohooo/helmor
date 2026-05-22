# Contribution Execution Plan

This plan turns the Pi-informed roadmap into a reviewable sequence of Helmor PRs. The bias is toward complete, user-visible features that are still small enough for maintainers to review.

## PR Slicing Rules

- Each PR should close or materially advance one public issue.
- Each PR should be feature-complete for its stated scope: schema, backend behavior, typed API, invalidation, tests, and a changeset when user-visible.
- Avoid "foundation only" PRs unless they immediately simplify a following open PR or fix an existing defect.
- Keep migrations and storage-shape changes narrow, idempotent, and snapshot-tested.
- Prefer backend-first PRs that expose stable commands before adding broad UI.
- Do not introduce Pi-specific concepts by name unless the public issue asks for Pi. Translate Pi patterns into Helmor-native runtime/session/workspace behavior.

## Always-On Backend Testing Requirement

Testing is non-negotiable for this plan. A PR is not ready until the changed backend behavior has focused coverage and the relevant quality gate has been run locally.

Use this matrix when slicing PRs:

| Change area | Required coverage |
| --- | --- |
| SQLite schema or persisted shape | Migration test plus snapshot when possible |
| Message pipeline, accumulator, adapter, collapse, agent persistence | `src-tauri/tests/` snapshot coverage |
| Provider or sidecar wire format | Agent stream event wire tests and stream replay fixtures |
| Workspace lifecycle, git, scripts, terminals | Rust unit/command tests with temp repos or spawned process fixtures |
| UI sync event changes | Serialization tests for `UiMutationEvent` and frontend invalidation coverage when UI changes |
| Forge integration | Parser/normalizer tests plus provider-specific command tests |

Minimum local commands by PR type:

- Rust backend only: `cd src-tauri && cargo test <targeted filter>` and `cd src-tauri && cargo clippy --all-targets -- -D warnings`.
- Pipeline/storage changes: `cd src-tauri && cargo test --tests`.
- Sidecar provider changes: `cd sidecar && bun test`, plus the Rust wire/pipeline tests that consume the emitted events.
- Frontend-visible changes: the targeted Vitest files plus `bun run typecheck`.
- Before asking for review on a broad slice: `bun run test` when practical, or state exactly why only targeted suites were run.

## Working Cadence

1. Pick one track and open/refresh an issue comment with the proposed PR split before coding.
2. Identify the required test coverage before coding.
3. Build the first vertical slice end-to-end.
4. Run targeted tests locally before each PR.
5. Keep follow-up issues linked in the PR body so maintainers can merge the slice without needing the whole track finished.
6. After merge, rebase the next slice and remove any temporary compatibility code made obsolete by the accepted API.

## Track A: Runtime Ownership

Related plan: [Runtime Process Registry and Port Ranges](./runtime-process-registry-and-port-ranges.md)

Target issues: [#303](https://github.com/dohooo/helmor/issues/303), [#514](https://github.com/dohooo/helmor/issues/514)

### PR A1: Per-Workspace `HELMOR_PORT`

User-visible outcome: run scripts in different workspaces can bind deterministic non-overlapping port ranges.

Scope:

- Add `workspaces.port_base` and `workspaces.port_count`, or a small `workspace_runtime_allocations` table if that fits the code better.
- Allocate a stable range for every workspace that runs scripts.
- Inject `HELMOR_PORT` and `HELMOR_PORT_COUNT` in `run_script_with_shell`.
- Add schema migration coverage and focused script-env tests.
- Add a patch changeset.

Review boundary:

- No crash-recovery registry.
- No UI beyond documenting the env vars where existing script docs/settings copy already live.
- No port probing or killing by port.

Likely tests:

- `cd src-tauri && cargo test workspace::scripts`
- `cd src-tauri && cargo test schema_migrations`
- `cd src-tauri && cargo clippy --all-targets -- -D warnings`

### PR A2: Graceful Shutdown Kills Helmor-Owned Process Groups

User-visible outcome: closing Helmor normally does not leave Run-tab or embedded-terminal process groups alive.

Scope:

- Add `ScriptProcessManager::kill_all`.
- Call it from `request_quit`.
- Preserve the existing per-process kill/reap split: signal in manager, let owning script threads finish naturally.
- Add tests that `kill_all` signals all registered handles without holding the process map lock during signals.
- Add a patch changeset.

Review boundary:

- No persisted stale-process cleanup yet.
- No process killing by port.
- No terminal session restoration UI.

### PR A3: Runtime Registry For Crash Diagnostics

User-visible outcome: after a crash or force kill, Helmor can identify stale Helmor-owned runtime records and surface or clean them conservatively.

Scope:

- Persist lightweight runtime rows for processes Helmor starts.
- Mark rows ended on normal exit.
- On startup, classify stale rows as "maybe alive" using pid/pgid plus start-time checks where possible.
- Initially log or surface diagnostics; only auto-kill if ownership can be proven.

Review boundary:

- This should not block A1 or A2.
- It can wait until maintainers agree on stale-process UX.

## Track B: Branch and Source Anchors

Related plan: [Existing Branch and PR-Linked Workspaces](./existing-branch-and-pr-linked-workspaces.md)

Target issues: [#508](https://github.com/dohooo/helmor/issues/508), [#477](https://github.com/dohooo/helmor/issues/477)

### PR B1: Backend Existing-Branch Workspace Mode

User-visible outcome: Helmor can create a workspace that uses an existing branch instead of always creating a new branch.

Scope:

- Add a backend enum for workspace creation intent, with current behavior as the default.
- Implement `useExistingBranch` for local branches.
- Return clear errors for branch already checked out in another worktree and missing branches.
- Add git fixture tests.
- Add a patch changeset if the command is exposed through existing UI/CLI.

Review boundary:

- No PR URL parsing.
- No command-palette search.
- UI can be minimal or absent if the command path is ready for the next PR.

### PR B2: Remote Branch Reuse

User-visible outcome: users can start a workspace from an existing remote branch that is not yet local.

Scope:

- Fetch the selected remote.
- Resolve remote branch refs.
- Create a local tracking branch or worktree from the remote ref using Helmor's existing git helper conventions.
- Store branch provenance without corrupting target-branch semantics.

Review boundary:

- Do not add PR/MR URL behavior here.
- Keep branch reuse behavior independent from forge providers.

### PR B3: `session_links` For Issues and PRs

User-visible outcome: a session can persist a linked GitHub/GitLab issue or PR/MR as durable metadata.

Scope:

- Add `session_links` schema.
- Normalize GitHub/GitLab issue and PR/MR URLs.
- Resolve metadata through existing forge backends.
- Add typed commands to create/list session links.
- Add schema and parser tests.

Review boundary:

- No checkout behavior.
- No command-palette UI yet.
- No auto-sync of external state beyond initial metadata.

### PR B4: PR/MR-Linked Workspace Creation

User-visible outcome: starting from a PR/MR URL checks out the corresponding branch/ref and attaches the source item to the session/workspace.

Scope:

- Reuse B1/B2 branch mode.
- Fetch PR/MR refs for same-repo and fork branches.
- Populate `pr_url`, `pr_title`, `pr_sync_state`, and `session_links`.
- Add forge fixture/unit tests around ref resolution.

Review boundary:

- No full dashboard or command-palette search.
- No automatic archive-after-merge behavior.

## Track C: Durable Plan State

Related plan: [Durable Active Plan State](./durable-active-plan-state.md)

Target issue: [#410](https://github.com/dohooo/helmor/issues/410)

### PR C1: Backend Plan Projection

User-visible outcome: Helmor stores the latest active plan per session and can load it after restart.

Scope:

- Add `session_plan_state`.
- Project Codex plan/todo updates into typed plan state.
- Add `UiMutationEvent::SessionPlanChanged`.
- Add `get_session_plan_state` command.
- Keep existing chat rendering unchanged.

Review boundary:

- No pinned panel UI.
- No continue buttons.
- No provider-specific plan parsing beyond already-normalized plan/todo events.

Required tests:

- Pipeline snapshot tests for unchanged rendered output.
- Schema migration snapshot.
- UI sync serialization test.
- Plan projection unit tests.

### PR C2: Pinned Plan UI

User-visible outcome: the active plan is visible near the composer while work is running and survives session reload.

Scope:

- Query `get_session_plan_state`.
- Render a compact pinned plan component.
- Invalidate on `SessionPlanChanged`.
- Keep UI collapse state local.

Review boundary:

- No automatic sending.
- No plan editing.

### PR C3: Continue Plan Actions

User-visible outcome: when a plan has pending work, users can continue or revise without writing boilerplate prompts.

Scope:

- Add backend prompt builders for continue/revise.
- Add UI actions that insert or send those prompts through existing composer flow.
- Add tests for prompt text and button visibility.

Review boundary:

- No autonomous background continuation.

## Track D: Provider Runtime Spine

Related plan: [Provider Runtime Adapter Spine](./provider-runtime-adapter-spine.md)

Target issues/PRs: [#321](https://github.com/dohooo/helmor/issues/321), [#510](https://github.com/dohooo/helmor/issues/510), [#511](https://github.com/dohooo/helmor/pull/511)

### PR D1: Provider Capability Contract

User-visible outcome: provider-specific feature checks become data-driven and easier to review.

Scope:

- Add a provider capability shape shared by model catalog, composer, and send params.
- Move scattered provider checks behind helpers.
- Cover Claude/Codex/Cursor behavior with tests.

Review boundary:

- No new provider.
- No Copilot implementation changes unless rebasing over #511 requires it.

### PR D2: ACP Event Contract Fixtures

User-visible outcome: ACP-like provider events have stable Rust wire and pipeline tests.

Scope:

- Add agent stream event wire snapshots for ACP session start, permission request, permission deny, usage update, tool update, abort, and done.
- Add pipeline stream fixture for an ACP tool call and result if #511 lands or exposes a stable event vocabulary.

Review boundary:

- Do not expand provider behavior.
- This is a test-hardening PR that makes future provider support safer.

### PR D3: Pi Provider Spike Behind The Generic Boundary

User-visible outcome: maintainers can evaluate a Pi integration without accepting a bespoke runtime design.

Scope:

- Prototype only after D1/D2 and after the Copilot ACP path settles.
- Prefer ACP or MCP compatibility from Pi rather than a Helmor-only protocol.
- Keep provider event output inside the same normalized Helmor stream vocabulary.

Review boundary:

- No mission/validator UI.
- No Pi sandbox/broker assumptions in Helmor core.

## Track E: Dashboard Projection

Target issue: [#482](https://github.com/dohooo/helmor/issues/482)

### PR E1: Backend Dashboard Read Model

User-visible outcome: Helmor has a typed backend projection for workspace status overview.

Scope:

- Add a read-only command that groups workspace cards by status.
- Include repo, branch, session title, change counts where already available, PR/MR metadata, last activity, and active stream state.
- Reuse existing tables and queries where possible.

Review boundary:

- No dashboard UI.
- No drag/drop or status mutation.
- No new task-management state.

### PR E2: Dashboard View

User-visible outcome: users can open a dashboard and jump into workspaces by status.

Scope:

- Add the UI route/view.
- Query E1 projection.
- Add project filters.

Review boundary:

- No automatic state transitions.

## Track F: Remote Runner

Related plan: [Remote Runner Spike](./remote-runner-spike.md)

Target issue: [#453](https://github.com/dohooo/helmor/issues/453)

### PR F1: Local Headless Server Protocol

User-visible outcome: none directly; maintainers get a tested runtime boundary for future remote workspaces.

Scope:

- Add `helmor-server` binary with JSON-RPC over stdio.
- Implement one read-only method against a local fixture repo.
- Add protocol tests and local loopback integration.

Review boundary:

- No SSH.
- No remote agent execution.
- No UI.

### PR F2: SSH Transport Spike

User-visible outcome: a developer can manually connect to a remote `helmor-server` and call the read-only method.

Scope:

- Add client transport that launches `ssh host helmor-server`.
- Add explicit errors for unavailable server, auth failure, and protocol mismatch.

Review boundary:

- No auto-install.
- No terminal or sidecar forwarding.

## Recommended Order

1. A1 `HELMOR_PORT`
2. A2 graceful process cleanup
3. B1 existing local branch mode
4. B2 remote branch reuse
5. B3 session links
6. B4 PR/MR-linked workspace creation
7. C1 backend plan projection
8. C2 pinned plan UI
9. D1 provider capability contract
10. D2 ACP event contract fixtures
11. E1 dashboard read model
12. E2 dashboard view
13. F1/F2 remote runner spikes

This order keeps the early work close to accepted issue demand, then uses the resulting runtime/session metadata to make the more advanced agent features easier to justify.

## PR Body Template

```markdown
## Summary

- Complete user-visible outcome in one sentence.
- Key backend/API changes.
- Test coverage added.

## Why

Closes or advances #NNN. This PR is intentionally scoped to <boundary>; follow-ups are listed below.

## Scope Boundary

Included:
- ...

Deferred:
- ...

## Test Plan

- [ ] targeted command/test
- [ ] clippy or typecheck when relevant

## Coverage Added

- New tests:
- Snapshot updates:
- Manual checks:

## Untested Risk

- Any known gap, or "None known".

## Follow-ups

- Next PR in track: ...
```
