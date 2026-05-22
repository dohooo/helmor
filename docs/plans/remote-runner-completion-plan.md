# Remote Runner Completion Plan

This plan sequences the remaining internal phases needed to bring the
remote-runner feature from "barely works while attached" to "feels
identical to a local session across crashes, reattaches, and cold
opens", and then maps the internal phases onto reviewable upstream
PRs for [#453](https://github.com/dohooo/helmor/issues/453).

The plan starts from the merged state of PR #11 (phase 24n: persist
reattached turns to local DB) and ends with a clear upstream-PR
slicing strategy.

## Architectural Facts (May 2026)

These ground every decision below. Verified directly against the code
in `src-tauri/src/remote/daemon.rs` and `src-tauri/src/remote/server/`.

- The daemon (`helmor-server`) is **purely in-memory**. No SQLite, no
  event log file, no turn history. Crash = all state evaporates.
- Terminal reattach exposes a **256 KiB scrollback ring** so a fresh
  client sees recent output. Agent reattach exposes **nothing** —
  just a notifier swap; events emitted before the attach call are
  gone.
- The local desktop's SQLite is the **only durable store** for
  assistant turns. Phase 24n closed the desktop-side write gap; the
  daemon-side gap is wide open.
- Phase 24n persistence writes rows but does **not** broadcast
  `UiMutationEvent::SessionMessagesAppended`. Stale React Query caches
  on the chat thread don't refetch when a reattach lands new rows.
- Existing reattach unit tests assert envelope shape only. The
  persistence path silently no-ops when `write_conn()` fails (no DB
  in mock builders), so the rust suite proves the wire contract but
  not that rows actually land.

## Phase Sequence

The internal phase numbering continues 24n → 24o → 24p → … so commits
stay searchable against the existing branch history.

### Phase 24o: UI sync after reattach persistence

User-visible outcome: when a reattach lands new persisted rows for a
session that is open in another tab / another React Query consumer,
the chat thread refetches immediately. No more "close and reopen the
session to see the assistant turn".

Scope:
- After the reattach loop's `drain_new_turns_into_db` returns
  `wrote_any`, publish `UiMutationEvent::SessionMessagesAppended {
  session_id }` through `crate::ui_sync::publish`.
