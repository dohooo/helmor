//! JSON-RPC 2.0 message types + the Helmor-side protocol-version
//! handshake that gates every connection.
//!
//! We deliberately don't pull in a crate like `jsonrpc-core`. The wire
//! surface we need is small (request / response / error envelope)
//! and keeping the types in-crate makes them easy to evolve alongside
//! the method catalogue in [`super::methods`].

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Wire-level version of the Helmor remote protocol. The client sends
/// it in the `initialize` handshake and the server rejects with
/// `IncompatibleVersion` if the major doesn't match. Bumped any time
/// the *envelope* shape changes (not every time a method is added —
/// methods are forward-compatible via the catalogue in
/// [`super::methods`]).
///
/// `0.x` while the protocol is unstable. Increment to `1.0` when we
/// freeze the shape for the first PR upstream.
pub const PROTOCOL_VERSION: &str = "0.1.0";

/// JSON-RPC 2.0 `id` field. Numbers and strings both legal per spec;
/// `Null` covers notifications (no id at all). Untagged so the
/// serialization matches `1`, `"abc"`, `null` literally.
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum JsonRpcId {
    Num(u64),
    Str(String),
    #[default]
    Null,
}

impl JsonRpcId {
    /// Did the originator omit `id`? (Notifications can't be responded
    /// to; the server uses this to skip the response write entirely.)
    pub fn is_notification(&self) -> bool {
        matches!(self, Self::Null)
    }
}

/// JSON-RPC 2.0 request envelope. We always set `jsonrpc: "2.0"` on
/// outbound messages; inbound messages are validated by `read_frame`'s
/// deserializer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    pub method: String,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub params: Value,
    #[serde(default, skip_serializing_if = "JsonRpcId::is_notification")]
    pub id: JsonRpcId,
}

impl JsonRpcRequest {
    pub fn new(method: impl Into<String>, params: Value, id: JsonRpcId) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            method: method.into(),
            params,
            id,
        }
    }
}

/// Either-or response. Per JSON-RPC, exactly one of `result` or
/// `error` is populated.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<JsonRpcError>,
    pub id: JsonRpcId,
}

impl JsonRpcResponse {
    pub fn success(id: JsonRpcId, result: Value) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            result: Some(result),
            error: None,
            id,
        }
    }

    pub fn failure(id: JsonRpcId, error: JsonRpcError) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            result: None,
            error: Some(error),
            id,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct JsonRpcError {
    pub code: i32,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
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

/// JSON-RPC 2.0 reserved error codes plus Helmor-specific extensions
/// in the implementation-defined range (-32000 to -32099).
#[allow(dead_code)]
pub mod error_codes {
    pub const PARSE_ERROR: i32 = -32700;
    pub const INVALID_REQUEST: i32 = -32600;
    pub const METHOD_NOT_FOUND: i32 = -32601;
    pub const INVALID_PARAMS: i32 = -32602;
    pub const INTERNAL_ERROR: i32 = -32603;

    // Helmor-specific:
    pub const INCOMPATIBLE_PROTOCOL: i32 = -32000;
    pub const NOT_INITIALIZED: i32 = -32001;
    pub const HANDLER_FAILED: i32 = -32002;
}

/// Either request or response — useful when a single decode site
/// needs to handle both directions (the SSH client side reads
/// responses + server-initiated notifications interleaved on one
/// pipe).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum JsonRpcMessage {
    Request(JsonRpcRequest),
    Response(JsonRpcResponse),
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn request_round_trips_through_serde() {
        let req = JsonRpcRequest::new("initialize", json!({"version": "0.1.0"}), JsonRpcId::Num(1));
        let wire = serde_json::to_string(&req).unwrap();
        let decoded: JsonRpcRequest = serde_json::from_str(&wire).unwrap();
        assert_eq!(decoded.method, "initialize");
        assert_eq!(decoded.id, JsonRpcId::Num(1));
        assert_eq!(decoded.params["version"], "0.1.0");
    }

    #[test]
    fn notification_omits_id_on_the_wire() {
        let req = JsonRpcRequest::new("logEvent", json!({"line": "hi"}), JsonRpcId::Null);
        let wire = serde_json::to_string(&req).unwrap();
        // Per JSON-RPC: notifications have no `id` at all, not `id: null`.
        // The `skip_serializing_if` attribute enforces that.
        assert!(!wire.contains("\"id\""), "notification leaked id: {wire}");
    }

    #[test]
    fn response_success_and_failure_are_mutually_exclusive_on_the_wire() {
        let ok = JsonRpcResponse::success(JsonRpcId::Num(1), json!({"ok": true}));
        let ok_wire = serde_json::to_string(&ok).unwrap();
        assert!(ok_wire.contains("\"result\""));
        assert!(!ok_wire.contains("\"error\""));

        let err = JsonRpcResponse::failure(
            JsonRpcId::Num(2),
            JsonRpcError::new(error_codes::METHOD_NOT_FOUND, "no such method"),
        );
        let err_wire = serde_json::to_string(&err).unwrap();
        assert!(err_wire.contains("\"error\""));
        assert!(!err_wire.contains("\"result\""));
    }

    #[test]
    fn id_supports_both_numbers_and_strings() {
        // JSON-RPC clients pick either; Helmor's client side uses
        // numbers, but the server must accept either to be a polite
        // peer if Helmor ever embeds inside another tool.
        let num: JsonRpcId = serde_json::from_str("42").unwrap();
        assert_eq!(num, JsonRpcId::Num(42));
        let s: JsonRpcId = serde_json::from_str("\"abc\"").unwrap();
        assert_eq!(s, JsonRpcId::Str("abc".into()));
    }

    #[test]
    fn message_enum_can_decode_either_direction() {
        let req_wire = r#"{"jsonrpc":"2.0","method":"ping","id":1}"#;
        let resp_wire = r#"{"jsonrpc":"2.0","result":{"ok":true},"id":1}"#;
        match serde_json::from_str::<JsonRpcMessage>(req_wire).unwrap() {
            JsonRpcMessage::Request(r) => assert_eq!(r.method, "ping"),
            JsonRpcMessage::Response(_) => panic!("expected request"),
        }
        match serde_json::from_str::<JsonRpcMessage>(resp_wire).unwrap() {
            JsonRpcMessage::Response(r) => assert!(r.result.is_some()),
            JsonRpcMessage::Request(_) => panic!("expected response"),
        }
    }
}
