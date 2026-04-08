# E1 — cargo flamegraph on dev_server (instructions)

## What this profiles

`cargo flamegraph` produces a SVG flame graph of CPU time spent in the
`helmor-dev-server` Rust process. This complements the JS-side measurements
from M1/M2/M3/E3 by attributing **backend** time to specific Rust functions —
SQLite query parsing, serde JSON serialization, axum routing, etc.

## Why this is now low priority (per Phase 1 findings)

The Phase 1 Chrome DevTools trace (M2) showed that the 250-300 ms long
frames during a workspace switch are dominated by:

- React reconciliation (~150 ms JS)
- forced layout (~125 ms, from `MeasuredConversationRow.reportHeight`)
- style recalc (~120 ms, on 930 elements)

The Rust dev_server's contribution is **bounded by the network fetch round trip
time**, which happens *before* the React render starts and is therefore
**not visible inside any long frame**. Even if the SQLite query takes 50 ms,
the user-visible cost is the long frame, not the fetch.

So flamegraph data here is **confirmation only**, not the basis of any Phase 2
decision. Run it if you want a complete picture; skip it if you're prioritizing
Phase 2 implementation.

## Prerequisites

- macOS DTrace (built-in, but requires `sudo` for sampling)
- `cargo` and `rustc` already in PATH
- `cargo flamegraph` itself: `brew install cargo-flamegraph` or
  `cargo install flamegraph`

## Build with debug symbols

`flamegraph` needs symbol info even in `--release`. Add to
`src-tauri/Cargo.toml` (only locally; do NOT commit unless the team agrees):

```toml
[profile.release]
debug = true        # keep symbol info in release builds
```

(Or use `cargo build --release --bin helmor-dev-server` after setting
`CARGO_PROFILE_RELEASE_DEBUG=true` in the environment.)

## Run

```bash
# Stop any existing dev server first
pkill -f helmor-dev-server || true

cd src-tauri

# Build with debug-info release
CARGO_PROFILE_RELEASE_DEBUG=true \
  cargo build --release --features dev-server --bin helmor-dev-server

# Sample for ~30 seconds while you trigger workspace switches in another terminal
sudo cargo flamegraph \
  --bin helmor-dev-server \
  --features dev-server \
  -o ../docs/perf/flamegraph-dev-server.svg \
  -- --duration 30

# Or, if you already have the binary running, attach by PID:
sudo cargo flamegraph -p $(pgrep -f helmor-dev-server) \
  -o ../docs/perf/flamegraph-dev-server.svg
```

While flamegraph is sampling, in another terminal trigger traffic:

```bash
# Find a workspace id from your local DB and request its sessions /
# messages a few times
for i in 1 2 3 4 5 6 7 8 9 10; do
  curl -s http://localhost:3001/api/list_workspace_sessions?workspaceId=<id>
  curl -s http://localhost:3001/api/get_session_thread_messages?sessionId=<id>
  sleep 0.5
done
```

## What to look for in the SVG

- **`rusqlite::Statement::query`** — the actual SQLite work. If this
  dominates, the fix is index changes or LIMIT-based pagination (A1' on the
  backend side).
- **`serde_json::Serializer::serialize`** — JSON serialization cost. If this
  is large, the fix is reducing payload size (also A1' but on the wire).
- **`axum::response`** / **`hyper::server`** — should be tiny. If they're
  large, there's an HTTP framework misconfiguration.

## How to read the result for Phase 2

If the top-3 functions are all `rusqlite` + `serde_json` + `read`, the Rust
backend is doing what you'd expect and the fix on the Rust side is **smaller
payloads / pagination**, not Rust optimization.

If anything else dominates (e.g., `chrono`, `rand`, `sha2`), there's a hot
spot worth fixing in Rust directly.

## Why I didn't run this automatically

`sudo cargo flamegraph` requires elevated privileges that I cannot grant
myself. The user must run it manually. Once the SVG is in
`docs/perf/flamegraph-dev-server.svg`, write a 1-paragraph summary at the top
of `phase1-bottleneck-report.md` under "E1 result".
