# Contributing to the Remote Server

Practical guide for working on Helmor's remote-runner stack: how to
spin up a two-machine test rig locally, where the seams are, how to
add a new RPC method, and how to keep the tests honest.

For the why + lifecycle see
[`remote-server-architecture.md`](./remote-server-architecture.md).
For the wire shape see
[`remote-server-protocol.md`](./remote-server-protocol.md).

## Local test rig

The remote-runner stack runs end-to-end on a single host. Pick the
path that matches what you're working on; none of them require
Docker, a remote VM, or any external service.

### Option A: local-binary transport (no SSH)

Skips the SSH layer entirely. Use this for everything that isn't
the SSH transport itself — agent attach, journal/replay, the
chat/editor surfaces, the RPC method catalog. ~1 second to start
a new daemon process.

```bash
cd src-tauri
cargo build --release --bin helmor-server
HELMOR_SERVER_PATH="$(pwd)/target/release/helmor-server" bun run dev
```

In the app, **Settings → Remote Servers → Add remote server** →
host: `local` → connect. The desktop spawns the binary directly
over a stdin/stdout transport and skips the SSH machinery.

### Option B: SSH to your own host

Exercises the real `ssh <host> helmor-server` path against your
host's own sshd. Use this when you're working on the SSH
transport, install path, or anything that depends on the wire
protocol going through a real OpenSSH session.

1. **Enable host SSH.**
   - macOS: System Settings → General → Sharing → enable "Remote
     Login". Add your own user to the allowed list.
   - Linux: install `openssh-server`, `sudo systemctl enable
     --now ssh`.
2. **Authorise your own key.**
   ```bash
   cat ~/.ssh/id_ed25519.pub >> ~/.ssh/authorized_keys
   chmod 600 ~/.ssh/authorized_keys
   ssh "$USER@localhost" echo ok   # smoke-test
   ```
3. **Point Helmor at `localhost`** — wizard or settings. The
   desktop's auto-install path runs against the same machine but
   uses the real SSH plumbing.
4. **Speed up the dev loop** by forcing the scp install path so
   the desktop's freshly-built local binary lands on the remote
   without needing a tagged release:
   ```bash
   HELMOR_DAEMON_INSTALL_STRATEGY=scp bun run dev
   ```

Tail the daemon log on a successful install:
```bash
tail -f "$HOME/.helmor/server/daemon.log"
```

### Option C: Docker (optional, for isolation)

If you specifically want to test against a different OS / arch /
filesystem layout than your host, you can run `helmor-server`
inside a Docker container with sshd exposed on `localhost:2222`.
This is **not required** — Options A and B cover the same code
paths against your host kernel + filesystem, with no Docker
dependency.

The container approach is most useful when:
- You're testing the download install path (D3) against a clean
  Linux user account without manually wiping `~/.helmor/`.
- You need to verify the `linux-x64` or `linux-arm64` release
  artefacts on a macOS desktop.
- You're reproducing a layout-specific bug (paths, `$HOME`
  resolution, etc.) reported by a user on a different platform.

Any standard `linuxserver/openssh-server`-style image works —
follow that image's docs for key setup, then add the runtime via
the wizard with host `user@localhost:2222`. Nothing in this
repo depends on a specific container image or compose file.

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
3. Cut a release (see below).
4. The desktop's `ensure_remote_helmor_server` will trigger a
   re-install on first connect to any host running the older
   protocol.

## Cutting a `helmor-server` release

`helmor-server` is released independently from the desktop app —
its release cadence follows protocol version bumps + RPC method
additions, both of which move faster than desktop releases.

### Tagging convention

- Tag format: `helmor-server-v<protocol-version>`, e.g.
  `helmor-server-v0.1.0`.
- The protocol version in the tag must match `PROTOCOL_VERSION` in
  [`src-tauri/src/remote/protocol.rs`](../src-tauri/src/remote/protocol.rs).
  The auto-install path on the desktop reads `PROTOCOL_VERSION` and
  composes `https://github.com/<repo>/releases/download/helmor-server-v<version>/...`
  — a mismatch here breaks first-connect installs everywhere.

### Dry-run via `workflow_dispatch` (no release minted)

The `publish-helmor-server.yml` workflow accepts a manual trigger
that builds the full 4-target matrix without creating a GitHub
release. Use this to verify the build + smoke-test before tagging:

1. Open the **Actions** tab → **Publish helmor-server** → **Run
   workflow**.
2. Pick the branch (usually `main`).
3. Set **Version** to a throwaway label (e.g. `0.1.0-dryrun`). The
   artifacts get the label baked into the filename so you can
   download + inspect them; nothing gets attached to a GitHub
   release.
4. Verify: the four legs complete, the smoke-test step prints
   `helmor-server <semver>` + `protocol <semver>`, the artifact
   tarballs land under the workflow run.

### Tagged release

Once the dry-run passes:

```bash
# From a clean checkout of `main` at the commit you want released.
git tag -a helmor-server-v0.1.0 -m "helmor-server v0.1.0 — protocol 0.1.0"
git push origin helmor-server-v0.1.0
```

The workflow's `aggregate` job runs only on tag pushes, not
`workflow_dispatch`. It:

1. Collects the four per-target tarballs.
2. Validates the count (exactly 4 — a missing leg means a silent
   build failure earlier in the matrix; the job fails loudly).
3. Concatenates the per-tarball SHA256 lines into a consolidated
   `SHA256SUMS`.
4. Creates the GitHub release with the four tarballs +
   `SHA256SUMS` attached.

### Post-release verification

Before declaring the release done, verify:

1. The release page on GitHub lists **5 files**: 4 tarballs +
   `SHA256SUMS`.
2. Each tarball name matches the
   `helmor-server-<version>-<target>.tar.gz` pattern the desktop's
   `install.rs::install_via_download` expects.
3. The `SHA256SUMS` content is exactly 4 lines of
   `<hash>  helmor-server-<version>-<target>.tar.gz`.
4. **End-to-end install check**: from a desktop pointed at the
   release repo (override via `HELMOR_RELEASE_REPO=<org>/<repo>`
   at compile time if testing on a fork), connect to a fresh
   remote that doesn't have `helmor-server` installed yet, watch
   the auto-install path download + verify + install the new
   binary. The desktop log line to grep for is
   `remote-runner: download install completed`.

### Failure recovery

- **One build leg failed mid-matrix.** The aggregate job won't
  run (it gates on `needs: build`). Fix the failing leg, re-push
  the tag (delete + recreate locally + force-push) — the workflow
  re-runs.
- **Tag points at the wrong commit.** Delete the tag both locally
  and on the remote (`git push --delete origin
  helmor-server-vX.Y.Z`), recreate, push. The release also needs
  to be deleted from the GitHub UI — the action won't overwrite
  by default.
- **SHA256SUMS missing or wrong shape.** The desktop's install
  path bails with `HELMOR_INSTALL_CHECKSUM_MISMATCH` after the
  hash-mismatch retry burns. Symptom: every first-connect install
  falls back to the scp path (which only works for hosts whose
  arch matches the desktop's local binary). Cut a `.1` patch
  release.

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
