//! JSON-RPC 2.0 framing for the headless `helmor-server` daemon.
//!
//! Newline-delimited JSON. One message per line. The binary reads
//! requests from stdin, writes responses to stdout. The client
//! (today: a future SSH-tunneled desktop call; F2+) plays the
//! mirror image: write a request, read a response.
//!
//! We deliberately don't pull in `jsonrpc-core` or a similar crate.
//! The wire shape we need is small (request / response / error
//! envelope) + keeping the types in-crate makes them easy to evolve
//! alongside the method catalogue in [`super::server`].

use std::io::{BufRead, Write};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Wire-level version of the Helmor remote protocol. The client sends
/// it in the `initialize` handshake and the server rejects with
/// [`error_codes::INCOMPATIBLE_PROTOCOL`] if the major doesn't match.
/// Bumped on **envelope** changes (rare); method additions are
/// forward-compatible via the catalogue + `MethodNotFound` errors.
///
/// `0.x` while the surface is still evolving. Promote to `1.0` once
/// the wire shape is frozen for downstream consumers.
pub const PROTOCOL_VERSION: &str = "0.1.0";

/// Reserved JSON-RPC error codes. The 32000+ range is "implementation
/// defined" per the spec; we use it for protocol-level state errors
/// the spec doesn't enumerate.
pub mod error_codes {
    pub const INVALID_REQUEST: i32 = -32600;
    pub const METHOD_NOT_FOUND: i32 = -32601;
    pub const INVALID_PARAMS: i32 = -32602;
    pub const INTERNAL_ERROR: i32 = -32603;
    /// `initialize` rejected because the client's protocol major
    /// doesn't match the server's. Custom (implementation-defined).
    pub const INCOMPATIBLE_PROTOCOL: i32 = -32000;
    /// A non-`initialize` method was called before the handshake.
    pub const NOT_INITIALIZED: i32 = -32001;
    /// Handler returned `Err` for a reason the spec doesn't cover
    /// (e.g. an underlying `git` invocation failed). Caller gets the
    /// underlying message inside `error.message`.
    pub const HANDLER_FAILED: i32 = -32002;
}

/// JSON-RPC 2.0 `id` field. Numbers + strings both legal per spec;
/// `Null` covers notifications. Untagged so the serialization matches
/// `1`, `"abc"`, `null` literally.
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum JsonRpcId {
    Num(u64),
    Str(String),
    #[default]
    Null,
}

impl JsonRpcId {
    pub fn is_notification(&self) -> bool {
        matches!(self, Self::Null)
    }
}

/// JSON-RPC 2.0 request envelope. `params` is `None` when the caller
/// omitted the field; defaults to an empty object on the wire so
/// handlers can decode an empty params struct.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    #[serde(default)]
    pub id: JsonRpcId,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

