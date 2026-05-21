# Remote Server Architecture

This doc explains how Helmor's remote-server feature works end-to-end:
how the daemon is spawned, how the desktop talks to it, where state
lives, and how the feature recovers from network drops + daemon
restarts.

Read this alongside [`remote-server-user-guide.md`](./remote-server-user-guide.md)
(how to use it) and [`remote-server-protocol.md`](./remote-server-protocol.md)
(JSON-RPC method reference).

## 1. Why a daemon

Helmor's local-only model assumes the workspace folder, agent
processes (Claude Code, Codex, Cursor), and the desktop UI all share
one machine. Many real workflows break that assumption:

- Heavy agent fan-out on a beefy box, edited from a battery-powered
  laptop.
- Compliance / sandboxed VMs where code never leaves the host.
- Persistent agent sessions that outlive desktop sleep / restarts.
- Multi-device continuity from desk + road.

The architecture splits the app into three layers:

```
┌──────────────────────────┐         ┌───────────────────────────┐
│  Helmor Desktop          │  SSH    │  Remote host              │
│  (Tauri + React)         │ ──────▶ │  helmor-server (daemon)   │
│                          │ ◀────── │      │                    │
│  - Workspace UI          │  JSON-  │      ▼                    │
│  - Chat thread           │  RPC    │  helmor-sidecar (per-     │
│  - Local SQLite          │         │   request agent process)  │
└──────────────────────────┘         └───────────────────────────┘
```

The desktop never talks to the agent process directly; it talks to
the daemon, and the daemon owns the sidecar lifecycle.

## 2. Components

### 2.1 `helmor-server` (the daemon)

- Single binary, lives at `$HOME/.helmor/server/helmor-server` on the
  remote.
- Listens on a Unix socket at `$HOME/.helmor/server/sock`. The
  desktop's SSH transport multiplexes everything through this socket.
- Long-lived: survives desktop sleep, network drops, reconnects. One
  daemon per remote user account.
- State: in-memory **plus** an on-disk event journal (see §5).

Source: [`src-tauri/src/remote/`](../src-tauri/src/remote/) and the
binary entry point at
[`src-tauri/src/bin/helmor-server.rs`](../src-tauri/src/bin/helmor-server.rs).

### 2.2 `helmor-sidecar`

- Same binary the desktop ships locally — wraps the
  `@anthropic-ai/claude-agent-sdk` / `@openai/codex-sdk` agents.
- Spawned by the daemon on the first `agent.send`; subsequent sends
  re-use the same process.
- Standard JSON-line stdio protocol. The daemon reads each event line,
  appends it to the journal, and pushes it back across the wire as
  an `agent.event` notification.

Source: [`sidecar/`](../sidecar/).

### 2.3 Desktop side

- `RuntimeRegistry` ([`src-tauri/src/remote/registry.rs`](../src-tauri/src/remote/registry.rs))
  — process-wide map of `{ name → Arc<dyn RemoteRuntime> }`. The
  built-in `"local"` entry points at `LocalRuntime`; user-added
  remotes are `RemoteSshRuntime`.
- `RemoteSshRuntime` ([`src-tauri/src/remote/client.rs`](../src-tauri/src/remote/client.rs))
  — wraps a JSON-RPC client over the SSH-tunneled socket.
- `SidecarTransport` trait
  ([`src-tauri/src/agents/streaming/transports.rs`](../src-tauri/src/agents/streaming/transports.rs))
  — abstracts "subscribe + send + agent.attach" so the pipeline code
  is identical for local + remote workspaces.

## 3. Connection flow

```
desktop                            remote host
   │
   │  1. user clicks Connect
   │
   │─────▶ ssh + binary install ──▶  $HOME/.helmor/server/
   │       (install.rs)              helmor-server (file)
   │
   │─────▶ ssh + ensure_daemon  ──▶  fork → bind sock → write PID
   │       (daemon.rs)
   │
   │ JSON-RPC over the tunneled socket from here on:
   │
   │  2. `initialize`         ──▶
   │  ◀───  { protocolVersion, capabilities }
   │
   │  3. `runtime_health`     ──▶
   │  ◀───  { kind, hostname, version }
   │
   │ Registry entry → state=Connected, liveness loop starts pinging.
```

Subsequent `agent.send` / `agent.list` / `agent.attach` calls flow
through the same socket. The liveness loop
([`src-tauri/src/remote/liveness.rs`](../src-tauri/src/remote/liveness.rs))
fires a `ping` every 200ms and transitions the runtime state
Connected → Degraded → Disconnected on sustained failure.

