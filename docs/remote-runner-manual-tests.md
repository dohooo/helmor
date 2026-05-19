# Remote runner — manual test checklist

The remote-runner spike (#453) has unit + integration coverage for every
RPC method and wrapper. This checklist captures the failure modes that
only show up against a *real* SSH connection — they're hard to fake
in CI (latency, large payloads, network blips) but cheap to verify by
hand once per release cycle.

Tick each item before tagging a release that bumps anything under
`src-tauri/src/remote/`, `src-tauri/src/workspace/files/`, or
`src/lib/api.ts`'s inspector wrappers.

## Setup

1. `bun run dev` — debug build only; the MCP bridge and the
   `RuntimeDebugPanel` are gated behind `#[cfg(debug_assertions)]`.
2. Stand up a real remote host with SSH key auth working
   (`ssh <host>` should succeed non-interactively).
3. Open **Settings → Runtime debug**.
4. Add a runtime: choose **SSH**, enter the host, click **Connect**.
   The runtime should appear in the list with a green "connected"
   chip.

### Command transport (phase 21b)

For non-SSH transports (Teleport, Tailscale SSH, kubectl exec):

1. Pick **Command** in the Connect form.
2. Paste the argv list — e.g. `tsh ssh dev-box helmor-server --proxy`
   or, for embedded-whitespace tokens, switch to the one-token-
   per-line form by hitting Enter inside the textarea.
3. The "Parsed:" preview underneath confirms the argv the wrapper
   will send. Click **Connect**.
4. ✅ The runtime should appear in the list with a `cmd` chip next
   to its name (added in phase 21e) and `cmd: <prog>` as its
   tooltip label.
5. ❌ If the connect hangs > 10 s, the argv probably isn't invoking
   `helmor-server --proxy` correctly. Check `{data_dir}/logs/` for
   stderr from the spawned process.

Auto-install is **not** available for Command transports — the
operator must have `helmor-server` already installed on the
remote side.

### SSH config `Include` and `Match` (phases 21c–d)

If your `~/.ssh/config` uses modular layout — `Include conf.d/*` —
the host-suggestions dropdown should now surface every alias the
included files declare. Spot-check:

1. Open **SSH** mode in the Connect form.
2. Click into the **Host** field; the datalist should include
   aliases pulled in via `Include`.
3. If you have `Match user <yourname>` blocks, aliases inside them
   appear when `$USER == yourname`, and disappear otherwise.

Run from a shell with `USER=other-name bun run dev` to verify the
`Match user` gating; the datalist should drop any host gated on a
different user. `Match exec ...` blocks are dropped wholesale —
that's by design (we don't shell out from a suggestion-list
refresh).

### Live spawned-command preview (phase 21e)

The Connect form now renders a "Will run" preview underneath the
mode-specific inputs. Use it as a sanity check before clicking
Connect:

- **Local binary** → `spawn <path>` or `spawn helmor-server
  (auto-detect)`.
- **SSH** → `ssh -o BatchMode=yes <host> sh -c '<bin>
  --ensure-daemon && exec <bin> --proxy'`. ControlMaster /
  ControlPath flags are appended at spawn time — they're not in
  the preview because they depend on the data dir being writable.
- **Command** → the literal argv as it'll reach `Command::new`,
  with each token shell-quoted in the preview for visual clarity
  (the actual spawn never shells out, so the quoting is cosmetic).

The "Paste ssh:// URL" field on the SSH mode form is a one-shot
import: it parses `ssh://user@host:port` strings (common in
GitHub Codespaces / ops handoff messages) and fills the Host
field. Port is dropped (use `~/.ssh/config` Port or Command mode
for non-default ports).

## File tree — 5k-file repo over SSH

1. On the remote host, clone or generate a repo with **at least 5 000
   files** (e.g. `linux` upstream is ~80k — pick a smaller mirror or
   `find . -type d -name node_modules -prune -o -type f -print` on a
   medium-size monorepo to count).
2. In the **Workspace inspector probe** section, paste the absolute
   path *on the remote host* into `Workspace dir`, leave
   `Workspace ID` empty, and select the remote runtime in the
   `Runtime` dropdown.
