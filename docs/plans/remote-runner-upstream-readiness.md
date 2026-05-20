# Remote Runner — Upstream Readiness Roadmap

This doc sequences the work needed to turn the fork's remote-runner
stack into a feature shippable upstream (dohooo/helmor, issue #453)
**and** comparable in maturity to Zed Remote, VS Code Remote-SSH,
JetBrains Gateway, and Cursor Background Agents.

The fork has internal phases 24n→24t already merged (events journal,
disk durability, replay-only sessions, persistence integration). This
plan starts from that state and ends with a feature that:

- Installs on a fresh remote in one command.
- Survives network drops without losing in-flight work.
- Onboards new users through a GUI wizard, not by editing JSON.
- Has been reviewed + landed upstream in reviewable slices.

## Architectural Facts (May 2026)

- Daemon binary `helmor-server` exists and is durable across restarts
  (phase 24t). Per-session JSONL journal under
  `$HOME/.helmor/server/journals/`.
- SSH transport is the only wire today. Single multiplexed channel
  per connection; reconnect = a fresh channel.
- Frontend already distinguishes `live` vs `endedReplayOnly` sessions
  (24t).
- No upstream PR opened against dohooo/helmor for any of this.

## Track A — Upstream PR slicing (gates external maturation)

Open one PR per stable contract boundary, in order. Each is its own
review cycle against `dohooo/helmor:main`.

| PR | Internal phases | Scope |
| --- | --- | --- |
| A1 (F1) | spike 17-19 | `helmor-server` binary, JSON-RPC framing, `runtime_health` only. No SSH. |
| A2 (F2) | 22a, 22b, 23a-c | SSH transport, daemon spawn over SSH, `RuntimeRegistry`, `get_remote_runtime_diagnostics`. |
| A3 (F3) | 23d, 24i, 24l, 24m, 24n, 24o | Agent attach + chat reattach + local DB persistence + UI sync. |
| A4 (F4) | 24k | Port forwarding (independent of A3/A5). |
| A5 (F5) | Track C below | Auto-reconnect + top-shell banner. |
| A6 (F6) | 24q-1, 24q-2, 24r, 24s | Daemon journal + replay-from-seq + history rebuild. |
| A7 (F7) | 24t | Journal durability across daemon restarts + replay-only sessions. |

Per-PR polish requirements (apply to every Track A PR):
- Architecture doc in `docs/` explaining the contract.
- Protocol-version bump policy + compatibility test.
- Pre-merge: maintainer design sign-off on UX scope.

## Track B — Setup UX (parity with Zed/VS Code)

Today: operator edits `~/.helmor/remote_runtimes.json` by hand. The
runtime debug panel surfaces diagnostics but isn't an onboarding
surface.

Goal: a user opening Helmor for the first time can add a remote in
under two minutes without docs.

- **B1**: "Add Remote Server" wizard — modal walkthrough: host →
  auth method → workspace path → connect. Live diagnostics during each
  step (probe SSH, probe daemon, probe sidecar).
- **B2**: `~/.ssh/config` integration — parse host aliases, port
  numbers, key files, ProxyJump. Surface them in the host picker.
- **B3**: SSH key picker — list keys under `~/.ssh/`, validate them
  with `ssh -i <key> -o BatchMode=yes <host> true` before saving.
- **B4**: SSH agent forwarding — detect `SSH_AUTH_SOCK`, prefer it
  over loaded keys. Forward to the daemon for `git push` etc.
- **B5**: Sidebar host indicator — `myproject @ vps-dev` chip next to
  workspace names. Drag-to-rebind workflow.

Effort: ~2 weeks. Gate: A2 (SSH transport) must be upstream so the
wizard's "test connection" call surface is stable.

## Track C — Resilience (production maturity)

Today: SSH drop = stream torn down, user has to refresh the page.
Major players reconnect transparently within ~5s.

- **C1**: Connection state machine — `Connected` /
  `Reconnecting{since, attempt}` / `Disconnected{reason}`. Surface in
  the title bar.
- **C2**: Exponential backoff reconnect — 250ms → 30s cap, with
  jitter. Cancel on user-initiated disconnect.
- **C3**: Heartbeat tightening — already 200ms server-side; add an
  app-level "are you there?" ping every 5s on the client so a
  half-open TCP socket gets killed within one ping cycle.
- **C4**: In-flight stream preservation — on reconnect, re-issue
  `agent.attach(request_id, since_seq=MAX(last_event_seq))` for
  every active stream. Journal replay closes the gap. Already
  architecturally enabled by 24q/24r/24t.
- **C5**: Banner UX — non-modal banner at the top of the workspace
  showing reconnect state with a "Reconnect now" override.
- **C6**: Network-change detector — listen for OS network-state
  changes (macOS: SCNetworkReachability; Linux: NetworkManager
  D-Bus). Trigger an immediate reconnect attempt instead of waiting
  for the next backoff tick.

Effort: ~1.5-2 weeks. Independent of upstream slicing (lands in F5).

## Track D — Distribution (install/upgrade story)

Today: user has to `cargo install` the daemon manually on the remote.

Goal: `curl -sSf https://helmor.app/server/install | sh -s -- linux-x64`
(or auto-install on first SSH connect, which is already partially
wired in `install.rs`).

- **D1**: CI release pipeline — GitHub Actions workflow that builds
  `helmor-server` for `linux-x64`, `linux-arm64`, `darwin-arm64`,
  `darwin-x64` and uploads them as release assets on tag push.
- **D2**: SHA256 + signature manifest — `helmor-server-<version>-<target>.tar.gz`
  + a `SHA256SUMS` file signed with the org's release key. Mirrors
  how `gh` / `glab` are bundled today (see CLAUDE.md).
- **D3**: Auto-install over SSH on first connect — already in
  `install.rs`; harden the download URL + checksum verification path
  + retry once on hash mismatch.
- **D4**: Protocol version negotiation — server's `--version` carries
  protocol N. On first connect, the client compares N against its
  expected range. Mismatch → trigger a re-install of the matching
  server binary. Today this is partially there (`PROTOCOL_VERSION`)
  but the auto-bump-on-mismatch flow doesn't exist.
- **D5**: Standalone installer script — `install.sh` published at a
  stable URL, used both by CI tests and by the wizard's "manual
  install on a host without SSH access" fallback.

Effort: ~1 week (assuming the CI infra exists for the desktop app
release; remote daemon piggybacks on the same workflow).

## Track E — Observability

Today: daemon logs to `~/.helmor/server/daemon.log`. Desktop sees only
the events that flow through `agent.event`. No structured metric
export.

- **E1**: Surface daemon log lines in the runtime debug panel —
  tail the remote log over the existing channel; ring-buffer the
  last 1000 lines. Already partially exists via `read_logs source=system`
  in the Tauri MCP bridge; production users don't have MCP.
- **E2**: Structured event metric — count per-method RPC frequency +
  p50/p99 latency. Expose via a `runtime.metrics` JSON-RPC method.
  Render in the diagnostics panel as a small table.
- **E3**: Connection diagnostics CSV export — let an operator dump a
  copy-pasteable diagnostic blob for support requests (host config,
  protocol versions, recent RPC counts, last 50 log lines).
- **E4**: Crash-loop guard — daemon emits a `crash` event on restart
  with the last 200 log lines, server-side. Desktop surfaces a
  "remote daemon crashed N times in 5 min — investigate" warning.

Effort: ~1.5 weeks.

## Track F — Multi-host UX

Today: each workspace is bound to a single runtime in
`workspaces.runtime_name`. Switching hosts means re-creating the
workspace.

- **F1**: Workspace ↔ runtime UI for rebinding — operator clicks a
  workspace, picks "Move to dev.box". Daemon-side cleanup of the
  source's in-memory state; new daemon picks up the workspace.
- **F2**: Per-host worktree path map — `workspace.remote_path`
  column. Today we sniff from the active runtime; future: explicit
  per-host paths so the same git repo can have different remote
  layouts (e.g. `/home/me/repo` on `dev.box` vs `/mnt/data/repo` on
  `gpu.box`).
- **F3**: Cross-host workspace move — `git remote add` between hosts,
  fetch, point the workspace at the new host. Mirrors Zed's "move
  workspace" flow.

Effort: ~2 weeks.

## Track G — Auth & secrets

- **G1**: Secrets vault integration — read API keys from macOS
  Keychain / Linux Secret Service / Windows Credential Manager
  instead of `~/.helmor/server/secrets.json` mode 0600.
- **G2**: Per-runtime secret scoping — today secrets are global per
  daemon. A user with two daemons (e.g. company + personal) wants
  per-daemon scoping. Migrate the secrets layout.
- **G3**: SSH agent forwarding for daemon-initiated git operations —
  daemon's `git push` goes through the forwarded agent rather than
  needing a key on the remote.

Effort: ~1 week.

## Track H — Documentation

Apply per Track A PR + a standalone user guide:

- **H1**: `docs/remote-server-architecture.md` — daemon model,
  protocol layering, journal contract. Required for upstream review.
- **H2**: `docs/remote-server-user-guide.md` — "Add Remote Server",
  troubleshooting, security model, what to put in `~/.ssh/config`.
- **H3**: `docs/remote-server-protocol.md` — JSON-RPC method
  reference, version bump policy, deprecation cadence.
- **H4**: `docs/contributing.md` — how to spin up a local two-machine
  test rig (one container is the daemon, one is the desktop).

Effort: ~3-4 days. Lands incrementally with each Track.

## Recommended Sequence

The shortest path to a feature that's *both* upstreamable *and*
mature enough to recommend to users:

1. **D (distribution) — week 1**. Without prebuilt binaries no user
   can try the feature; nothing else matters.
2. **A1 (upstream F1) — week 2**, parallel with the tail of D. Opens
   the upstream conversation early so maintainer feedback shapes the
   later slices.
3. **B (setup UX) — weeks 3-4**. Once install works, the wizard makes
   the feature reachable for non-technical users.
4. **C (resilience) — weeks 5-6**. SSH drops are the #1 production
   pain point.
5. **A2 + A3 (upstream F2, F3) — weeks 7-9**, in tandem with H docs.
6. **E (observability), G (auth) — weeks 10-11**.
7. **A4-A7 (remaining upstream PRs) — weeks 12-15**.
8. **F (multi-host UX) — weeks 16-17**.

Total: ~4 months calendar at a 1-person cadence. Compressible by
running B + C in parallel (independent surfaces), and by running A
PRs concurrently once the maintainer's design sign-off is in.

## What "parity with majors" looks like

| Capability | Zed Remote | VS Code Remote-SSH | Cursor BG Agents | Helmor (today) | Helmor (post-roadmap) |
| --- | --- | --- | --- | --- | --- |
| Daemon binary | ✓ | ✓ (`vscode-server`) | ✓ | ✓ | ✓ |
| SSH transport | ✓ | ✓ | ✓ (cloud-managed) | ✓ | ✓ |
| Auto-reconnect | ✓ | ✓ | ✓ | ✗ | ✓ (Track C) |
| First-run wizard | ✓ | ✓ | ✓ | ✗ | ✓ (Track B) |
| Prebuilt server binaries | ✓ | ✓ | n/a | ✗ | ✓ (Track D) |
| File editor | ✓ | ✓ | partial | ✓ (Monaco) | ✓ |
| Terminal | ✓ | ✓ | ✓ | ✓ | ✓ |
| Port forwarding | ✓ | ✓ | partial | ✓ (24k) | ✓ |
| Long-running agent reattach | partial | partial | ✓ | ✓ (24q-24t) | ✓ |
| Cold-attach replay | ✗ | ✗ | ✓ | ✓ (24r) | ✓ |
| Journal durability | ✗ | n/a | ✓ | ✓ (24t) | ✓ |
| Multi-host UX | ✓ | ✓ | n/a | partial | ✓ (Track F) |
| Settings sync | ✓ | ✓ | ✓ | partial | ✓ (H) |
| Web client | partial | ✓ | ✓ | ✗ | out-of-scope |

The journal + replay-only architecture (just shipped in 24t) is
*ahead* of Zed and VS Code today — neither persists an event journal
across remote restarts. Cursor's background agents are the closest
comparison and they don't expose the design.
