# Remote Server User Guide

Run Helmor's UI on your laptop and the agents (Claude Code, Codex,
Cursor) on a different machine — a workstation, a cloud VM, a
compliance-sandboxed dev host. The chat, workspace browser, terminal,
git panel, and inspector all work the same; the agent processes just
live somewhere else.

This guide covers everything an end user needs:

- [What you get](#what-you-get)
- [Prerequisites](#prerequisites)
- [Adding a remote server](#adding-a-remote-server)
- [Binding a workspace to a remote](#binding-a-workspace-to-a-remote)
- [What happens when the network drops](#what-happens-when-the-network-drops)
- [Troubleshooting](#troubleshooting)
- [Security model](#security-model)
- [Uninstalling](#uninstalling)

For implementation detail see
[`remote-server-architecture.md`](./remote-server-architecture.md).

## What you get

- **Beefy remote, light local**: 10 parallel agents on a desktop /
  VPS, edited from a battery-powered laptop without burning its CPU.
- **Cloud dev VMs**: code never leaves the sandboxed host while you
  drive it from anywhere.
- **Persistent sessions**: agents keep running on the server through
  laptop sleep, network drops, app restarts. Reconnect picks up the
  conversation mid-turn.
- **Cross-OS toolchains**: Linux-only Docker / CUDA / system pkgs
  accessible from macOS or another Linux host.
- **Multi-device continuity**: same workspace reachable from a desk
  and a laptop without filesystem sync.

## Prerequisites

On the **local** machine (where Helmor runs):

- macOS (Helmor's desktop bundle).
- An entry in `~/.ssh/config` for the remote host, or the ability to
  `ssh user@host` from the terminal without a password prompt.
  Password-only SSH won't work — use a key + ssh-agent.
- The remote host's protocol version (see below) tracks the desktop's
  version; Helmor handles install + upgrade automatically on
  connect.

On the **remote** machine:

- Linux (x86_64 or arm64) or macOS (arm64 or x86_64).
- An SSH daemon you can log in to.
- `curl` and `tar` on `$PATH`. (Default-installed on every supported
  distro.)
- ~50 MB free under `$HOME/.helmor/server/`.
- For agent workloads: the same `$HELMOR_SIDECAR_PATH` (or default
  managed location) where the `helmor-sidecar` binary will live.

Helmor does **not** capture SSH passwords or keys — auth flows
through your existing `~/.ssh/config`, `ssh-agent`, and (optionally)
agent forwarding.

## Adding a remote server

1. Open Helmor → **Settings → Remote Servers**.
2. Click **Add remote server**.
3. Fill in:
   - **Name** — a short label (e.g. `dev-stage`, `gpu-rig`). Used
     in the sidebar host chip + the workspace binding picker.
   - **SSH host** — either `user@host.example.com` or an alias from
     your `~/.ssh/config` (the field autocompletes from your config).
4. Click **Connect**. The wizard shows:
   - **Connecting…** while Helmor SSHes in, downloads + verifies the
     daemon binary (first connect only), and starts the daemon.
   - **Live** on success.
   - A retry-able error card on failure with the underlying message.

First connect typically takes 3-8 seconds (SSH handshake + binary
download). Subsequent connects to the same host reuse the installed
binary and complete in under a second.

## Binding a workspace to a remote

After registering a remote, any workspace can be bound to it:

1. Open the workspace context menu (right-click the workspace row in
   the sidebar).
2. **Move to runtime → `<your remote>`**.
3. Helmor will:
   - Mirror the workspace shape on the remote (under
     `~/helmor/<repo>/<directory>/` by default).
   - Update the binding in the local DB.
4. The sidebar row gains a small chip showing the bound runtime
   (`myproject @ dev-stage`).

Workspaces with no binding default to the built-in `local` runtime
and run on your laptop, unchanged.

## What happens when the network drops

Helmor's resilience story leans on the daemon's event journal:

1. **Heartbeat loss → Degraded chip.** The status bar shows the
   workspace is offline; agents continue running on the remote.
2. **Sustained loss → auto-reconnect kicks in.** Exponential backoff
   from 5s to 5min (with jitter).
3. **On reconnect, the chat resumes automatically.** No user action
   needed. The daemon flushes journaled events the desktop missed,
   then the live tail keeps flowing.
4. **If the daemon was restarted mid-outage**, surviving on-disk
   journals are loaded as **endedReplayOnly** sessions. The desktop
   surfaces them but the auto-attach loop skips them — you can still
   click them in the Runtime Debug panel to browse the conversation.
5. **If the journal evicted entries** the desktop hadn't persisted
   (rare — happens on extreme outage + high event volume), the chat
   shows a "History unavailable" banner and continues from the live
   tail.

A drop of <1s usually completes the reconnect inside one auto-loop
tick (5s); the user sees the chip flicker amber and that's it.

## Troubleshooting

### "Connect failed: ssh: connect to host X port 22"

Plain SSH connectivity. Test from your terminal:
```bash
ssh -o BatchMode=yes <your host> echo ok
```
If that fails: fix your `~/.ssh/config`, key file, or remote
firewall. Helmor uses the same defaults.

### "Connect failed: scp ... permission denied"

The download install path tried to fall back to scp + your local
binary, and the remote `$HOME` isn't writable. Either:

- Run the wizard again with `HELMOR_DAEMON_INSTALL_STRATEGY` unset
  (default is the download path which only writes to `~/.helmor`).
- Or pre-install via the standalone installer (see below).

### "auto-install completed but the installed binary's protocol doesn't match"

The remote download succeeded but reported a different protocol
version than the desktop expected. Usually means the release tag for
your desktop's protocol doesn't exist yet on the configured release
repo. Two fixes:

- Use the fork's release repo:
  ```bash
  HELMOR_RELEASE_REPO=david-engelmann/helmor cargo build
  ```
- Or fall back to the scp path while the release lands:
  ```bash
  HELMOR_DAEMON_INSTALL_STRATEGY=scp
  ```

### Pre-installing the daemon manually

For air-gapped hosts or provisioning automation, use the standalone
installer:

```bash
curl -fsSL https://github.com/dohooo/helmor/raw/main/scripts/install-helmor-server.sh \
  | bash -s -- --version 0.1.0
```

Or with explicit overrides:

```bash
bash install-helmor-server.sh \
  --version 0.1.0 \
  --repo dohooo/helmor \
  --target x86_64-unknown-linux-gnu \
  --install-dir "$HOME/.helmor/server"
```

The script detects platform, downloads + verifies SHA256, extracts
to the install dir, and re-runs `--version` to confirm the install
serves the expected protocol.

### "The remote stopped sending events"

The chat thread shows this when the daemon's `agent.event` stream
goes silent for more than 45s with no heartbeat. Causes:

- SSH link half-open (TCP keepalive too lax). Run reconnect from the
  banner; Helmor will resume from the journal.
- Daemon crashed. The auto-reconnect loop will respawn it after a
  protocol-version probe; the journal will replay any events emitted
  before the crash.

### Daemon logs

The daemon writes to `$HOME/.helmor/server/daemon.log` on the
remote. Tail it during troubleshooting:

```bash
ssh <host> tail -f ~/.helmor/server/daemon.log
```

## Security model

- **Auth**: all transport goes through SSH. Helmor never sees
  passwords; key handling is whatever `ssh-agent` / `~/.ssh/config`
  already set up.
- **Binary integrity**: the download install path verifies SHA256
  against the release `SHA256SUMS` manifest before installing.
  A mismatch aborts the install and surfaces an error.
- **API key storage**: provider API keys (e.g. Anthropic, OpenAI)
  pushed to the daemon are stored at
  `$HOME/.helmor/server/secrets.json` (mode 0600). A platform
  keychain integration is planned but not yet shipped.
- **Journal contents**: every agent event is mirrored to disk under
  `$HOME/.helmor/server/journals/`. This includes prompt text,
  tool outputs, and file contents the agent read. The journal is
  per-user on the remote (mode 0600 on individual files); other
  local users can't read it.
- **Retention**: journals older than 24h are swept on daemon
  startup. Override via `HELMOR_JOURNAL_RETENTION_HOURS`.

## Uninstalling

To remove the daemon from a remote:

```bash
ssh <host> "pkill -f helmor-server; rm -rf ~/.helmor/server"
```

To unbind a workspace from a remote in Helmor:

- **Settings → Remote Servers → Disconnect** removes the in-memory
  registry entry.
- The workspace's binding is preserved (so reconnecting reuses the
  same association). To clear it, right-click the workspace →
  **Move to runtime → Local**.

To remove all remote-server config from the local desktop:

```bash
rm "$HOME/Library/Application Support/helmor/remote_runtimes.json"
```

(macOS path; use the equivalent under `~/helmor-dev/` for dev builds.)
