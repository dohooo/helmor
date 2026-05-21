# Remote Server Protocol Reference

Wire shape of Helmor's daemon ↔ desktop protocol. All transport runs
over a single Unix socket (`$HOME/.helmor/server/sock`) tunneled
through SSH. JSON-RPC 2.0 framing, one message per newline-delimited
line.

For the why + lifecycle see
[`remote-server-architecture.md`](./remote-server-architecture.md).

## Versioning

- Current protocol version: see
  [`src-tauri/src/remote/protocol.rs`](../src-tauri/src/remote/protocol.rs)
  `PROTOCOL_VERSION` constant.
- Semver — but bumped on **envelope** changes, not on every method
  addition. Methods are forward-compatible via the catalog described
  below; unknown methods return a `MethodNotFound` error
  (JSON-RPC `-32601`).
- Bump policy:
  - Patch: bug fix to an existing method's wire shape (rare;
    usually requires both sides to update).
  - Minor: new method added. Existing clients continue to work
    because they only call methods they know.
  - Major: incompatible envelope change. Clients refuse to connect to
    a server with a different major.
- Daemon and desktop **both** carry a compile-time `PROTOCOL_VERSION`.
  The install path
  ([`src-tauri/src/remote/install.rs`](../src-tauri/src/remote/install.rs))
  triggers a re-install when the deployed daemon's protocol doesn't
  match the desktop's expected version.

## Envelope

Standard JSON-RPC 2.0 with two custom rules:

- All payloads use `camelCase` field names (Rust types are
  `#[serde(rename_all = "camelCase")]`).
- Notifications (no `id`) are emitted by the **server** only.
  Today's only notification is `agent.event` (see below).

Request:
```json
{ "jsonrpc": "2.0", "id": 7, "method": "ping", "params": {} }
```

Response (success):
```json
{ "jsonrpc": "2.0", "id": 7, "result": {} }
```

Response (error):
```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "error": { "code": -32601, "message": "method not found" }
}
```

Notification:
```json
{
  "jsonrpc": "2.0",
  "method": "agent.event",
  "params": { "requestId": "...", "event": { ... }, "seq": 42 }
}
```

## Handshake

The first message a desktop sends after binding the socket:

### `initialize`

Negotiate protocol compatibility. Must be the first method called.

**Params**:
```json
{
  "protocolVersion": "0.1.0",
  "clientName": "helmor-desktop",
  "clientVersion": "0.22.1"
}
```

**Result**:
```json
{
  "protocolVersion": "0.1.0",
  "capabilities": { ... }
}
```

The server rejects with `IncompatibleVersion` if the major doesn't
match.

## Health + diagnostics

### `ping`

Liveness probe. Empty params, empty result. The desktop's liveness
loop fires this every 200ms.

### `runtime_health`

Returns `{ kind, hostname, version }` describing the host the daemon
runs on. Surfaced in the runtime diagnostics panel.

## Workspace methods

| Method | Purpose |
| --- | --- |
| `workspace.status` | `is_clean: bool` + changed paths (mirror of `git status`). |
| `workspace.branchInfo` | Current branch, HEAD commit, upstream ref. |
| `workspace.fileTree` | List of tracked + untracked files. |
| `workspace.changes` | Per-file diff summary (insertions / deletions / status). |
| `workspace.readFile` | Read a file's contents at HEAD. |
| `workspace.readFileAtRef` | Read at an arbitrary git ref. |
| `workspace.statFile` | mtime / size / exists. |
| `workspace.mutateFile` | Write / delete / rename. Atomic per call. |
| `workspace.search` | Codebase search (ripgrep-style under the hood). |
| `workspace.startWatch` | Subscribe to per-file change notifications. |
| `workspace.stopWatch` | Unsubscribe. |

Full param + result shapes live in
[`src-tauri/src/remote/methods.rs`](../src-tauri/src/remote/methods.rs).

## Terminal methods

| Method | Purpose |
| --- | --- |
| `terminal.open` | Spawn a PTY on the remote, return `terminal_id`. |
| `terminal.write` | Write stdin bytes. |
| `terminal.resize` | Send a SIGWINCH for `cols/rows`. |
| `terminal.close` | SIGHUP + clean up the entry. |
| `terminal.list` | Enumerate running terminals (state, scrollback length). |
| `terminal.attach` | Swap the notifier so events flow to a fresh client. |

Terminal output flows back as a `terminal.event` notification keyed
by `terminal_id`. A 256 KiB scrollback ring lets fresh clients see
recent output on attach.

## Agent methods

The core of the remote-runner feature.

### `agent.send`

Forward a `SidecarRequest` (build it from the desktop's
`agents/streaming` layer) to the on-remote sidecar.

**Params**:
```json
{
  "requestId": "uuid",
  "method": "sendMessage",
  "params": { ...the sidecar request body... }
}
```

**Result**: `{ "accepted": true }` — events flow back as
`agent.event` notifications.

### `agent.attach`

Swap the per-session notifier to this connection + replay the
journal.

**Params**:
```json
{
  "requestId": "uuid",
  "sinceSeq": 42
}
```

`sinceSeq` is optional. `None` means "give me whatever you have";
`Some(0)` is the explicit cold-attach form (full journal flush);
`Some(N)` means "events with seq > N".

