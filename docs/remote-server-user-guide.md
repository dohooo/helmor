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
- A downloader on `$PATH` — either `curl` or `wget`. Helmor's
  install script tries both before failing.
- A SHA-256 hasher on `$PATH` — either `sha256sum` (default on
  every Linux distro via GNU coreutils) or `shasum` (default on
  macOS). Again, either works.
- `tar` on `$PATH` (universal).
- ~50 MB free under `$HOME/.helmor/server/`.
- For agent workloads: the same `$HELMOR_SIDECAR_PATH` (or default
  managed location) where the `helmor-sidecar` binary will live.
- **(Linux only) GTK/webkit runtime libraries.** The
  `helmor-server` daemon currently links the GUI toolkit
  transitively, so its dynamic loader needs these present at
  startup — even though the daemon never opens a window (it runs
  fully headless; no `DISPLAY` required). On Debian/Ubuntu:
  ```bash
  sudo apt-get install -y \
    libwebkit2gtk-4.1-0 libgtk-3-0 libayatana-appindicator3-1 \
    librsvg2-2 libsoup-3.0-0
  ```
  (Fedora/RHEL: the `webkit2gtk4.1`, `gtk3`, `libsoup3`,
  `librsvg2` packages. Alpine: `webkit2gtk-4.1`, `gtk+3.0`.)
  If they're missing, the daemon fails to start with a loader
  error like `error while loading shared libraries:
  libwebkit2gtk-4.1.so.0: cannot open shared object file` — and
  the desktop surfaces that verbatim on connect. macOS remotes
  need nothing extra (WebKit is a system framework).

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
     If the alias is a `Host` block in your config, the wizard
     shows the effective `HostName`, `User`, `IdentityFile`(s), and
     `ProxyJump` chain below the input — a sanity check before you
     click Connect.
   - **Forward SSH agent** (optional checkbox) — adds
     `-o ForwardAgent=yes` to the SSH invocation so the remote
     daemon can run `git push` / `git fetch` against private repos
     using your local SSH keys. Off by default since agent
     forwarding lets the remote root drive your local agent — only
     enable for remotes you trust.
4. The **SSH diagnostics** strip under the form surfaces:
   - **SSH agent chip** — green if `SSH_AUTH_SOCK` answers
     `ssh-add -l`, amber if not configured (launch from a shell that
     exports it), red if the socket points at a dead agent.
   - **Identity keys** — file stems of `~/.ssh/*.pub` whose private
     counterpart also exists, truncated to four with a `+N more`
     overflow.
5. Click **Connect**. The wizard shows:
   - **Connecting…** while Helmor SSHes in, downloads + verifies the
     daemon binary (first connect only), and starts the daemon.
   - **Live** on success.
   - A retry-able error card on failure with the underlying message.

First connect typically takes 3-8 seconds (SSH handshake + binary
download). Subsequent connects to the same host reuse the installed
binary and complete in under a second.

### Configuring provider API keys

After a remote is connected:

1. **Settings → Remote Servers → your remote → Auth**.
2. The dialog shows whether a key is already configured (green chip
   "Currently configured" with the optional base URL, or a muted
   "No key configured yet" hint).
3. Paste an API key + optional base URL → **Save**. Leave the field
   blank and click **Clear** to remove a stored key.

The key transits the live SSH pipe and is written to
`$HOME/.helmor/server/secrets.json` (mode 0600) on the remote.
**The desktop does not persist the key value.** Each runtime keeps
its own secrets store, so multi-account setups
("dev-stage uses my personal key, prod uses the team key") work
without conflict.

A small `KeyRound` chip on each remote-server row shows which
providers have a key registered — at-a-glance confirmation without
opening the dialog.

## Binding a workspace to a remote

After registering a remote, any workspace can be bound to it:

1. Open the workspace context menu (right-click the workspace row in
   the sidebar).
2. **Move to runtime → `<your remote>`**.
3. A small **Move workspace** dialog appears with three controls:
   - **Remote path** (optional unless cloning) — the absolute path
     on the remote (`/home/dwork/code/foo`). Leave blank if the
     workspace sits at the same absolute path on both sides
     (rarely true across macOS-Linux pairs — usually fill it in).
     Every workspace op — file reads, `git status`, agent runs —
     uses this path on the daemon side instead of the local one.
   - **Clone from current binding** (toggle) — when on, Helmor
     bundles the workspace's full `.git` on the source runtime
     and streams it to the destination over the wire in 4 MiB
     chunks (no 10 MiB single-shot ceiling). Chunked transfer
     supports real repository histories.
       * Requires **Remote path** to be set (the destination of
         the `git clone`).
       * Performance: budget roughly **0.5–2 seconds per MiB of
         packed `.git`** end-to-end (bundle + ship + clone).
   - **Cancel / Move workspace** — confirm or back out.
4. If you've moved this workspace between hosts before, the
   **Remote path** input pre-fills with the path you used last
   time on the destination runtime. The memory is per-host:
   moving from `dev.box` to `gpu.box` and back to `dev.box`
   restores the original `dev.box` path automatically — no
   re-typing.
5. Helmor updates the binding in the local DB. The sidebar row
   gains a small chip showing the bound runtime
   (`myproject @ dev-stage`). Hovering the chip shows the remote
   path when one is set.

Moving back to `local` (right-click → **Move to runtime → Local**)
clears the active binding. The per-host **path memory** is
preserved — if you later move back to a remote you've used
before, the dialog still pre-fills.

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

