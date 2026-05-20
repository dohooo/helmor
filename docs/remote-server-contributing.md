# Contributing to the Remote Server

Practical guide for working on Helmor's remote-runner stack: how to
spin up a two-machine test rig locally, where the seams are, how to
add a new RPC method, and how to keep the tests honest.

For the why + lifecycle see
[`remote-server-architecture.md`](./remote-server-architecture.md).
For the wire shape see
[`remote-server-protocol.md`](./remote-server-protocol.md).

## Two-machine test rig (Docker)

The fastest way to exercise the real SSH path without renting a VM:
run the daemon inside a Linux container, point the desktop at it over
`localhost:2222`.

### 1. Build a Linux helmor-server

From the repo root:

```bash
cd src-tauri
cargo build --release --bin helmor-server --target x86_64-unknown-linux-gnu
```

(If you're on macOS arm64, add `cross` first: `cargo install cross`,
then `cross build --release --bin helmor-server --target x86_64-unknown-linux-gnu`.)

### 2. Spin up an SSH container

```bash
docker run -d --name helmor-test \
  -p 2222:22 \
  -v "$(pwd)/src-tauri/target/x86_64-unknown-linux-gnu/release/helmor-server:/usr/local/bin/helmor-server:ro" \
  -e USER_NAME=helmor \
  -e USER_PASSWORD=helmor \
  linuxserver/openssh-server
```

Add your key to the container:
```bash
docker exec -i helmor-test sh -c 'mkdir -p /config/.ssh && cat >> /config/.ssh/authorized_keys' < ~/.ssh/id_ed25519.pub
docker exec helmor-test chown -R helmor:helmor /config/.ssh
```

Sanity-check SSH:
```bash
ssh -p 2222 helmor@localhost echo ok
```

### 3. Point Helmor at it

In Helmor → **Settings → Remote Servers → Add remote server**:

- Name: `docker-test`
- SSH host: `helmor@localhost:2222`

Or skip the wizard for a faster dev loop:

```bash
# From repo root, with HELMOR_DAEMON_INSTALL_STRATEGY=scp so the
# desktop's local binary uploads instead of trying a release URL
# that doesn't exist yet.
HELMOR_DAEMON_INSTALL_STRATEGY=scp \
  bun run dev
```

### 4. Tail the daemon log

```bash
docker exec -it helmor-test tail -f /config/.helmor/server/daemon.log
```

## Where the seams are

The remote-runner stack is split into deliberately small layers so
each can be tested in isolation:

```
┌───────────────────────────────────────────────────────────┐
│ Desktop (Rust + React)                                    │
│                                                           │
│  commands/remote_commands.rs   ←─ Tauri IPC handlers      │
│        │                                                  │
│        ▼                                                  │
│  remote::client (RemoteSshRuntime)                        │
│        │                                                  │
│        ▼  JSON-RPC over SSH-tunneled socket               │
└────────│──────────────────────────────────────────────────┘
         │
┌────────▼──────────────────────────────────────────────────┐
│ Daemon (helmor-server binary)                             │
│                                                           │
│  remote::server (dispatcher) → handlers per method        │
│        │                                                  │
│        ▼                                                  │
│  remote::agent::RemoteAgentState                          │
│   - sessions map (live)                                   │
│   - ended_sessions map (replay-only)                      │
│   - journal (in-memory + on-disk JSONL)                   │
│        │                                                  │
│        ▼                                                  │
│  spawned sidecar (helmor-sidecar binary)                  │
└───────────────────────────────────────────────────────────┘
```

Each layer has a test seam:
- **Desktop commands**: `RecordingRunner` / `InspectorStubRuntime`
  in [`src-tauri/src/commands/remote_commands.rs`](../src-tauri/src/commands/remote_commands.rs).
- **`RemoteAgentState`**: `MockAgentSpawner` in
  [`src-tauri/src/remote/agent/mock.rs`](../src-tauri/src/remote/agent/mock.rs).
- **`SidecarTransport`**: `ManualTransport` in
  [`src-tauri/src/agents/streaming/reattach.rs`](../src-tauri/src/agents/streaming/reattach.rs)
  (test mod).
- **`EventJournal`**: in-memory unit tests in
  [`src-tauri/src/remote/agent/journal.rs`](../src-tauri/src/remote/agent/journal.rs).
- **`JournalDiskWriter`** + recovery: in
  [`src-tauri/src/remote/agent/journal_store.rs`](../src-tauri/src/remote/agent/journal_store.rs).

Prefer these stubs over real SSH / real binaries in tests — they're
deterministic and fast.

## Adding a new RPC method