## 4. Auto-install + protocol version negotiation

When the desktop connects to a host, the install path
([`src-tauri/src/remote/install.rs`](../src-tauri/src/remote/install.rs))
ensures the right `helmor-server` binary is in place:

1. Probe `<binary> --version` over SSH. The output is two lines:
   ```
   helmor-server <semver>
   protocol <semver>
   ```
2. If the probed `protocol` line matches the desktop's compile-time
   `PROTOCOL_VERSION` ([`src-tauri/src/remote/protocol.rs`](../src-tauri/src/remote/protocol.rs)),
   reuse the existing binary.
3. Otherwise install. Two strategies:
   - **`DownloadFallbackScp` (default)**: run a shell script on the
     remote that detects `uname -sm`, maps to a Rust target triple,
     downloads `helmor-server-<version>-<target>.tar.gz` from the
     GitHub release matching `PROTOCOL_VERSION`, verifies SHA256
     against the release `SHA256SUMS` manifest, extracts to
     `$HOME/.helmor/server/`. Falls back to scp if the download
     fails.
   - **`Scp`**: pin the install to scp via
     `HELMOR_DAEMON_INSTALL_STRATEGY=scp`. Used for air-gapped hosts
     and dev builds where the local binary is newer than any release.

The release source defaults to `dohooo/helmor` (GitHub). Forks publish
their own releases by setting `HELMOR_RELEASE_REPO=<org>/<repo>` at
build time.

## 5. Event journal (resilience)

The daemon keeps an event journal per agent session so the desktop
can reattach to in-flight conversations across SSH drops and daemon
restarts. Three layers:

### 5.1 In-memory ring buffer

`EventJournal` ([`src-tauri/src/remote/agent/journal.rs`](../src-tauri/src/remote/agent/journal.rs))
holds the last 1024 events per session in a `VecDeque`. Each entry:

```rust
struct JournalEntry { seq: u64, ts_ms: i64, payload: Value }
```

Sequence numbers are monotonic and never reset (for the lifetime of
the session). The reader thread appends BEFORE notifying the current
client so an `agent.attach` racing in can't observe an event the
journal doesn't have yet.

### 5.2 On-disk JSONL mirror

`JournalDiskWriter`
([`src-tauri/src/remote/agent/journal_store.rs`](../src-tauri/src/remote/agent/journal_store.rs))
mirrors every appended entry to
`$HOME/.helmor/server/journals/<request_id>.jsonl`. One `write_all`
+ newline per entry; no fsync, but a partial trailing line gets
tolerated on replay so a daemon crash mid-append at most loses the
last event.

On daemon startup:
1. **Recovery scan** — every `*.jsonl` file is parsed; surviving
   journals become `endedReplayOnly` sessions exposed via
   `agent.list`.
2. **Retention sweep** — files older than
   `HELMOR_JOURNAL_RETENTION_HOURS` (default 24) are deleted.

### 5.3 Replay via `agent.attach`

`agent.attach` accepts a `since_seq: Option<u64>`. The daemon either:
- Live session in the active map: snapshot the in-memory ring under
  the sessions lock, swap the notifier to the new client, flush
  entries with `seq > since_seq` through the new notifier.
- Ended session in the ended map: read the on-disk JSONL, filter by
  `since_seq`, flush. The new notifier sees the original terminal
  event in the replay so the client's accumulator terminates
  normally.

`replay_gap: Option<u64>` on the response signals when the caller's
`since_seq` predates the oldest surviving entry — the client can
fall back to a full local-DB reload for the gap.

## 6. Desktop-side persistence

The desktop's SQLite database is the canonical store for completed
turns. The journal is best-effort; the local DB is authoritative.

- `session_messages.last_event_seq` (introduced in 24q-2) tracks the
  daemon-issued seq per row. The reattach call queries
  `MAX(last_event_seq)` for the session to compute `since_seq`.
- Cold attach (no local rows for the session) → `since_seq = 0`,
  daemon flushes the full journal. The desktop rebuilds the
  conversation from scratch.
- Warm attach (rows present) → `since_seq = MAX(last_event_seq)`,
  daemon replays only the gap. The
  `ON CONFLICT(id) DO NOTHING` clause on
  `persist_turn_message`
  ([`src-tauri/src/agents/persistence.rs`](../src-tauri/src/agents/persistence.rs))
  absorbs any overlap.

## 7. Auto-reconnect