- After `persist_error_into_db` succeeds, publish the same event.
- Mirror the codex-goal pattern at
  [codex_goal.rs:280](src-tauri/src/agents/streaming/codex_goal.rs#L280) —
  invalidate only on actual insert, never on a no-op idempotent
  re-write.

Files:
- `src-tauri/src/agents/streaming/reattach.rs`

Tests:
- New unit test inside `reattach::tests` that captures
  `UiSyncManager` events while the loop runs a small fixture and
  asserts `SessionMessagesAppended` appears exactly once per real
  insert. Uses `mock_app_handle()` + `ManualTransport` (already in
  place).
- Existing reattach tests should continue to pass without
  modification; the no-DB branch produces zero inserts → zero events.

PR boundary:
- No changes to persistence shape, daemon, or the messages query.
- No changes to envelope contract; `persisted` still flips the same
  way.

Effort: ~1 day. Highest leverage for size.

### Phase 24p: Persistence integration test

User-visible outcome: none directly. Locks the 24n + 24o contract
against future regressions.

Scope:
- Add `src-tauri/tests/reattach_persistence.rs` (or an extension to
  an existing integration test file) that:
  1. Initialises a temp SQLite via `crate::models::db` with schema +
     a seeded workspace/session row.
  2. Builds a real `AppHandle` via `mock_builder()` with that DB
     pointed at via `HELMOR_DATA_DIR`.
  3. Drives `run_reattach_loop` through a `ManualTransport` with a
     scripted event sequence: delta → assistant → result.
  4. Reads `session_messages` directly and asserts the row's id,
     role, content_json, and ordering match the daemon-emitted shape.
  5. Asserts the captured channel's terminal `Done` envelope reports
     `persisted: true`.
- Add a parallel test that re-runs the same sequence twice in a row
  to prove idempotency at the full-loop level (not just at the unit
  level we already have).

Files:
- New: `src-tauri/tests/reattach_persistence.rs`
- Touches `tests/common/mod.rs` if a temp-DB helper makes sense to
  share with future integration tests.

PR boundary:
- Tests only. No production changes.

Effort: ~1 day. Pure quality investment.

### Phase 24q: Daemon-side event journal

User-visible outcome: a desktop that reattaches mid-turn now sees the
events the daemon emitted before the attach call, instead of joining
in the middle. The accumulator's leading state is consistent with the
trailing state. Foundation for 24r and 24s.

This is the load-bearing architectural phase. Sliced into two PRs to
keep each reviewable.

#### 24q-1: In-memory ring buffer per active agent session

Scope:
- Extend `ActiveAgentSession` in
  `src-tauri/src/remote/server/agent/mod.rs` to carry an event ring
  (e.g. `VecDeque<JournalEntry>` capped at N events or M bytes —
  TBD by representative profiling, but a 4 MB cap per session is the
  starting heuristic; assistant deltas dominate volume).
- Each entry: `{ seq: u64, ts_ms: u64, payload: Value }`. Sequence
  increments per-session and never resets.
- Append every event the daemon forwards to the current notifier.
- On `agent.attach`, the handler accepts an optional `since_seq:
  u64` parameter:
  - `None` → flush the entire ring then go live (current behaviour
    for the cold case).
  - `Some(n)` → flush entries with `seq > n` then go live. If the
    ring no longer holds events that recent (eviction), return a
    `ReplayGap { earliest_available_seq }` envelope so the client
    knows it has to fall back to a full reload.
- Bump the JSON-RPC protocol version (a minor bump tag in
  `protocol.rs` is enough; the desktop already negotiates).

Files:
- `src-tauri/src/remote/server/agent/mod.rs`
- `src-tauri/src/remote/server/agent/methods.rs`
- `src-tauri/src/remote/server/handlers.rs`
- `src-tauri/src/remote/protocol.rs`

Tests:
- Unit tests on the journal: append, replay-from-seq, eviction
  semantics, gap signalling.
- Handler test that `agent.attach` with a stale `since_seq` emits a
  `ReplayGap` envelope rather than silently truncating.

PR boundary:
- Desktop side does not consume the new replay yet. The journal is
  silently populated; old clients ignore the new attach parameter.
  This keeps the change reviewable as "daemon now journals events"
  in isolation.

Effort: 2-3 days.

#### 24q-2: Desktop reattach consumes `since_seq`

Scope:
- `stream_reattach_via_sidecar` and the auto-reconnect path
  (`use-workspace-remote-reattach.ts` callsite into the rust
  command) thread the desktop's locally-known last sequence number
  through to `agent.attach`.
- Sequence numbers are persisted on each row write — add a
  `last_event_seq` column to `session_messages` (nullable, populated
  on writes from the streaming path).
- On reattach, the desktop queries the max `last_event_seq` for the
  session and passes it as `since_seq`.
- Handle `ReplayGap`: the chat thread shows a one-line notice ("some
  earlier events couldn't be replayed; full history is on the next
  daemon turn") and the loop continues with whatever the journal
  could provide.

Files:
- `src-tauri/src/agents/streaming/reattach.rs`
- `src-tauri/src/schema.rs` (migration for `last_event_seq`)
- `src-tauri/src/agents/persistence.rs` (writes the column)
- `src/features/conversation/hooks/use-workspace-remote-reattach.ts`

Tests:
- Pipeline snapshot test against a representative replay-from-seq
  stream fixture, dropped under `src-tauri/tests/fixtures/streams/`.
- Schema migration snapshot for the new column.
- Unit test that the `ReplayGap` envelope produces the user-facing
  notice without panicking the loop.

PR boundary:
- The journal must already exist (24q-1 merged).
- No daemon-side persistence yet — the journal is still RAM-only.

Effort: 2-3 days.

### Phase 24r: Cold-attach historical turn replay

User-visible outcome: a desktop opening a workspace that has an
active remote session can rebuild the full conversation by replaying
the daemon's journal from seq 0, not just whatever flowed after the
attach.

This is mostly desktop-side because the journal already exists.

Scope:
- On cold attach (no local rows for this `helmor_session_id`), the
  desktop calls `agent.attach` with `since_seq: 0`.
- The reattach loop runs the replayed events through the same
  accumulator + persistence path 24n already established, so by the
  time the live tail starts, the local DB matches the daemon's
  emitted history.
- A progress affordance in the chat header ("rebuilding history… N
  events") because a long replay over SSH may take a few seconds.
- Treat `ReplayGap` from 24q-1 as a fatal-for-history signal: the
  thread shows a "history unavailable; new turns will appear here"
  banner and continues live.

Files:
- `src-tauri/src/agents/streaming/reattach.rs` (cold-attach branch
  distinction)
- `src/features/conversation/hooks/use-workspace-remote-reattach.ts`
- `src/features/panel/components/*` (header banner)

Tests:
- Extend the 24p integration test with a "cold attach replays
  history" scenario: scripted journal of three turns, fresh desktop
  DB, assert all three rows land + the live `Done` arrives.
- Add a frontend test for the header banner showing/hiding around
  replay progress.

Effort: 2-3 days.

### Phase 24s: User-prompt backfill

User-visible outcome: a desktop attaching to a session it never sent
sees the original user prompt at the top of the thread, not an
"assistant-first" conversation.

Scope:
- The accumulator already classifies `user_prompt` events into a
  `MessageRole::User` turn. With 24q-1 + 24r in place, replay
  surfaces those events naturally, and the existing persistence path
  writes a user row.
- Remove the comment-as-documentation in `reattach.rs` that says
  "reattach never inserts a user row" — it WILL, but only when the
  replay carries one. Add a sanity test that a journaled
  `user_prompt` produces a `MessageRole::User` row.
- If a desktop is the original sender, the local DB already has the
  user prompt from the regular send path. The
  `ON CONFLICT(id) DO NOTHING` clause from 24n covers the dedup.

Files:
- `src-tauri/src/agents/streaming/reattach.rs` (comment + small
  branch removal if needed)
- `src-tauri/tests/reattach_persistence.rs` (new scenario)

Effort: ~1 day. Mostly verification; little new code.

### Phase 24t: Daemon journal durability (optional)

User-visible outcome: a daemon restart no longer loses all
historical events for in-progress sessions. Reattach after a daemon
crash can still replay.

This is optional — the prior phases make the desktop the durable
store for completed turns, so a daemon restart "only" loses events
that happened during the disconnect window. If profiling shows that
window is small in practice, this phase can be skipped.

Scope:
- The ring becomes an append-only file per session under
  `$HOME/.helmor/server/journals/<helmor_session_id>.jsonl`.
- Daemon truncates a journal file when the session emits a terminal
  event AND the on-disk row is older than a configurable retention
  (default: 24 h).
- On daemon start, sessions whose journals exist but whose processes
  are gone are exposed as "ended; replay-only" via `agent.list`.

Effort: 3-4 days.

## Upstream PR Slicing Strategy

The fork's internal phases 24k → 24s touch many areas; not all are
ready to be one upstream PR. The roadmap's Track F suggests
F1 (local headless server protocol) and F2 (SSH transport spike).
The internal work is far beyond F1/F2, but the upstream PRs should
match F1/F2 scope first so maintainers can merge incrementally.

| Upstream PR | Internal phases that map | Scope |
| --- | --- | --- |
| F1 | (already covered by spike phases 17-19) | `helmor-server` binary, JSON-RPC over stdio, one read-only method, no SSH |
| F2 | 22a / 22b / 23a-c | SSH transport, daemon spawn over SSH, connection diagnostics |
| F3 | 23d / 24i / 24l / 24m / 24n / 24o | Agent attach + chat reattach + local persistence + UI sync |
| F4 | 24k | Port forwarding (already a recent merge candidate per #453) |
| F5 | 25a | Auto-reconnect + top-shell banner |
| F6 | 24q-1 / 24q-2 / 24r / 24s | Daemon event journal + replay-from-seq + history rebuild |
| F7 | 24t (optional) | Journal durability across daemon restarts |

Slicing rules:
- Each upstream PR is bounded by a stable wire-contract boundary. F3
  cannot ship until F1/F2 land because it depends on the spawn +
  transport surface.
- F4 (port forwarding) is independent of F3/F5/F6 and can ship in
  parallel.
- F6 is the heaviest review. Open it only after F3/F5 are in main and
  the maintainer has signed off on remote agent attach as a product
  direction (issue #453 has product pull but no design commitment
  yet).

## Recommended Order

1. **24o** — UI sync invalidation. Tiny, unblocks visible bugs.
2. **24p** — Integration test. Locks 24n + 24o.
3. **24q-1** — Daemon ring buffer (no desktop wiring).
4. **24q-2** — Desktop consumes `since_seq` + schema migration.
5. **24r** — Cold-attach history rebuild.
6. **24s** — User-prompt verification.
7. **24t** — Optional durability.
8. **Upstream F1/F2 slicing review** — Compare the internal stack
   against the roadmap's F1/F2 boundaries and open the first
   reviewable upstream PR.

Each phase is its own internal PR against `david-engelmann/helmor`
main, following the cadence established through phases 24l-24n.

## Risks To Flag Before 24q-1

- The journal sequence is a per-process counter. If the daemon
  restarts mid-session (without 24t), seq resets to 0 — the desktop's
  `last_event_seq` will be ahead, the daemon returns a `ReplayGap`,
  and the desktop has to fall back. The fallback path needs to be
  exercised in tests before 24q-1 ships.
- 4 MB ring cap per session is a guess. Profile a representative
  Claude turn with tool use; if a single turn exceeds 4 MB of raw
  events, raise the cap before 24q-1 lands.
- `last_event_seq` on `session_messages` is a per-row column, but
  many events (deltas) don't produce rows. Decide whether to also
  track a session-wide "highest seen seq" (probably yes — a small
  `sessions.last_event_seq` column is simpler than max-aggregating
  over rows).