**Result**:
```json
{
  "found": true,
  "lastSeq": 99,
  "replayedCount": 4,
  "replayGap": null
}
```

- `found: false` — the request id has no live session AND no
  on-disk journal. The client should drop the local subscription.
- `lastSeq` — head of the journal (in-memory or on-disk). Stash this
  for the next reattach.
- `replayedCount` — how many entries the daemon flushed through the
  notifier as part of attach.
- `replayGap: Some(seq)` — the journal's earliest surviving seq when
  the caller's `sinceSeq` predates eviction. The chat surfaces a
  "history unavailable" banner.

### `agent.list`

Enumerate sessions. Includes both live sessions and
`endedReplayOnly` sessions whose on-disk journal survives.

**Result**:
```json
{
  "sessions": [
    {
      "requestId": "uuid-1",
      "helmorSessionId": "hs-1",
      "provider": "claude",
      "workspaceDir": "/srv/repos/demo",
      "startedAtMs": 1700000000000,
      "lastEventMs": 1700000000500,
      "state": "live"
    },
    {
      "requestId": "uuid-2",
      "helmorSessionId": "hs-2",
      "provider": "claude",
      "workspaceDir": "/srv/repos/demo",
      "startedAtMs": 1699999000000,
      "lastEventMs": 1699999600000,
      "state": "endedReplayOnly"
    }
  ]
}
```

### `agent.abort`

Cancel an in-flight turn. The sidecar's `abort` request gets routed
to the matching `requestId`; the terminal event for that turn
arrives as a normal `agent.event` (typically `type: "error"` with
`code: "aborted"`).

### `agent.setAuth`

Push (or clear) an SDK API key. The daemon stores it at
`$HOME/.helmor/server/secrets.json` (mode 0600) and hot-pushes the
change to the live sidecar via an `updateConfig` request.

**Params**:
```json
{
  "provider": "cursor",
  "apiKey": "sk-...",
  "baseUrl": "https://proxy.internal/v1"
}
```

`apiKey: null` (or an all-whitespace string) clears the entry. The
daemon's hot-push to the sidecar carries `null` so the next request
reverts to the unauthenticated state.

### `agent.authStatus`

**Track G2.** Read side of `agent.setAuth`. Returns which providers
have a key configured on the daemon. The literal API key value is
**never** on the wire — only the presence bit and the optional
base URL the operator supplied alongside.

**Params**: `{}`

**Result**:
```json
{
  "providers": [
    {
      "provider": "cursor",
      "configured": true,
      "baseUrl": "https://proxy.internal/v1"
    }
  ]
}
```

`providers` is sorted alphabetically. An empty list means no key
has been configured (fresh daemon or the operator cleared every
key). Drives the "Currently configured" chip in the desktop's
runtime-auth dialog and the key-icon chip on the Remote Servers
settings panel.

### `daemon.tailLog`

**Track E1.** Read up to `maxLines` lines from
`$HOME/.helmor/server/daemon.log` so operators can debug without
opening a parallel SSH session.

**Params**:
```json
{ "maxLines": 200 }
```

**Result**:
```json
{
  "lines": ["...", "..."],
  "truncated": true
}
```

`truncated: true` when the log file had more lines than `maxLines`
allowed; older entries were dropped.

### `runtime.metrics`

**Track E2.** Snapshot the daemon's per-method RPC counters +
latency percentiles. Empty params.

**Result**:
```json
{
  "methods": [
    {
      "method": "agent.send",
      "totalCalls": 142,
      "errorCalls": 1,
      "p50Ms": 4.2,
      "p99Ms": 18.7
    }
  ]
}
```

The daemon keeps a 512-sample ring per method; percentiles are
nearest-rank over the ring.

### Notification: `agent.event`

Every event the sidecar emits flows back as one of these. Carried
with the original event payload + the daemon's monotonic seq.

```json
{
  "jsonrpc": "2.0",
  "method": "agent.event",
  "params": {
    "requestId": "uuid",
    "event": { "type": "assistant", "delta": "..." },
    "seq": 42
  }
}
```

`seq` is per-session, never resets, drives the desktop's
`since_seq` cursor on reattach.

## Errors

Reserved JSON-RPC error codes:

| Code | Name | Meaning |
| --- | --- | --- |
| `-32600` | `InvalidRequest` | Malformed envelope. |
| `-32601` | `MethodNotFound` | Unknown method name. |
| `-32602` | `InvalidParams` | Method exists but params don't match. |
| `-32603` | `InternalError` | Generic daemon error. |
| `-32000` | `IncompatibleVersion` | `initialize` rejected a protocol mismatch. |

Method-specific errors fold into `InternalError` with a structured
message; the desktop surfaces the message verbatim.

## Backwards compatibility commitments

- The server never removes a method without a major bump.
- The server never renames a result / param field. Added fields
  default-deserialize for older clients (e.g. `agent.list`'s
  `state` field added in 24t is optional from the wire side).
- Notifications are additive: a client subscribed to old
  notifications continues to receive them on a newer server.

## Source of truth

The Rust types in
[`src-tauri/src/remote/methods.rs`](../src-tauri/src/remote/methods.rs)
are authoritative. The fixture wire snapshots in
[`src-tauri/src/remote/methods.rs::tests`](../src-tauri/src/remote/methods.rs)
lock the wire shape against regressions; modify both when bumping
the protocol.