When the liveness loop transitions a runtime to `Disconnected`, the
auto-reconnect loop
([`src-tauri/src/remote/auto_reconnect.rs`](../src-tauri/src/remote/auto_reconnect.rs))
retries `persistence::connect_from_config` with exponential backoff
(5s → 5min). On success it swaps the live runtime in and publishes
`UiMutationEvent::RemoteReconnectAttempt { succeeded: true }`.

Frontend hooks subscribe to that event via `useRuntimeReconnectEpoch`
([`src/shell/hooks/use-runtime-reconnect-epoch.ts`](../src/shell/hooks/use-runtime-reconnect-epoch.ts))
and re-fire their discovery effects. `useWorkspaceRemoteReattach`
threads the epoch through its `useEffect` deps so the chat thread
automatically resumes from the journal on reconnect — no user
action required.

## 8. Session state lifecycle

```
                ┌──────────────┐
                │   agent.send │
                └──────┬───────┘
                       ▼
            ┌────────────────────┐
            │   active (live)    │  ←── agent.event fan-out
            │   journal: ring +  │  ←── agent.attach swaps
            │   disk             │       the notifier
            └─────────┬──────────┘
                      │ result / end / aborted / error
                      ▼
            ┌────────────────────┐
            │ endedReplayOnly    │  agent.attach reads from disk
            │ on-disk only       │  → replays the journal,
            │                    │     terminates immediately
            └─────────┬──────────┘
                      │ mtime > retention
                      ▼
                  (deleted)
```

`agent.list` returns BOTH active + ended sessions, distinguished by
the `state` field (`"live"` / `"endedReplayOnly"`). The desktop's
auto-attach hook only matches `state === "live"` so a workspace
doesn't re-replay a finished session every time it opens.

## 9. Workspace bindings + path translation

A workspace's binding (`workspace_runtime_bindings.json`) carries two
fields:

- `runtimeName` — which runtime the workspace's ops route through.
- `remotePath` (Track F2, optional) — the absolute path the daemon
  should resolve as the workspace root.

Every workspace-op command in
[`src-tauri/src/commands/remote_commands.rs`](../src-tauri/src/commands/remote_commands.rs)
routes through `resolve_runtime_for_call`, which returns a
`ResolvedRuntime` pairing the live runtime arc with the optional
remote-path override. Before invoking any trait method that takes a
`workspace_dir`, callers run `resolved.translate_workspace_dir(&local)`
— the daemon sees the override when one is set, or the local path
when not.

Three precedence rules govern the override:

1. Explicit `runtime_name` (caller passes it directly) → no
   override. The caller is bypassing the binding's context.
2. Workspace ID with a registered binding → override comes from the
   binding's `remote_path` field.
3. Fallback to the local runtime (unregistered binding,
   no-workspace-id paths) → no override; paths interpret on the
   desktop's filesystem.

Cross-host moves (Track F3) populate `remote_path` via the move
dialog. The dialog never copies files; the operator's expected to
clone/rsync the workspace to the destination before binding.

## 9b. Local-runtime key vault (Track G, cross-platform)

The desktop's local-runtime keys (the cursor key in the legacy
`app.cursor_provider` setting; future provider keys will follow the
same path) land in the OS-native vault on every supported desktop
target:

- **macOS** — `security-framework` writes a `kSecClassGenericPassword`
  item under service `com.helmor.api-keys`. Direct integration
  (not the `keyring` crate) so the migration path can match
  `errSecItemNotFound = -25300` to distinguish "no entry" from
  backend failure.
- **Linux** — `keyring` crate with the `sync-secret-service`
  feature, talking D-Bus to whatever implements
  `org.freedesktop.Secret.Service` (GNOME Keyring, KWallet,
  KeePassXC, …). Entries land in the user's default collection.
- **Windows** — `keyring` crate with the `windows-native` feature,
  writing to the Windows Credential Manager.