1. **Define the wire types** in
   [`src-tauri/src/remote/methods.rs`](../src-tauri/src/remote/methods.rs):
   - `<Foo>Params` struct
   - `<Foo>Result` struct
   - `<Foo>Method` zero-sized type implementing `RpcMethod`
   - Pick a name like `"workspace.foo"` or `"agent.foo"` — namespacing
     matters for grep-ability.

2. **Add a handler** in
   [`src-tauri/src/remote/server/handlers.rs`](../src-tauri/src/remote/server/handlers.rs):
   ```rust
   pub(super) fn handle_workspace_foo(
       state: &Arc<RemoteAgentState>,
       params: WorkspaceFooParams,
   ) -> Result<WorkspaceFooResult> { ... }
   ```
   Register it in the dispatcher's match arm.

3. **Expose on the `RemoteRuntime` trait** if the desktop layer needs
   to call it directly (most do):
   ```rust
   trait RemoteRuntime {
       fn workspace_foo(&self, params: WorkspaceFooParams)
           -> Result<WorkspaceFooResult>;
   }
   ```
   `LocalRuntime` implements it via the in-process equivalent;
   `RemoteSshRuntime` delegates through `RpcClient::call`.

4. **Add a Tauri command** under
   [`src-tauri/src/commands/remote_commands.rs`](../src-tauri/src/commands/remote_commands.rs)
   if the frontend calls it. Wire it in `lib.rs::invoke_handler!`.

5. **Mirror on the frontend** in
   [`src/lib/api.ts`](../src/lib/api.ts):
   - Type aliases for the `Params` + `Result` shapes.
   - A wrapper function calling `invoke("name", params)`.

6. **Wire snapshot test** in `methods.rs::tests` — serialize a
   representative value and assert on the JSON. Catches accidental
   field renames + serde drift across versions.

## Adding a new event type

Events flow back as `agent.event` notifications. The shape is
opaque to the daemon — it just appends whatever the sidecar emits
to the journal and forwards it.

To add a new event type:
1. Emit it from the sidecar
   ([`sidecar/src/`](../sidecar/)).
2. Add an accumulator / adapter handler in
   [`src-tauri/src/pipeline/`](../src-tauri/src/pipeline/) so the
   chat thread renders it.
3. Snapshot test in `src-tauri/tests/pipeline_*` so regressions get
   caught.

The daemon doesn't need any change — the journal stores opaque JSON.

## Protocol version bumps

A bump is one of three things:

| Change | Bump |
| --- | --- |
| New method added. | Minor. No bump needed (forward-compat). |
| Existing method's params / result extended with optional fields. | Minor; bump if you want to advertise it. |
| Required field added or renamed; method removed. | Major; bump + write a migration. |

Workflow:
1. Edit `PROTOCOL_VERSION` in
   [`src-tauri/src/remote/protocol.rs`](../src-tauri/src/remote/protocol.rs).
2. Update [`docs/remote-server-protocol.md`](./remote-server-protocol.md)
   with the change.
3. Cut a release: tag `helmor-server-v<new-version>` →
   `publish-helmor-server.yml` builds + uploads.
4. The desktop's `ensure_remote_helmor_server` will trigger a
   re-install on first connect to any host running the older
   protocol.

## Test invocations

```bash
# Frontend
bun run test:frontend

# Sidecar
bun run test:sidecar

# Backend (Rust)
cd src-tauri && cargo test --lib                  # unit tests
cd src-tauri && cargo test --tests                # integration tests
cd src-tauri && INSTA_UPDATE=always cargo test    # accept new snapshots
cd src-tauri && cargo clippy --all-targets -- -D warnings

# Full
bun run test
```

When working on the remote-runner stack, run:

```bash
cd src-tauri && cargo test --lib remote::
```

To exercise just the remote module — faster than the full lib suite
+ tighter feedback loop.

## Commit / PR convention

- One PR per phase / capability slice. The fork's history follows the
  pattern `remote-runner phase 24X: <summary>` — keep that going so
  the next contributor can grep for the phase boundary.
- Stack PRs that depend on each other (base another PR's head branch
  rather than `main`). GitHub auto-rebases when the parent merges.
- Every PR that touches `src-tauri/src/remote/` or `agents/` must
  add or update tests at the right seam (see "Where the seams are"
  above). The CI runs the full matrix; broken tests will hold the PR.

## See also

- [`remote-server-architecture.md`](./remote-server-architecture.md)
- [`remote-server-protocol.md`](./remote-server-protocol.md)
- [`remote-server-user-guide.md`](./remote-server-user-guide.md)
- [`plans/remote-runner-completion-plan.md`](./plans/remote-runner-completion-plan.md)
- [`plans/remote-runner-upstream-readiness.md`](./plans/remote-runner-upstream-readiness.md)
