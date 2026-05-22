# Remote Runner Spike

Related issue: [#453](https://github.com/dohooo/helmor/issues/453)

## Goal

Design a small backend spike for remote/SSH workspaces without committing to the full remote-development product in one PR.

The full ask in #453 includes remote file operations, terminals, setup/run scripts, agents, git state, port forwarding, reconnect, and multi-device continuity. That is too large for a first contribution. A mergeable first step should isolate the local-vs-remote runtime boundary.

## Pi-Informed Principle

Pi's mental model is Brain / Hands / Session:

- harness: stateless driver;
- sandbox: disposable execution environment;
- session: durable state outside both.

For Helmor remote workspaces:

- local desktop UI is the harness operator;
- remote `helmor-server` is the execution runtime;
- local SQLite remains the user-facing session index at first, with remote runtime metadata attached.

## Proposed Spike

1. Extract a local runtime boundary.
   - Identify backend operations that assume local filesystem/process execution: git status, file tree, scripts, terminals, sidecar agent runs.
   - Define a narrow trait or command boundary for a first remote-capable operation.

2. Build a headless local prototype.
   - Add a `helmor-server` binary that speaks JSON-RPC over stdio.
   - Initially run it locally, not over SSH.
   - Implement one or two read-only methods, such as workspace file stat and git status.

3. Add an SSH transport only after the stdio protocol is stable.
   - The desktop launches `ssh host ~/.helmor/server/helmor-server`.
   - Requests stay JSON-RPC so the transport is replaceable.

4. Keep sidecar/agent execution out of the first spike.
   - Remote agents are the product goal, but file/git read operations prove the boundary with lower risk.

## Non-Goals For The First PR

- Port forwarding.
- Remote installation UX.
- Remote agent streaming.
- Remote terminal PTY.
- Multi-device sync.
- Windows remote hosts.

## Backend Touch Points

- `src-tauri/src/service.rs`
- `src-tauri/src/workspace/files/*`
- `src-tauri/src/git/*`
- `src-tauri/src/commands/*`
- potential new `src-tauri/src/remote/*`
- potential new `src-tauri/src/bin/helmor-server.rs`

## Test Plan

- Unit tests for JSON-RPC request/response encoding.
- Local loopback integration test: desktop-side client starts `helmor-server` over stdio and reads a fixture repo status.
- Failure test: remote method unavailable returns typed error, not a panic/string blob.
- Ensure local runtime remains the default path and existing command tests continue to pass.

## PR Shape

First PR should be titled as a spike or internal extraction, not "remote workspaces".

Suggested scope:

- add `remote` module;
- add stdio JSON-RPC protocol types;
- add `helmor-server` binary with one read-only method;
- add tests;
- no UI.

That gives maintainers something reviewable and creates a foundation for #453 without forcing product decisions too early.