The "store inline in SQLite" fallback exists only for genuinely
unsupported targets (anything that isn't macOS / Linux / Windows).
Migration from older plaintext SQLite values happens transparently
on first read on every vault-capable platform.

### Manual smoke test

CI runs on macOS; the Linux + Windows backends need a real session
bus / Credential Manager to exercise. To smoke-test locally:

```bash
# Linux (under a GNOME or KDE session)
gnome-keyring-daemon --start --components=secrets
cargo run --bin helmor-cli -- cursor-set-api-key sk-test
secret-tool lookup service com.helmor.api-keys account cursor
# → sk-test

# Windows (PowerShell)
helmor-cli.exe cursor-set-api-key sk-test
cmdkey /list:helmor* 
# → Target: helmor:cursor (or similar — the format varies by Windows version)
```

The fork's release pipeline cross-builds the `helmor-server`
binary on Linux x86_64 + aarch64 via `cross`; the desktop bundle
itself remains macOS-only today but the keychain code is already
wired so a future Linux / Windows bundle inherits the vault path
without a refactor.

## 10. Per-runtime auth (Track G)

Provider API keys for remote runtimes live entirely server-side:

- The desktop's `RuntimeAuthDialog` calls
  `set_runtime_agent_auth(name, provider, key, baseUrl)` which
  dispatches to the daemon's `agent.setAuth` RPC. The key transits
  the live SSH pipe; the desktop **does not persist** the value.
- The daemon writes `$HOME/.helmor/server/secrets.json` (mode 0600,
  atomic via `.tmp` rename) and hot-pushes an `updateConfig`
  request to the sidecar so the in-flight session picks up the new
  credential without a restart.
- `agent.authStatus` is the read side (Track G2). It returns one
  `ProviderAuthStatus` per provider with a `configured: bool` +
  optional `baseUrl`. The literal API key value is **never** on
  the wire — that's enforced by a regression test that asserts the
  serialised JSON payload doesn't contain a known secret value.

The local runtime takes a different path: provider keys live in the
desktop's macOS Keychain
([`src-tauri/src/keychain.rs`](../src-tauri/src/keychain.rs)) under
service `com.helmor.api-keys`. The trait surfaces (`agent_set_auth`,
`agent_auth_status`) default-bail on the local runtime so the desktop
knows to consult the local settings inspector instead.

## 11. Connection options (Track G3)

`RuntimeConnectionConfig::Ssh` carries a `forward_agent: bool` field
that the `OpenSshTransport` translates to `-o ForwardAgent=yes`.
Defaults to `false` (skip-serialised when unset so pre-G3 payloads
stay byte-identical). Enables the remote daemon to drive `git` over
the operator's local SSH agent for private-repo push/pull.

The flag persists in the runtime registry so the auto-reconnect loop
keeps it on across restarts. The Add-Server wizard exposes the
toggle as a labeled checkbox with a security warning ("Required for
private repo access; only enable for hosts you trust").

## 12. Configuration env

Variables the daemon and desktop honor:

| Env | Side | Purpose |
| --- | --- | --- |
| `HELMOR_SIDECAR_PATH` | daemon | Absolute path to `helmor-sidecar`. Missing → daemon reports disabled. |
| `HELMOR_JOURNAL_RETENTION_HOURS` | daemon | How long ended journals live on disk. Default 24. |
| `HELMOR_DAEMON_INSTALL_STRATEGY` | desktop | `scp` forces the legacy local-binary upload. Default falls through `DownloadFallbackScp`. |
| `HELMOR_RELEASE_REPO` | desktop (build-time) | GitHub repo to pull releases from. Default `dohooo/helmor`. |
| `SSH_AUTH_SOCK` | desktop | Read by the wizard's diagnostic chip to detect agent reachability. |
| `HOME` | both | `$HOME/.helmor/server/` is the managed dir on each side. |

## 13. Things this doc deliberately doesn't cover

- **File sync**: the daemon serves the workspace files where they
  live on the remote. There is no local mirror. File operations
  (read/write/list) flow through `workspace_*` RPC methods.
- **Cross-platform secret vault**: macOS Keychain is wired today.
  Linux / Windows backends are on the roadmap — until they ship,
  the desktop's local-runtime keys fall back to SQLite plaintext on
  those platforms.
- **Helmor-driven file transfer**: F3's clone-from-binding workflow
  (run `git bundle` / `git clone` on the destination) is on the
  roadmap; today the operator copies files into the remote path
  themselves before binding.
- **Web client**: out of scope. The Tauri desktop app is the only
  client.

## See also

- [`remote-server-user-guide.md`](./remote-server-user-guide.md) —
  end-user onboarding + troubleshooting.
- [`remote-server-protocol.md`](./remote-server-protocol.md) —
  JSON-RPC method catalog.
- [`plans/remote-runner-completion-plan.md`](./plans/remote-runner-completion-plan.md)
  — phase-by-phase history of how the feature was built.
- [`plans/remote-runner-upstream-readiness.md`](./plans/remote-runner-upstream-readiness.md)
  — what's left between fork-quality and upstream-shippable.