impl JsonRpcRequest {
    pub fn new(id: JsonRpcId, method: impl Into<String>, params: Value) -> Self {
        Self {
            jsonrpc: "2.0".into(),
            id,
            method: method.into(),
            params,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    pub id: JsonRpcId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<JsonRpcError>,
}

impl JsonRpcResponse {
    pub fn success(id: JsonRpcId, result: Value) -> Self {
        Self {
            jsonrpc: "2.0".into(),
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn failure(id: JsonRpcId, error: JsonRpcError) -> Self {
        Self {
            jsonrpc: "2.0".into(),
            id,
            result: None,
            error: Some(error),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcError {
    pub code: i32,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl JsonRpcError {
    pub fn new(code: i32, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }
}

/// Marker for either side of the wire (request or response). Used by
/// the framing helpers below so a peer-aware reader can call one
/// function regardless of which direction it's reading.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum JsonRpcMessage {
    Request(JsonRpcRequest),
    Response(JsonRpcResponse),
}

/// Read one newline-delimited JSON frame off `reader`.
///
/// `T` must deserialize as a JSON-RPC envelope (request or response).
/// An empty / closed stream returns [`FrameError::Eof`]; malformed
/// frames return [`FrameError::Parse`] (the caller decides whether
/// to log + recover or tear the connection down).
pub fn read_frame<R: BufRead, T: serde::de::DeserializeOwned>(
    reader: &mut R,
) -> Result<T, FrameError> {
    let mut line = String::new();
    let n = reader.read_line(&mut line).map_err(FrameError::Io)?;
    if n == 0 {
        return Err(FrameError::Eof);
    }
    let trimmed = line.trim();
    if trimmed.is_empty() {
        // Some clients double-flush; treat a blank line as a no-op
        // and recurse for the next frame.
        return read_frame::<R, T>(reader);
    }
    serde_json::from_str(trimmed).map_err(FrameError::Parse)
}

/// Write `value` as a newline-delimited JSON frame.
///
/// One `write_all` for the body + one `write_all` for the newline +
/// a `flush` so the receiver sees it without buffering delay.
pub fn write_frame<W: Write, T: Serialize>(writer: &mut W, value: &T) -> Result<(), FrameError> {
    let serialized = serde_json::to_string(value).map_err(FrameError::Parse)?;
    writer
        .write_all(serialized.as_bytes())
        .map_err(FrameError::Io)?;
    writer.write_all(b"\n").map_err(FrameError::Io)?;
    writer.flush().map_err(FrameError::Io)?;
    Ok(())
}

#[derive(Debug)]
pub enum FrameError {
    /// Peer closed the connection. Normal at end-of-session; the
    /// caller exits its loop cleanly.
    Eof,
    /// `serde_json` failed to round-trip the line. The caller usually
    /// logs + reads the next frame, because dropping the connection
    /// on a single bad payload is too aggressive.
    Parse(serde_json::Error),
    /// Underlying `io::Read` / `io::Write` failure. Caller exits the
    /// loop — the channel is gone.
    Io(std::io::Error),
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Eof => write!(f, "peer closed the connection"),
            Self::Parse(err) => write!(f, "frame parse error: {err}"),
            Self::Io(err) => write!(f, "frame io error: {err}"),
        }
    }
}

impl std::error::Error for FrameError {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn round_trips_a_request_envelope() {
        let req = JsonRpcRequest::new(
            JsonRpcId::Num(7),
            "ping",
            serde_json::json!({ "counter": 1 }),
        );
        let mut buf = Vec::new();
        write_frame(&mut buf, &req).unwrap();
        let mut reader = Cursor::new(buf);
        let decoded: JsonRpcRequest = read_frame(&mut reader).unwrap();
        assert_eq!(decoded.jsonrpc, "2.0");
        assert_eq!(decoded.method, "ping");
        assert!(matches!(decoded.id, JsonRpcId::Num(7)));
        assert_eq!(decoded.params["counter"], 1);
    }

    #[test]
    fn round_trips_a_response_success_envelope() {
        let resp = JsonRpcResponse::success(JsonRpcId::Num(7), serde_json::json!({ "ok": true }));
        let mut buf = Vec::new();
        write_frame(&mut buf, &resp).unwrap();
        let mut reader = Cursor::new(buf);
        let decoded: JsonRpcResponse = read_frame(&mut reader).unwrap();
        assert!(decoded.result.is_some());
        assert!(decoded.error.is_none());
    }

    #[test]
    fn round_trips_a_response_error_envelope() {
        let resp = JsonRpcResponse::failure(
            JsonRpcId::Num(7),
            JsonRpcError::new(error_codes::METHOD_NOT_FOUND, "unknown method: foo"),
        );
        let mut buf = Vec::new();
        write_frame(&mut buf, &resp).unwrap();
        let mut reader = Cursor::new(buf);
        let decoded: JsonRpcResponse = read_frame(&mut reader).unwrap();
        assert!(decoded.result.is_none());
        let err = decoded.error.expect("error envelope must round-trip");
        assert_eq!(err.code, error_codes::METHOD_NOT_FOUND);
    }

    #[test]
    fn eof_returns_eof_variant_not_a_parse_error() {
        let mut reader = Cursor::new(Vec::new());
        match read_frame::<_, JsonRpcRequest>(&mut reader) {
            Err(FrameError::Eof) => {}
            other => panic!("expected Eof, got {other:?}"),
        }
    }

    #[test]
    fn blank_lines_are_skipped() {
        let mut buf = Vec::new();
        buf.extend_from_slice(b"\n\n");
        let req = JsonRpcRequest::new(JsonRpcId::Num(1), "ping", serde_json::json!({}));
        write_frame(&mut buf, &req).unwrap();
        let mut reader = Cursor::new(buf);
        let decoded: JsonRpcRequest = read_frame(&mut reader).unwrap();
        assert_eq!(decoded.method, "ping");
    }

    #[test]
    fn parse_failure_surfaces_via_parse_variant() {
        let mut reader = Cursor::new(b"not json\n".to_vec());
        match read_frame::<_, JsonRpcRequest>(&mut reader) {
            Err(FrameError::Parse(_)) => {}
            other => panic!("expected Parse, got {other:?}"),
        }
    }

    #[test]
    fn id_serialises_as_number_string_or_null() {
        assert_eq!(serde_json::to_string(&JsonRpcId::Num(42)).unwrap(), "42");
        assert_eq!(
            serde_json::to_string(&JsonRpcId::Str("abc".into())).unwrap(),
            "\"abc\""
        );
        assert_eq!(serde_json::to_string(&JsonRpcId::Null).unwrap(), "null");
    }

    #[test]
    fn null_id_marks_a_notification() {
        assert!(JsonRpcId::Null.is_notification());
        assert!(!JsonRpcId::Num(1).is_notification());
        assert!(!JsonRpcId::Str("abc".into()).is_notification());
    }
}
