# Remote Runner

What it is, what it does on your machine, and how to recover when
something goes wrong. For internals — the JSON-RPC protocol, the
daemon's accept loop, the cross-host workspace move — see
[remote-server-architecture.md](./remote-server-architecture.md) and
[remote-server-protocol.md](./remote-server-protocol.md).

## What this gives you

A remote daemon (`helmor-server`) that Helmor connects to over SSH,
runs your agent against, and hosts your workspace on. Your local
machine drives the UI; the daemon's container does the work.

When the connection is healthy, everything Helmor would normally do
against your local filesystem runs against the remote container
instead:

- **File ops** — file tree, git status + diff, file reads at HEAD, search
- **Terminal** — `xterm`-grade PTY on the daemon's host
- **File watcher** — debounced change notifications from the daemon
- **Port forwarding** — local ports tunneled through SSH to the
  container's listeners
- **Agent execution** — Claude Code (and other supported agent CLIs)
  spawned by the daemon's sidecar, with the response streamed back
  through the same JSON-RPC pipe

The promise is "your laptop is a viewport; the work lives on the
remote." Workspaces bound to a remote stay there across SSH drops, the
agent keeps running while your laptop sleeps, and the agent can't
reach anything on your laptop unless you mount it in explicitly.

## The security model — what the desktop puts on your machine

Every byte Helmor writes to the remote, on first connect or any
reinstall, goes under `$HOME/.helmor/server/` on the remote — the
same managed directory the daemon binary itself lives in. Helmor does
not, ever:

- run `sudo` or any privileged command, locally or remotely
- write outside `$HOME/.helmor/server/`
- edit your shell's rc files (`.bashrc`, `.profile`, `.zshrc`, etc.)
- generate SSH keys or edit `~/.ssh/config`
- run package managers (`apt`, `brew`, `npm i -g`) on your behalf
- kill processes it did not spawn
- execute any binary whose `sha256` doesn't match the locally pinned
  manifest

If something goes wrong and you need to start over, every file Helmor
placed lives in one directory you can `rm -rf` from a regular shell.
No surprises.

## What lands on the remote

After a successful first connect, the daemon's install dir contains:

```text
$HOME/.helmor/server/
  helmor-server          ← shell wrapper Helmor generates; the SSH
                            transport invokes this. Exports
                            HELMOR_SIDECAR_PATH + HELMOR_CLAUDE_CODE_BIN_PATH
                            then execs the real daemon.
  helmor-server.real     ← the actual daemon binary, preserved here
                            so the wrapper can `exec` it. This is
                            the 40 MB Rust binary you saw in
                            super::install — we just rename it.
  helmor-sidecar         ← cross-compiled `bun --compile` ELF (~110 MB).
                            The agent process the daemon spawns when
                            you press Send.
  claude                 ← the claude-code CLI for the remote's arch
                            (~220 MB; @anthropic-ai/claude-code-linux-
                            arm64 or -linux-x64 from npm).
  MANIFEST.json          ← sha256 of every file Helmor placed +
                            staged-at timestamp + agent SDK version.
                            The commit marker.
  sock                   ← Unix-domain socket the daemon binds (Mode
                            0600). The SSH `--proxy` bridges stdio
                            here.
  daemon.pid             ← PID of the running daemon.
  daemon.log             ← Tracing JSON, one line per event.
  crash-history.json     ← Recent daemon-restart timestamps; drives
                            the desktop's crash-loop banner.
  journals/              ← Per-session event journals so a dropped
                            SSH connection can reattach to an
                            in-flight turn.
  .staging/              ← Empty when idle. Used as a holding area
                            during installs; wiped at the top of
                            every install run.
```

## Install lifecycle

### First connect to a fresh host

When you click **Connect** in the Add-remote-server wizard, Helmor:

1. SSHes to the host with `BatchMode=yes` (no password prompts; bails
   immediately if your key isn't available).
2. Probes for an existing `helmor-server` — version + protocol check.
3. If missing or stale: scp's the desktop's local `helmor-server`
   into `$HOME/.helmor/server/helmor-server` and `chmod +x`. This is
   the daemon binary; ~40 MB.
4. **Installs the agent-runtime bundle.** This is the part that
   matters for "the agent runs on the remote." Tracked separately
   from the daemon install because it's much bigger (the bundle
   includes the sidecar + the claude binary) and has its own
   integrity story.

The bundle install is one `tar -cf - … | ssh tar -xf -` pipeline,
hardware-accelerated AES-GCM cipher, sha256-verified on the remote
before each file's atomic `mv` into place:

| Phase | What's happening | Wire bytes |
|---|---|---|
| `detecting` | `ssh host 'uname -s; uname -m'` to pick the bundle | ~50 B |
| `probing-manifest` | `ssh host 'cat $HOME/.helmor/server/MANIFEST.json'` | ~1 KB |
| `uploading` | Single tar-pipe of every file that's missing or stale | up to ~330 MB |
| `verifying` | `ssh host 'sha256sum -- <files>'`, compared to local manifest | ~few KB |
| `committing` | Per-file `mv .staging/X .helmor/server/X` + `chmod 0755` for executables | ~1 KB |
| `bouncing-daemon` | `pkill -TERM` the running daemon (scoped to our exact cmdline) so the next `--ensure-daemon` re-forks through the new wrapper | ~50 B |

