# E2 — samply main-thread sampling (instructions)

## What this profiles

`samply` is a sampling profiler that produces a [Firefox Profiler](https://profiler.firefox.com)-compatible JSON. It can sample either a fresh process or attach to a running PID. On macOS it does NOT need `sudo` (unlike DTrace-based flamegraph), which makes it the preferred Rust profiler for this project.

## Why this is now low priority (per Phase 1 findings)

Same reason as E1 (see `e1-flamegraph-instructions.md`). The Phase 1 trace
already pinned the bottleneck to the **JS / CSS layer** — `MeasuredConversationRow.reportHeight` and a 930-element style recalc — so any
Rust profiler is now confirmation rather than discovery. Run if you want a
complete picture.

## Install

Tried via `brew install samply` (preferred — no Rust toolchain needed).
Alternative: `cargo install --locked samply`. Either takes a few minutes.

```bash
brew install samply
# OR
cargo install --locked samply
```

## Run — sample dev_server while triggering traffic

```bash
# Stop existing dev server
pkill -f helmor-dev-server || true

# Start dev server WITHOUT samply first
cd src-tauri
cargo build --release --features dev-server --bin helmor-dev-server
./target/release/helmor-dev-server &
DEV_PID=$!

# In a SECOND terminal, attach samply
samply record -p $DEV_PID -o ../docs/perf/samply-dev-server.json

# In a THIRD terminal, fire some realistic traffic
# (use a real workspace id from your local DB)
WS_ID="<a real archived workspace id with many messages>"
SESS_ID="<one of its session ids>"

for i in 1 2 3 4 5 6 7 8 9 10; do
  curl -s "http://localhost:3001/api/list_workspace_sessions?workspaceId=$WS_ID" > /dev/null
  curl -s "http://localhost:3001/api/get_session_thread_messages?sessionId=$SESS_ID" > /dev/null
  sleep 0.3
done

# After ~10 seconds of traffic, Ctrl+C the samply terminal.
# samply will print a profiler.firefox.com URL — open it.

kill $DEV_PID
```

## Run — sample the Tauri main process during a workspace switch

(Optional, more involved — only useful if you suspect WKWebView main-thread
contention.)

```bash
# Find the Tauri process
pgrep -f "Helmor"
# samply attach
samply record -p <tauri-pid> -o ../docs/perf/samply-tauri-main.json
```

Then click around in the Helmor app for a few seconds and Ctrl+C samply.

## What to look for

Open the JSON in https://profiler.firefox.com — drag and drop, no upload.

- **Self time** column shows the leaf functions where samples actually landed.
- **Inverted call tree** view reveals which leaves are reached by the most
  call paths.
- For dev_server: expect `rusqlite::Statement::raw_step`, `serde::ser` and
  `tokio::runtime::scheduler` to dominate. If they don't, that's worth
  knowing.

## How to read for Phase 2

If `rusqlite::query` dominates: tag as A1'-backend (pagination via SQL LIMIT).
If `serde_json::ser` dominates: tag as smaller-payload (return only the
fields the JS actually consumes).
If neither dominates and the dev_server is tiny in the profile: confirms the
bottleneck is fully on the JS side, and Phase 2 can ignore Rust.

## Why I didn't run this automatically

The `brew install samply` was launched in the background of this Phase 1 run
but did not finish in time (homebrew was busy with auto-update + downloads).
Once samply is installed, the commands above are copy-pastable. The output
will plug directly into the Phase 1 bottleneck report under an "E2 result"
section if anything surprising shows up.