3. Click **Run file tree**.
   - ✅ Round-trip completes in **under 5 s** on a healthy LAN.
   - ✅ Result block shows the total count plus the first 12 entries.
   - ✅ No "decode" / "frame too large" errors in the JSONL logs at
     `{data_dir}/logs/`.
   - ❌ If the call hangs > 30 s, file a "perf" issue with the repo
     size, network RTT, and the log line surrounding the request id.

## Changes — dirty repo with many files

1. On the remote host, modify ~50 tracked files (`sed -i 's/foo/bar/'`
   loop, or `git checkout HEAD~10 -- some-dir/` to roll back changes).
2. Click **Run changes** in the inspector probe section. This is the
   cheap-mode path (`include_content=false`).
   - ✅ Result lists every modified path with its status.
   - ✅ "content omitted" hint is visible.
3. Click **Run changes (with content)**. This pre-fetches the per-file
   diff bodies (`include_content=true`).
   - ✅ "prefetched N" matches the number of non-deleted modified
     files under the 1 MiB cap (see `MAX_PREFETCH_BYTES` in
     `workspace::files::changes`).
   - ✅ The whole response still arrives in **one frame** — no
     "frame too large" errors in the logs.
   - ❌ If the prefetch payload causes a frame-size error, file a
     "ship `workspace.streamChanges`" issue; until then, the
     inspector falls back to the no-content path automatically when
     the user toggles content off.

## Sandbox escape — verify the seam rejects ../

1. Same panel; in the inspector probe form, type a `Workspace dir`
   of `/tmp` and use the **status probe** (or any read) with a
   relative path of `../etc/passwd` from the developer console
   (`window.__TAURI__.invoke("read_workspace_file", { ... })` is the
   quickest hook).
2. ✅ Response is `HANDLER_FAILED("workspace.readFile failed: ...
   relative path must not contain `..`")`.
3. ❌ If the call succeeds, the seam-level sandbox in
   `remote::runtime::join_workspace_relative` regressed — open a
   security issue.

## Connection drop — drag the network out

1. With a remote runtime connected, run a `Run changes (with content)`
   probe.
