# Remote Server (F1)

Foundation for Helmor's remote-workspace feature — issue
[#453](https://github.com/dohooo/helmor/issues/453). This doc covers
the F1 slice: the `helmor-server` binary, the JSON-RPC framing it
speaks, the handshake gate, and two read-only methods (`ping`,
`runtime.health`).

F2-F7 layer on top:

- **F2** — SSH transport + daemon spawn over an existing SSH session.
- **F3** — Agent attach + chat reattach + local persistence.
- **F4** — Port forwarding (independent of F3/F5).
- **F5** — Auto-reconnect + connection state machine.
- **F6** — Daemon event journal + replay-from-seq + history rebuild.
- **F7** — Journal durability across daemon restarts.

Each lands as its own reviewable PR; this one freezes the wire
shape every later slice builds on.

## Binary modes

The `helmor-server` binary is a single Rust target with two CLI
modes, picked by the first flag:

- `--version` / `-V` — print version + protocol, exit 0. Used by
  the auto-install probe a later PR will add.
- `--serve-stdio` (default) — read framed JSON-RPC requests from
  stdin, write responses to stdout. Suitable for a local desktop
  spawning the binary directly (the local-loopback path that
  drives the protocol's integration tests).

A future PR adds `--daemon` (long-lived, Unix-socket-backed) +
`--ensure-daemon` (idempotent "is the daemon running?" probe).

## Wire shape

JSON-RPC 2.0 over newline-delimited stdin/stdout. One message per
line. Two envelope shapes:

```json
// Request
{ "jsonrpc": "2.0", "id": 7, "method": "ping", "params": { "counter": 1 } }

// Response (success)
{ "jsonrpc": "2.0", "id": 7, "result": { "counter": 1, "serverTime": "2026-05-20T12:00:00.000Z" } }

// Response (error)
{ "jsonrpc": "2.0", "id": 7, "error": { "code": -32601, "message": "unknown method: foo.bar" } }
```

`id` is either a number, a string, or `null` (notification — no
response). All field names use `camelCase`; Rust types are
`#[serde(rename_all = "camelCase")]`.

### Reserved error codes

| Code | Name | Meaning |
| --- | --- | --- |
| `-32600` | `InvalidRequest` | Malformed envelope. |
| `-32601` | `MethodNotFound` | Unknown method name. |
| `-32602` | `InvalidParams` | Method exists but params don't match. |
| `-32603` | `InternalError` | Server-side serialization failure. |
| `-32000` | `IncompatibleProtocol` | `initialize` rejected a major mismatch. |
| `-32001` | `NotInitialized` | Method called before the handshake. |
| `-32002` | `HandlerFailed` | Handler returned an underlying error. |

## Protocol versioning

- Current version: `0.1.0` (see
  [`src-tauri/src/remote/protocol.rs`](../src-tauri/src/remote/protocol.rs)
  `PROTOCOL_VERSION`).
- Semver — bumped on **envelope** shape changes, not on method
  additions (those are forward-compatible via `MethodNotFound`).
- `0.x` is treated as pre-stable: two peers must match on
  `<major>.<minor>` (so `0.1.x` ↔ `0.1.y` is fine, `0.1.x` ↔
  `0.2.x` is not). Once `1.0` ships the standard "majors match"
  semantics apply.
- The desktop client passes its expected `protocolVersion` in the
  `initialize` params; the server returns
  [`IncompatibleProtocol`](#reserved-error-codes) when the major
  doesn't match.

## Methods (F1)

### `initialize`

Mandatory first method. Must be called before any other method.

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
  "serverVersion": "0.0.0",
  "hostname": "dev.box"
}
```

### `ping`

Liveness probe. Used by the desktop's future heartbeat loop.

**Params**: `{ "counter": <u64> }` (defaults to 0).

**Result**: `{ "counter": <echo>, "serverTime": "<rfc3339>" }`.

### `runtime.health`

Identify the host. Used by the desktop's diagnostics panel.

**Params**: `{}` (empty).

**Result**:
```json
{
  "kind": "local",
  "hostname": "dev.box",
  "serverVersion": "0.0.0"
}
```

`kind` is `"local"` for the daemon binary running on the remote
host. A later phase may expose `"remote"` when a daemon proxies to
another daemon, etc.

## Out of scope

F1 deliberately omits:

- **SSH transport** — the binary speaks stdin/stdout. F2 adds the
  SSH-tunneled socket.
- **Auth** — no credential handling. SSH key resolution flows
  through the user's existing `~/.ssh/config` once F2 lands.
- **Workspace ops, terminals, agents** — F3 / later.
- **Persistent state** — no daemon, no journal, no on-disk
  history. F6 / F7 introduce those.

## Trying it locally

```bash
cd src-tauri
cargo build --bin helmor-server
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"0.1.0","clientName":"test"}}' \
  | target/debug/helmor-server --serve-stdio
```

Expected output:

```json
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"0.1.0","serverVersion":"0.0.0","hostname":"unknown-host"}}
```

Set `HOSTNAME=foo` to pin the hostname; set `HELMOR_LOG=debug` to
see the binary's tracing output on stderr.
