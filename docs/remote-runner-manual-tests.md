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
4. Add a runtime: choose **ssh**, enter the host, click **Connect**.
   The runtime should appear in the list with a green "connected"
   chip.

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

## After every checked-in change to the remote-runner code

Run the automated gates that already exist:

```
bun run lint          # biome + clippy
bun run typecheck     # tsc (frontend + sidecar)
bun run test          # frontend + sidecar + cargo
```

Then run this checklist. The integration tests cover the local-binary
path; the SSH path is the one humans must verify.
