# Remote Runner — PR Readiness Checklist

Status snapshot + remaining work to get the remote-runner branch to
"one perfect PR against `dohooo/helmor:main`", per the strategy in
[`remote-runner-upstream-readiness.md`](./remote-runner-upstream-readiness.md):
land it as a single, complete, production-ready feature that
competes with VS Code Remote-SSH, Zed Remote, and JetBrains
Gateway. The maintainer should be able to merge without surprises,
and users on the upstream branch should be able to add a remote +
run an agent on it in under 2 minutes.

Current branch: 117 commits ahead of `dohooo/helmor:main`, 0 behind
(merged through PR #633 in commit `fb16f89a`).

---

## 1. Roadmap status

Sourced from `remote-runner-upstream-readiness.md` (the per-track
roadmap). Items marked done are in code on this branch; "partial"
means scaffolded but needs verification or polish before shipping.

### Track B — Setup UX (Zed/VS Code parity)
- [x] **B1** Add-Remote-Server wizard — 377 lines, host autocomplete from `~/.ssh/config`, live SshDiagnostics, agent-forwarding checkbox, pre-flight probe.
- [x] **B2** `~/.ssh/config` integration — `listSshHostDetails` returns alias + hostname + user + identityFiles + proxyJump; surfaced inline in wizard via `HostDetailPreview`.
- [x] **B3** SSH key visibility + agent diagnostics + **pre-connect ssh probe** (`probeSshHost`, classify auth vs unreachable vs timeout). Action-shaped error messages.
- [x] **B4** Agent forwarding — `forward_agent` flag end-to-end + `SSH_AUTH_SOCK` propagated to remote daemon (Track G3).
- [x] **B5** Sidebar host indicator (`RuntimeHostChip`) + workspace rebind UI (`MoveWorkspaceDialog`).
- [x] **Empty-state CTA** on the Remote Servers settings panel.

### Track C — Resilience
- [x] **C1–C6** All shipped: connection state machine, exponential-backoff reconnect, app-level heartbeat, in-flight stream preservation via `since_seq`, top-shell banner with Reconnect-now, half-open-socket detection.

### Track D — Distribution
- [x] **D3** Auto-install over SSH on first connect — download path detects arch via `uname -sm`, verifies SHA256 against release manifest, retries once on checksum mismatch.
- [x] **D4** Protocol version negotiation + auto-reinstall on mismatch.
- [x] **D5** Standalone `install-helmor-server.sh` script.
- [x] **D1 (workflow)** `.github/workflows/publish-helmor-server.yml` builds + uploads 4-target matrix on `helmor-server-v*` tag push. Toolchain pinned via `rust-toolchain.toml`, Cargo cache, post-build smoke test, lenient strip, artifact-count validation, pinned third-party action SHAs.
- [ ] **D1 (verification)** The workflow has never actually run end-to-end. **Needs at least one successful `workflow_dispatch` dry-run + one tagged release** to confirm the wire shape (URLs, tarball naming, SHA256SUMS) actually matches what `install.rs` expects.
- [ ] **D2** Signature signing (cosign + sigstore on top of `SHA256SUMS`). Adds supply-chain trust but requires key management. **Decision point — defer with a docs note, or take it on?**

### Track E — Observability
- [x] **E1** Daemon log tail (`daemon.tailLog` RPC + Runtime Debug panel).
- [x] **E2** Per-method RPC counters + p50/p99 latency (`runtime.metrics` + Runtime Debug table).
- [x] **E3** Copy-diagnostics bundles metrics + connection diagnostics + last 50 log lines into one JSON blob for support threads.
- [x] **E4** Crash-loop guard banner.

### Track F — Multi-host
- [x] **F1** Rebind UI (sidebar → "Move to runtime" → `MoveWorkspaceDialog`).
- [x] **F2** Per-host worktree path map (`remote_path` on the binding).
- [x] **F2.1** Per-host path memory across rebinds — `(workspace, runtime) → path` persists even when the active binding moves elsewhere. Dialog pre-fills on reopen.
- [x] **F3** Cross-host workspace move (chunked bundle + clone, pre-flight destination check).

### Track G — Auth & secrets
- [x] **G1–G3** Secrets vault (Keychain / Secret Service / Credential Manager), per-runtime secret scoping, SSH agent forwarding for daemon-initiated git ops.

### Track H — Documentation
- [x] **H1** `docs/remote-server-architecture.md` exists.
- [x] **H2** `docs/remote-server-user-guide.md` exists.
- [x] **H3** `docs/remote-server-protocol.md` exists.
- [x] **H4** `docs/remote-server-contributing.md` exists; test rig rewritten to remove Docker requirement.
- [ ] **Audit pass** — none of these has been read end-to-end as if by someone who didn't write it. Likely gaps + stale references after F2.1 / D1 / E3 landed.

### Internal phases (24n → 24t)
- [x] All merged: persistence integration test, daemon event journal + replay-from-seq, cold-attach historical replay, user-prompt backfill, journal durability across daemon restarts, replay-only sessions.

---

## 2. What "production-ready" actually means here

A maintainer reviewing the PR can merge it without follow-up Q&A,
and an upstream user pulling `main` immediately gets a feature
that works as well as Zed Remote / VS Code Remote-SSH for:

- **Onboarding**: add a remote in <2 min through the wizard, no
  docs needed, on a fresh remote where `helmor-server` isn't
  installed yet.
- **Stability**: SSH drops auto-reconnect within ~5s with full
  journal replay; no manual refresh required.
- **Trust**: download install verifies SHA256, falls back to scp
  only when the release isn't reachable, never silently installs
  a wrong-arch binary.
- **Diagnosability**: one-click Copy Diagnostics blob in
  Settings → Runtime Debug carries everything a support thread
  asks for.
- **Multi-host**: same workspace can live on multiple runtimes
  with independent worktree paths; the dialog remembers each.

The branch already implements all of that in code. The remaining
work is about **proving it works** end-to-end and **shaping the
PR** so a reviewer can land it confidently.

---

## 3. Outstanding code work

Items that are still actual code changes (not verification, docs,
or process).

- [ ] **D2 (optional, decision pending)**: sign `SHA256SUMS` with
      cosign / sigstore. ~half-day of CI YAML + key provisioning.
      Trade-off: real supply-chain integrity vs. extra setup
      complexity and a key the maintainer has to rotate. Defer
      with a docs note if not taking it on.
- [ ] **Workflow first-run fix-ups**. The `publish-helmor-server.yml`
      workflow is code-clean but has never run. The first
      `workflow_dispatch` will almost certainly surface 1–2 issues
      (typically: a CI-only env quirk like `strip` flags on macOS
      runners, or a cache key collision). Reserve a slot to fix.
- [ ] **Dead-code / TODO / debug-path audit**. A 100+ commit spike
      accumulates `dbg!`-shaped logging, `// TODO(F2)` markers that
      are now done, unused enum variants, defensive branches that
      were never hit. Each one is a "what is this for?" comment
      from the reviewer. Sweep:
  - [ ] `cargo clippy -- -W dead_code -W unused_variables` (no
        deny; just surface)
  - [ ] `rg -n 'TODO|FIXME|XXX' src-tauri/src/remote/ src-tauri/src/agents/ src-tauri/src/commands/remote_commands.rs`
  - [ ] `rg -n 'dbg!|println!|eprintln!' src-tauri/src/remote/ src-tauri/src/agents/streaming/`
  - [ ] `rg -n '#\[allow\(' src-tauri/src/remote/ src-tauri/src/agents/` — justify or remove each
- [ ] **Remove the runtime-debug panel from prod builds OR rename to "advanced"**. Today it's behind `#[cfg(debug_assertions)]` in the bridge but the UI surface is always shown. Decide whether this is a production feature (then drop the dev-only label) or strictly internal (then gate the UI).
- [ ] **Cross-platform path handling**. `src-tauri/src/remote/install.rs` assumes `$HOME` expansion + POSIX paths in the install script. macOS-as-remote works because zsh expands the same way; an explicit pass to confirm Linux remote / macOS remote / Linux ↔ macOS desktop combos would catch any latent issue. Likely 0 changes, but worth running explicitly.

---

## 4. Verification work

Items that don't change code but must happen before the PR opens.
These are what got the last PR closed.

### 4.1 End-to-end manual test pass

Walk through every flow on a real Linux VM (not localhost):

- [ ] Add a remote on a fresh VM via the wizard. `helmor-server`
      isn't installed yet → auto-install path runs → daemon
      starts → desktop attaches.
- [ ] Create a new workspace bound to that remote at creation
      time (Where picker on Start page).
- [ ] Open the workspace, send a prompt, get a streaming response.
- [ ] Pull the network cable for 30s → reconnect → verify
      `since_seq` replay fills the gap (no missing events).
- [ ] Kill the remote daemon with `kill -9` in a tight loop → verify
      crash-loop banner fires + offers Reinstall.
- [ ] Move the workspace to a second remote → verify chunked-bundle
      clone + path memory.
- [ ] Move back to the first remote → verify path memory pre-fills
      the original path.
- [ ] Force a version drift (deploy an older `helmor-server` binary
      manually) → verify the drift banner fires → click Reinstall
      → confirm the upgrade.
- [ ] Open a remote terminal → run an interactive program (vim,
      htop) → resize the window → confirm winsize propagates.
- [ ] Start a port forward (local:5173 → remote:3000) → curl
      `localhost:5173` from the desktop → confirm it reaches the
      remote service.

Each step ideally captured as a short screencast and attached to
the PR.

### 4.2 Cross-arch verification

- [ ] **macOS arm64 desktop → Linux x64 remote**: most common
      production combo. Verify download install picks
      `x86_64-unknown-linux-gnu`.
- [ ] **macOS arm64 desktop → Linux arm64 remote**: AWS Graviton
      / Ampere case. Verify `aarch64-unknown-linux-gnu` download.
- [ ] **macOS arm64 desktop → macOS arm64 remote**: developer
      pairing. Verify `aarch64-apple-darwin` download.
- [ ] **macOS x64 desktop → Linux x64 remote**: x86 Macs (Intel,
      pre-Apple Silicon).

Without a published release, all four of these will fall through
to the scp path (which only works when arch matches). So this
verification is gated on a successful D1 first release.

### 4.3 Automated suite

- [ ] `cargo test --tests` (integration tests, including pipeline
      snapshots) — confirm no insta drift.
- [ ] `cargo clippy --all-targets -- -D warnings` — already clean.
- [ ] `bun run test:frontend` — 1533/1533 currently green (114
      unhandled-rejection warnings are pre-existing Tauri-API
      teardown noise on origin/main, not a merge artifact).
- [ ] `bun run test:sidecar` — confirm clean.
- [ ] `bun run typecheck` — already clean.

---

## 5. Docs audit

The four `remote-server-*` docs exist. None has been read
end-to-end as if for the first time.

- [ ] **architecture.md** — confirm daemon model + protocol +
      journal contract is explained without referring to phase
      numbers (24n, 24q, etc.). A reviewer doesn't have that
      context.
- [ ] **user-guide.md** — walkthrough must match the *actual*
      current UX (post-F2.1, post-E3). Sections to audit:
  - [ ] "Add Remote Server" wizard screenshots / step text
  - [ ] "Move workspace" dialog screenshots (now has path memory)
  - [ ] Troubleshooting section — does it mention the new
        pre-flight ssh probe error shapes?
  - [ ] Security model — confirm honest about what the daemon
        can and cannot do (file access, secrets, networking).
- [ ] **protocol.md** — JSON-RPC method reference. Audit:
  - [ ] Every method in `src-tauri/src/remote/methods.rs` listed.
  - [ ] Versioning policy crystal-clear (when minor vs major).
  - [ ] Notification methods (`agent.event`, etc.) documented.
- [ ] **contributing.md** — test rig rewritten this session
      (Docker no longer required). Audit the rest:
  - [ ] "Cutting a release" section accurate after D1 hardening.
  - [ ] "Where the seams are" still reflects the current
        layering (Track G2 + B3 + F2.1 added new modules).
- [ ] **README link**. The repo's main README probably doesn't
      mention remote-runner yet. Add a section + link out.

---

## 6. Release process — first cut

Pre-PR sequencing of the first ever `helmor-server-v0.1.0` tag.

- [ ] **Dry-run via `workflow_dispatch`** with version
      `0.1.0-dryrun` to validate the matrix end-to-end.
- [ ] Inspect the four resulting tarballs:
  - `helmor-server-0.1.0-dryrun-x86_64-unknown-linux-gnu.tar.gz`
  - `helmor-server-0.1.0-dryrun-aarch64-unknown-linux-gnu.tar.gz`
  - `helmor-server-0.1.0-dryrun-x86_64-apple-darwin.tar.gz`
  - `helmor-server-0.1.0-dryrun-aarch64-apple-darwin.tar.gz`
- [ ] Untar each, run `./helmor-server --version`, confirm
      `helmor-server <ver>\nprotocol 0.1.0`.
- [ ] If clean: tag `helmor-server-v0.1.0` + push. Aggregate
      job runs, GitHub release created.
- [ ] End-to-end install check: from a desktop pointed at this
      repo (`HELMOR_RELEASE_REPO=david-engelmann/helmor` at
      compile time) connect to a fresh remote without
      `helmor-server` and watch the auto-install path land the
      tagged release's binary.

---

## 7. Branch shaping for the PR

The reviewer will see one PR with N commits. The internal phase
numbering (24n → 24q-2 → F2.1) shouldn't be in commit subjects —
those are project-internal naming. Re-shape:

- [ ] Decide squash strategy. Two reasonable shapes:
  - **One commit per logical change** ("add helmor-server binary +
    JSON-RPC framing", "add SSH transport", "add agent attach",
    "add journal/replay", "add wizard", "add observability",
    "add multi-host support", "add release pipeline"). ~8 commits.
    Bisectable, reviewable in chunks, clear story.
  - **One commit for everything**. Smallest review surface, but
    each commit-by-commit comment becomes a multi-thousand-line
    quote.
  - Recommended: **one commit per logical change**.
- [ ] If going with multi-commit: prepare a `git rebase
      --interactive` plan that picks ranges to squash. Don't
      lose the F2.1 / B3 / D1 / E3 ownership in commit messages
      — keep the changesets but rename to user-facing names.
- [ ] Capture internal phase log in
      `docs/plans/internal-phases.md` (or similar) so the
      project-internal sequencing isn't lost — useful for our
      own bisecting on this fork, not for upstream review.

---

## 8. Parity polish vs. VS Code / Zed / JetBrains

Items the upstream-readiness doc flags as "out of scope" or
"partial" that competitors do handle. Worth deciding explicitly
in the PR description: "in scope for v1" vs. "deferred to a
follow-up".

- [ ] **Settings sync**. Zed/VS Code/Cursor all sync user
      settings to the remote. Today Helmor doesn't. Defer to a
      follow-up PR; flag in the user guide as a known gap.
- [ ] **Workspace discovery via remote file picker**. Zed lets
      you browse the remote filesystem to pick a workspace path.
      Helmor's wizard requires typing it. Defer; mention as a
      known limitation in the wizard's help text.
- [ ] **Web client / browser access**. Out of scope (matches
      Zed's posture, differs from VS Code + Cursor). Document
      the decision in the architecture doc.
- [ ] **Cmd-Shift-P / palette entry "Open Remote Workspace"**.
      Today the discoverability path is Settings → Remote
      Servers. Worth adding a palette entry for parity. Small;
      ~30 min of work. **Consider for this PR.**
- [ ] **Performance under load**. Open a 5 MB log file in the
      remote editor → time to first paint. Save a 1 MB file →
      time to "saved" toast. Compare to Zed Remote on the same
      VM. Document numbers in `architecture.md`. **Verification,
      not new code.**
- [ ] **Terminal feature coverage** (`xterm` already in tree
      via `@xterm/addon-webgl@0.19.0` from the upstream merge).
      Audit:
  - [ ] 256-color escape sequences (`tput colors` on the remote)
  - [ ] Mouse events (click in nvim, scroll in less)
  - [ ] Window resize propagation (already verified above)
  - [ ] OSC 8 hyperlinks (cmd-clickable URLs)

---

## 9. Decision points (need user input)

Things I can't decide unilaterally — flag for explicit yes/no
before the PR opens.

1. **D2 signature signing**: take on cosign + sigstore key
   management now, or defer with a docs note? *(Recommend defer
   — adds complexity, SHA256 already gives integrity if the
   release page itself isn't tampered with.)*
2. **Squash strategy**: one commit, ~8 logical commits, or
   preserve the existing branch history? *(Recommend ~8 logical
   commits.)*
3. **Cross-arch verification scope**: all four desktop ↔ remote
   matrix combinations, or just the most common
   (macOS-arm64 → Linux-x64)? *(Recommend all four — the matrix
   is small and exposes real bugs cheaply.)*
4. **Track A original slicing**: still want a single PR, or
   reconsider 2 PRs (foundation + polish) now that the merge
   went in cleanly? *(User stated single-PR strategy explicitly;
   defaulting to that unless reconsidered.)*

---

## 10. Estimated remaining effort

Rough sizing in calendar days against a single-person cadence,
with verification dominating:

| Section | Effort |
| --- | --- |
| §3 Outstanding code work (excluding D2) | 1–2 days |
| §4 Verification (E2E + cross-arch + suite) | 2–3 days (gated on §6) |
| §5 Docs audit | 1 day |
| §6 First release | 0.5 day if §3 + workflow first-run is clean, 1.5 days otherwise |
| §7 Branch shaping | 0.5 day |
| §8 Parity polish (palette entry + terminal audit) | 0.5 day |
| **Total** | **~6–8 working days** |

If D2 is in scope: add 0.5–1 day.

---

## 11. PR submission checklist

Once everything above is checked, the PR description writes
itself. Final pre-submission gate:

- [ ] `cargo test --tests` + `bun run test` + `bun run lint` all
      clean from a fresh clone.
- [ ] `helmor-server-v0.1.0` (or higher) tag exists on
      `david-engelmann/helmor` with a clean release.
- [ ] All four cross-arch combinations verified end-to-end.
- [ ] All four `remote-server-*` docs audited + linked from the
      repo README.
- [ ] Demo recordings linked in the PR description.
- [ ] PR title: "feat: remote-runner foundation (remote
      workspaces + agents over SSH)".
- [ ] PR body opens with the user-facing 1-liner, then the
      "what's in scope vs. deferred" matrix from §8.