2. While it's in flight, drop the connection (e.g. `sudo ifconfig en0
   down` for 5 seconds, then bring it back up).
3. ✅ The probe surfaces an error notice within ~10 s — not a hang.
4. ✅ The runtime's row in **Connected runtimes** flips to the
   "disconnected" state once the liveness poller catches up.
5. ✅ Clicking **Reconnect** restores the runtime; subsequent probes
   work without restarting the desktop app.

## Pin a real workspace to a real remote

1. In the **Workspace runtime bindings** section, pin a known
   workspace id to the remote runtime.
2. Open that workspace in the main UI.
3. ✅ Inspector → Changes tab shows the *remote's* file list and
   diffs (verify by editing a file on the remote — it should
   appear within the inspector's poll interval).
4. ✅ Stage / unstage / discard buttons mutate state on the *remote*
   (`git status` on the remote should reflect the change).
5. ✅ Opening a file in the editor surface reads bytes from the
   remote; saving writes them back.
6. Unpin the workspace and re-verify: it now hits local without any
   restart.

### Remote agents (phases 23a–e)

The headline #453 feature: `claude-code` / `codex` / `cursor`
runs on the remote machine, not the desktop. After phase 23,
sending a prompt against a remote-bound workspace dispatches to
the *remote* sidecar over SSH, with output streaming back through
the existing chat pipeline.

**Pre-flight on the remote:**

1. Build `helmor-sidecar` for the remote's platform. The desktop
   bundle drops it at `Resources/vendor/helmor-sidecar` on
   macOS; cross-compile or rebuild on the remote if needed.
2. Place it on disk somewhere stable (e.g. `~/.helmor/server/helmor-sidecar`).
3. Set `HELMOR_SIDECAR_PATH=<absolute path>` in the operator
   login shell **before** restarting the daemon. The daemon resolves
   this env var on each spawn — bundling alongside `helmor-server`
   itself is deferred to a follow-on slice; until then, env var
   is the only resolution path.
4. ✅ Disconnect and reconnect the runtime from Settings → Runtime
   Debug. The daemon's startup log should show
   `daemon: agent bridge configured` (look in
   `~/.helmor/server/log/helmor-server.log`).
5. ❌ If the log shows `HELMOR_SIDECAR_PATH not set; agent.* surfaces
   will report disabled`, the env var didn't reach the daemon. SSH
   doesn't inherit your login shell's env when running `--ensure-daemon`
   — set the var system-wide (e.g. via `/etc/environment` or a
   `~/.ssh/environment` file with `PermitUserEnvironment yes` in
   `sshd_config`).

**Auth setup (Cursor key required):**

1. Settings → Runtime Debug → **Set agent auth** section.
2. Pick the remote runtime from the dropdown.
3. Provider = `cursor`, paste the API key, click **Save**.
4. ✅ A "Saved on remote" notice appears. On the remote, check
   `~/.helmor/server/secrets.json` — file should exist with
   mode `0600` and contain `{"providers":{"cursor":{"apiKey":"..."}}}`.
5. ✅ Click **Clear** to remove a stored key. The file's
   `providers.cursor` entry disappears.
6. Keys NEVER persist on the desktop side — they ship over the
   wire to the remote, get written remote-side, and the desktop
   forgets them on submit. Inspect the desktop's settings DB or
   `$HOME/Library/Application Support/Helmor/...` if you want
   to confirm the absence locally.

**Send-message routing (the headline path):**

1. Pin a workspace to a remote runtime (phase 22c — Add Workspace
   dialog's Where picker, or the binding section).
2. Open that workspace, type a prompt, send.
3. ✅ The conversation streams as normal — no UI change vs a
   local workspace. The desktop logs should show
   `stream_via_sidecar` with `transport=Remote` (phase 23c).
4. ✅ Check the remote's daemon log: events flow as `agent.event`
   notifications.
5. ✅ Abort the running stream from the UI. The remote sidecar's
   stopSession handler fires (visible in remote logs).
6. ✅ Send a mid-turn steer (multi-line input → Send while a
   reply is in flight). The remote sidecar's steerSession
   handler picks it up.

**Same-runtime resume constraint:**

The SDKs store their conversation state (JSONL files for
claude-code, etc.) on whichever machine ran the turn. A
workspace's `provider_session_id` only resumes correctly on the
SAME runtime that wrote it. Out of scope for the spike — if you
move a workspace's binding from local to remote (or between two
remotes), the next send starts a fresh session.

**Cross-runtime fallbacks:**

1. ✅ If `HELMOR_SIDECAR_PATH` is unset on the remote, `agent.send`
   surfaces as `"agent runtime is not available: HELMOR_SIDECAR_PATH
   not set"` in the desktop's send-message error toast — legible
   reason, not a cryptic spawn failure.
2. ✅ If the remote runtime is disconnected mid-stream, the
   desktop's heartbeat watchdog (45s) cleans up the active
   stream and surfaces "Sidecar connection was lost" — same UX
   as a local sidecar crash.
3. ✅ If a workspace bound to a (now-unregistered) remote
   runtime sends, the resolver falls back to the local sidecar
   with a `transport resolver: bound runtime not registered;
   falling back to local sidecar` warn-log on the desktop side.

**SSH bandwidth notes:**

Event streams during active turns run ~5–15 kB/s sustained
(Claude tool-use events with full JSON payloads are the
bandwidth-heavy ones; plain assistant deltas are tiny). The SSH
ControlMaster multiplexing wired in phase 21a keeps the
per-connection overhead negligible. If you see steady stalls,
verify the SSH connection itself isn't bandwidth-capped before
suspecting the bridge.

## After every checked-in change to the remote-runner code

Run the automated gates that already exist:

```
bun run lint          # biome + clippy
bun run typecheck     # tsc (frontend + sidecar)
bun run test          # frontend + sidecar + cargo
```

Then run this checklist. The integration tests cover the local-binary
path; the SSH path is the one humans must verify.