Two additional banners fire when the remote misbehaves
persistently:

- **Crash-loop banner**: appears when the daemon respawns 3+ times
  in 5 minutes. Indicates a daemon-side bug or a misbehaving
  sidecar; the banner exposes the recent restart timestamps and
  points at the daemon log path for triage.
- **Version drift banner**: appears when the daemon's
  `helmor-server` binary is older than the desktop's expected
  protocol-matched version (typically after the desktop upgrades
  but the remote install didn't auto-renew). One-click
  **Reinstall daemon** force-installs the matching binary and
  reconnects.

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

### "SSH agent not detected" amber chip in the wizard

`SSH_AUTH_SOCK` isn't exported in the desktop's environment. Most
common cause: launching Helmor from Finder / Spotlight, which
doesn't inherit your shell's env. Fixes:

- Launch Helmor from a terminal: `open -a Helmor` from a shell that
  has the agent socket exported.
- Or pre-load the key into the agent before launch:
  `ssh-add ~/.ssh/id_ed25519`.
- Plain identity-file auth (`~/.ssh/id_rsa`, `~/.ssh/id_ed25519`)
  still works without the agent — the chip is informational, not
  blocking. Helmor calls `ssh` and ssh reads your config + key
  files itself.

### "SSH agent socket is stale" red chip

The `SSH_AUTH_SOCK` env var points at a Unix socket that no agent
is listening on. Usually means the agent was killed (or restarted
with a new socket path) since the desktop launched. Re-launch
Helmor from a fresh shell.

### "Agent forwarding required" — remote `git fetch` asks for a password

The remote daemon needs to authenticate to a private git repo and
your local agent isn't being forwarded. Two fixes:

- Re-add the remote with **Forward SSH agent** checked in the
  Add-Server wizard. The flag persists on the runtime so
  auto-reconnect keeps it on across restarts.
- Or have the remote use a dedicated deploy key (then leave
  forwarding off — the security trade-off only matters when the
  remote needs *your* keys).

### "Connect failed: Permission denied (publickey)"

The wizard's SSH diagnostics strip is the fastest debug path:

- Empty identity list → `ssh-keygen` is missing or the agent has no
  keys. Either generate one (`ssh-keygen -t ed25519`) or
  `ssh-add ~/.ssh/id_*`.
- Identity is amber (public-key only, no matching private key) →
  re-copy the private key into `~/.ssh` or regenerate.
- Both chips green but auth still fails → check the remote's
  `~/.ssh/authorized_keys` for your public key.

### Daemon logs

The daemon writes to `$HOME/.helmor/server/daemon.log` on the
remote. Tail it during troubleshooting:

```bash
ssh <host> tail -f ~/.helmor/server/daemon.log
```

Or from inside the desktop without an extra SSH session: the
`daemon.tailLog` RPC is wired into the dev-only Runtime Debug
panel (Settings → Developer → Runtime Debug → Daemon log).

### Copy diagnostics (production support escape hatch)

When something's wrong and you need to share state with someone
without screen-sharing:

1. **Settings → Remote Servers → your remote row → Diagnostics**.
2. A JSON blob lands on your clipboard with everything a support
   reviewer needs:
   - Runtime state (connected / degraded / disconnected + reason).
   - The daemon's reported version and protocol version.
   - RPC pipe telemetry: requests sent, responses received,
     notifications, decode errors, ping latency.
   - Per-method RPC metrics: counts, error rates, p50/p99 latency.
   - Last 50 lines of the daemon log.
   - Desktop envelope: platform + user agent (no PII beyond that).
3. Paste into the support thread / issue. No secrets cross the
   wire — provider API keys live on the remote and never appear
   in the blob.

The button is disabled when the runtime isn't currently connected
(the daemon can't answer the RPCs that fill the blob). Reconnect
first if you need diagnostics from a degraded host.

## Security model

- **Auth**: all transport goes through SSH. Helmor never sees
  passwords; key handling is whatever `ssh-agent` / `~/.ssh/config`
  already set up.
- **Agent forwarding**: off by default. The Add-Server wizard
  exposes a per-runtime opt-in for `-o ForwardAgent=yes` so the
  remote daemon can drive git over your local agent. Only enable
  for hosts you trust — agent forwarding lets the remote user
  drive your agent to authenticate against any service that
  recognises your keys.
- **Binary integrity**: the download install path verifies SHA256
  against the release `SHA256SUMS` manifest before installing.
  A mismatch aborts the install and surfaces an error.
- **API key storage (remote runtimes)**: provider API keys pushed
  to a remote daemon are stored at
  `$HOME/.helmor/server/secrets.json` (mode 0600) on that remote.
  The desktop never persists the key value. Each runtime has its
  own secrets store. The `agent.authStatus` RPC returns only the
  presence bit + optional base URL — the literal key never crosses
  the wire after the initial set.
- **API key storage (local runtime)**: provider keys for the
  built-in `local` runtime live in the OS-native vault under
  service `com.helmor.api-keys`:
  - macOS → Keychain (security-framework, login keychain).
  - Linux → Secret Service via D-Bus (GNOME Keyring, KWallet, etc.).
  - Windows → Credential Manager.
  Helmor migrates pre-existing plaintext SQLite values into the
  vault transparently on first read; the SQLite field is cleared
  after a successful migration. Only genuinely unsupported targets
  (e.g. FreeBSD desktops) fall back to the legacy plaintext path.
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