A cold fresh-host first connect runs in ~5 seconds on a LAN. A warm
re-connect — where the manifest already matches — is a sub-second
no-op: the install routine returns `alreadyCurrent: true` at the
`probing-manifest` phase and never reaches the uploader.

### Subsequent connects

On every later connect the same routine runs; almost every time it's
a no-op. The cases it does anything:

- A Helmor desktop upgrade bumped the bundled sidecar or claude
  version. The manifest's sha doesn't match; the changed file (only
  the changed file) re-pushes via the tar-pipe.
- The bundle on the remote was manually `rm`'d. Same path — everything
  missing re-pushes.

### Reinstall

The Remote Servers panel has a Reinstall button per row. Same
idempotent code path as the auto-install. Use it when:

- The manifest looks stale (we ship a desktop release with a new
  claude version and you want to push it without waiting for the
  next connect).
- You suspect the on-remote state is corrupt and want to force a
  re-verify of every file.

## Atomicity + recovery

Every individual write the install performs is atomic from any
concurrent reader's perspective (the daemon's view of its own
binary, for instance):

- Files are scp'd into `.staging/` first. Half-written files never
  show up at the install path.
- `sha256sum` on the remote must match the local manifest before any
  file is moved into the install dir. A mismatch wipes the staged
  copy and the install bails — `agent.send` is gated on the manifest,
  not just on file presence, so a half-installed bundle never claims
  to be ready.
- Each `mv .staging/X X` is `rename(2)`, atomic within a single
  filesystem. A SIGTERM mid-`mv` either leaves the old file in place
  or replaces it with the new one — never a hybrid.
- The MANIFEST itself is the commit marker. It moves into place
  after every other file. An interrupted install leaves the OLD
  manifest in place; the next run's diff sees the half-installed
  files don't match and finishes the job.
- The running daemon process is unaffected by the rename (it's
  already memory-mapped its current binary). The bounce step kills
  the daemon explicitly so the next connect re-forks one through
  the new wrapper script's env.

If something genuinely breaks — disk full, bundle SHA suddenly
fails verification — the Remote Servers row shows an amber chip:

> Agent runtime install failed — Reinstall to retry

The chip's tooltip carries the chained error (e.g. `sha256 mismatch
for staged 'claude': expected b8a1…, observed 9304…`). Reinstall
wipes `.staging/` and retries the whole pipeline. The connect itself
is unaffected — file ops, terminals, watchers all still work; only
`agent.send` is gated until the install lands.

## Inspecting + uninstalling

To see what's installed on a remote:

```sh
ssh <host> 'cat $HOME/.helmor/server/MANIFEST.json'
```

That prints the bundle target, every file's sha256 + bytes, the
claude-code version, and a staged-at timestamp.

To completely uninstall everything Helmor placed:

```sh
ssh <host> 'rm -rf $HOME/.helmor/server'
```

That's the whole footprint. Anything outside `$HOME/.helmor/server/`
on your remote is not Helmor's. After this, the next connect from
the Helmor desktop re-installs from scratch — the install path is
idempotent + fresh-host-safe.

## What runs where

| Concern | Where it lives |
|---|---|
| The Helmor UI (chat, file tree, settings) | Your desktop |
| The agent that reads files, runs commands, edits | The remote container, spawned by `helmor-sidecar`, talking to `claude` |
| Workspace files | The remote (when bound) — `remote_path` is stored in the binding |
| Workspace metadata (sessions, message history) | Your desktop SQLite (`~/helmor/helmor.db`) |
| API keys for SDK providers | Optionally on the daemon's `secrets.json` (Track G2), never on the desktop side. The desktop only sees which providers have a key, not the value. |
| SSH keys, ssh-agent socket | Untouched. Helmor reads `~/.ssh/config`; it does not write |

## Building bundles for cross-arch hosts

Helmor's package release ships bundles for the host platforms it
supports. For dev iteration / contributors:

```sh
# Cross-compile the Linux sidecar (one or both archs).
HELMOR_SIDECAR_TARGETS=linux-arm64,linux-x64 bun run build

# Stage the matching claude-code Linux binaries + assemble the
# verifiable bundle layout.
HELMOR_REMOTE_BUNDLES=linux-arm64,linux-x64 bun run scripts/stage-vendor.ts
```

This produces `sidecar/dist/remote-bundles/<target>/` with the
sidecar + claude + wrapper + MANIFEST. The desktop discovers them
automatically; `HELMOR_REMOTE_BUNDLES_DIR=/path/to/bundles` overrides
the discovery if you want to keep them outside the source tree.

## Demos

Captioned video walkthroughs of every claim above live in the
`helmor-taper` repo under `docs/tapes/`. The headless probes the
videos run on top of are in `helmor-taper/scripts/probe-*.ts` —
each one is a runnable contract that can re-verify the feature from
scratch without recording anything.
